import * as vscode from 'vscode';
import { LSClient, TrajectorySummary, TrajectoryStep } from './lsClient';

/**
 * Trajectory Monitor — 대화 상태를 폴링하여 새 메시지/응답/권한요청 감지
 *
 * 역할:
 * 1. Language Server에서 주기적으로 대화 요약을 조회
 * 2. 새 step이 추가되면 내용을 분석하여 이벤트 발생
 * 3. 에이전트 응답 (notify_user) → agent_response 이벤트
 * 4. GUI 사용자 입력 → gui_message 이벤트
 * 5. WAITING 상태 스텝 감지 → step_request 이벤트
 * 6. HandleCascadeUserInteraction API로 스텝 수락/거부
 *
 * 에코 방지: Telegram에서 보낸 메시지가 다시 gui_message로 돌아오지 않도록
 * markTelegramSent()로 보낸 텍스트를 기록
 */

/** 폴링 주기 (ms) */
const POLL_INTERVAL_MS = 5000;
/** 자동승인 시스템 메시지 패턴 */
const AUTO_APPROVE_PATTERN = /system-generated message/i;
/** LS 재발견 간격 (ms) — 실패 시 30초 후 재시도 */
const REDISCOVER_INTERVAL_MS = 30000;

/** WAITING 상태 확인 — status 필드가 문자열/숫자 모두 가능 */
function isWaitingStatus(status: any): boolean {
  return status === 'CORTEX_STEP_STATUS_WAITING'
    || status === '9'
    || status === 9;
}

export interface TrajectoryEvent {
  type: 'agent_response' | 'gui_message' | 'step_request';
  content: string;
  timestamp: number;
}

type TrajectoryEventListener = (event: TrajectoryEvent) => void;

export class TrajectoryMonitor {
  private lsClient: LSClient;
  private output: vscode.OutputChannel;
  private listeners: TrajectoryEventListener[] = [];
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  /** 현재 추적 중인 cascade */
  private activeCascadeId = '';
  private activeTrajectoryId = '';
  private lastStepCount = 0;
  private lastStatus = '';

  /** WAITING 스텝 알림 추적 (이미 알림 보낸 스텝 인덱스) */
  private notifiedWaitingSteps = new Set<number>();

  /** 에코 방지: Telegram에서 보낸 마지막 텍스트들 (최근 5개) */
  private sentTexts: string[] = [];
  private readonly MAX_SENT_TEXTS = 5;

  /** LS 발견 실패 시 마지막 시도 시간 */
  private lastDiscoverAttempt = 0;

  /** 현재 워크스페이스 URI (매칭용) */
  private workspaceUri = '';

  constructor(lsClient: LSClient, output: vscode.OutputChannel) {
    this.lsClient = lsClient;
    this.output = output;

    // 현재 워크스페이스 URI 계산
    const folders = vscode.workspace.workspaceFolders;
    if (folders?.length) {
      this.workspaceUri = folders[0].uri.toString();
    }
  }

  // ─── Event System ───

  onEvent(listener: TrajectoryEventListener): vscode.Disposable {
    this.listeners.push(listener);
    return new vscode.Disposable(() => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    });
  }

  private emit(event: TrajectoryEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        this.output.appendLine(`[TrajectoryMonitor] Listener error: ${e}`);
      }
    }
  }

  // ─── Polling Control ───

  startPolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.output.appendLine('[TrajectoryMonitor] Polling started');
    // 즉시 첫 폴링
    this.poll();
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.output.appendLine('[TrajectoryMonitor] Polling stopped');
  }

  // ─── Echo Prevention ───

  /** Telegram에서 보낸 텍스트 기록 (에코 방지) */
  markTelegramSent(text: string) {
    // 앞뒤 공백 제거 + 소문자로 정규화
    const normalized = text.trim().toLowerCase();
    this.sentTexts.push(normalized);
    if (this.sentTexts.length > this.MAX_SENT_TEXTS) {
      this.sentTexts.shift();
    }
  }

  private isTelegramSent(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    const idx = this.sentTexts.indexOf(normalized);
    if (idx >= 0) {
      // 매칭되면 제거 (1회성)
      this.sentTexts.splice(idx, 1);
      return true;
    }
    return false;
  }

  // ─── Accept / Reject ───

  /**
   * 현재 WAITING 상태인 스텝을 수락 또는 거부
   * Language Server의 HandleCascadeUserInteraction API 호출
   */
  async acceptWaitingStep(accept: boolean): Promise<boolean> {
    if (!this.activeCascadeId || !this.activeTrajectoryId) {
      this.output.appendLine('[TrajectoryMonitor] No active cascade for accept/reject');
      return false;
    }

    try {
      // 최근 20개 step을 가져와서 WAITING 찾기
      const summaries = await this.lsClient.getAllTrajectories();
      if (!summaries) return false;

      const summary = summaries[this.activeCascadeId];
      if (!summary) return false;

      const totalSteps = summary.stepCount;
      if (totalSteps === 0) return false;

      const offset = Math.max(0, totalSteps - 20);
      const steps = await this.lsClient.getTrajectorySteps(this.activeCascadeId, offset);

      // 뒤에서부터 WAITING 스텝 찾기
      for (let i = steps.length - 1; i >= 0; i--) {
        const step = steps[i];
        if (!isWaitingStatus(step.status)) continue;

        const absIdx = offset + i;
        const interaction = this.buildInteraction(step, absIdx, accept);

        if (!interaction) {
          this.output.appendLine(`[TrajectoryMonitor] Cannot build interaction for step type: ${step.type}`);
          continue;
        }

        this.output.appendLine(
          `[TrajectoryMonitor] Sending ${accept ? 'ACCEPT' : 'REJECT'} for step #${absIdx} (${step.type})`
        );

        const ok = await this.lsClient.handleUserInteraction(this.activeCascadeId, interaction);
        if (ok) {
          this.notifiedWaitingSteps.delete(absIdx);
          this.output.appendLine('[TrajectoryMonitor] Interaction sent successfully');
        } else {
          this.output.appendLine('[TrajectoryMonitor] Interaction failed');
        }
        return ok;
      }

      this.output.appendLine('[TrajectoryMonitor] No WAITING step found');
      return false;
    } catch (e: any) {
      this.output.appendLine(`[TrajectoryMonitor] acceptWaitingStep error: ${e.message}`);
      return false;
    }
  }

  /**
   * 스텝 유형에 따라 HandleCascadeUserInteraction 요청 본문 생성
   *
   * 각 스텝 유형별 interaction 매핑:
   * - runCommand → CascadeRunCommandInteraction (confirm + commandLine)
   * - openBrowserUrl → CascadeOpenBrowserUrlInteraction (confirm)
   * - mcp → CascadeMcpInteraction (confirm)
   * - filePermission → FilePermissionInteraction (allow)
   * - 기타 → confirm: true/false
   */
  private buildInteraction(
    step: TrajectoryStep,
    stepIndex: number,
    accept: boolean
  ): Record<string, any> | null {
    const base: Record<string, any> = {
      trajectoryId: this.activeTrajectoryId,
      stepIndex,
    };

    // 터미널 명령 실행
    if (step.runCommand) {
      const cmd = step.runCommand.commandLine ?? step.runCommand.command ?? '';
      base.runCommand = {
        confirm: accept,
        proposedCommandLine: cmd,
        submittedCommandLine: cmd,
      };
      return base;
    }

    // 브라우저 URL 열기
    if (step.openBrowserUrl) {
      base.openBrowserUrl = { confirm: accept };
      return base;
    }

    // 브라우저 JavaScript 실행
    if (step.executeBrowserJavascript) {
      base.executeBrowserJavascript = { confirm: accept };
      return base;
    }

    // 브라우저 스크린샷 캡처
    if (step.captureBrowserScreenshot) {
      base.captureBrowserScreenshot = { confirm: accept };
      return base;
    }

    // 브라우저 액션 (subagent)
    if (step.browserAction || step.browserSubagent) {
      base.browserAction = { confirm: accept };
      return base;
    }

    // MCP 도구 실행
    if (step.mcp) {
      base.mcp = { confirm: accept };
      return base;
    }

    // URL 콘텐츠 읽기
    if (step.readUrlContent) {
      base.readUrlContent = { confirm: accept };
      return base;
    }

    // 터미널 입력 전송
    if (step.sendCommandInput) {
      base.sendCommandInput = { confirm: accept };
      return base;
    }

    // 파일 접근 권한 (confirm 대신 allow 사용)
    if (step.filePermission) {
      base.filePermission = { allow: accept };
      return base;
    }

    // 확장 코드 실행
    if (step.runExtensionCode) {
      base.runExtensionCode = { confirm: accept };
      return base;
    }

    // 배포 (confirm 대신 cancel 사용 — 반대 의미)
    if (step.deploy) {
      base.deploy = { cancel: !accept };
      return base;
    }

    // 브라우저 설정
    if (step.openBrowserSetup) {
      base.openBrowserSetup = { confirm: accept };
      return base;
    }
    if (step.confirmBrowserSetup) {
      base.confirmBrowserSetup = { confirm: accept };
      return base;
    }

    // 알 수 없는 타입 — type 이름에서 추론 시도
    // CORTEX_STEP_TYPE_RUN_COMMAND → runCommand
    const typeMatch = step.type?.match(/CORTEX_STEP_TYPE_(\w+)/);
    if (typeMatch) {
      const camel = typeMatch[1].toLowerCase()
        .replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase());
      this.output.appendLine(`[TrajectoryMonitor] Guessing interaction type: ${camel}`);
      base[camel] = { confirm: accept };
      return base;
    }

    return null;
  }

  // ─── Polling Logic ───

  private async poll() {
    // LS 미발견 → 재발견 시도
    if (!this.lsClient.isDiscovered) {
      const now = Date.now();
      if (now - this.lastDiscoverAttempt < REDISCOVER_INTERVAL_MS) return;
      this.lastDiscoverAttempt = now;

      const ok = await this.lsClient.discover();
      if (!ok) return;

      this.output.appendLine('[TrajectoryMonitor] LS discovered, starting trajectory monitoring');
    }

    try {
      // 1. 모든 대화 요약 조회
      const summaries = await this.lsClient.getAllTrajectories();
      if (!summaries) return;

      // 2. 활성 cascade 찾기 (워크스페이스 매칭 → 최근 수정 순)
      const cascade = this.findActiveCascade(summaries);
      if (!cascade) return;

      const [cascadeId, summary] = cascade;

      // 3. cascade가 바뀌었으면 상태 리셋
      if (cascadeId !== this.activeCascadeId) {
        this.output.appendLine(`[TrajectoryMonitor] Active cascade changed: ${cascadeId.substring(0, 8)}...`);
        this.activeCascadeId = cascadeId;
        this.activeTrajectoryId = summary.trajectoryId;
        this.lastStepCount = summary.stepCount;
        this.lastStatus = summary.status;
        this.notifiedWaitingSteps.clear();
        return; // 첫 전환 시에는 기존 step들을 스킵
      }

      // trajectoryId 업데이트 (같은 cascade에서도 바뀔 수 있음)
      this.activeTrajectoryId = summary.trajectoryId;

      // 4. 상태 변화 감지
      const statusChanged = summary.status !== this.lastStatus;
      const hasNewSteps = summary.stepCount > this.lastStepCount;

      if (statusChanged) {
        this.output.appendLine(`[TrajectoryMonitor] Status: ${this.lastStatus} → ${summary.status}`);
      }
      this.lastStatus = summary.status;

      // 5. 새 step이 있으면 조회
      //    ⚠️ 추가 API 호출(detectWaitingSteps)은 LS GUI에 부하를 주므로 제거.
      //    새 step 처리 시에만 WAITING 체크. 기존 step의 상태 전환은 context key 폴링으로 감지.
      if (hasNewSteps) {
        const offset = this.lastStepCount;
        const steps = await this.lsClient.getTrajectorySteps(cascadeId, offset);
        this.lastStepCount = summary.stepCount;

        if (steps.length > 0) {
          this.processNewSteps(steps);

          // 새 step 중 WAITING 상태인 것 감지
          for (let i = 0; i < steps.length; i++) {
            const absIdx = offset + i;
            if (isWaitingStatus(steps[i].status) && !this.notifiedWaitingSteps.has(absIdx)) {
              this.notifiedWaitingSteps.add(absIdx);
              const desc = this.describeWaitingStep(steps[i]);
              this.output.appendLine(`[TrajectoryMonitor] WAITING step detected: #${absIdx} — ${desc}`);
              this.emit({
                type: 'step_request',
                content: desc,
                timestamp: Date.now(),
              });
            }
          }
        }
      }
    } catch (e: any) {
      this.output.appendLine(`[TrajectoryMonitor] Poll error: ${e.message}`);
    }
  }

  /**
   * WAITING 스텝을 사람이 읽을 수 있는 설명으로 변환
   */
  private describeWaitingStep(step: TrajectoryStep): string {
    if (step.runCommand) {
      const cmd = step.runCommand.commandLine ?? step.runCommand.command ?? 'unknown';
      return `터미널 명령 실행 요청: ${cmd}`;
    }
    if (step.openBrowserUrl) {
      const url = step.openBrowserUrl.url ?? '';
      return `브라우저 URL 열기 요청: ${url}`;
    }
    if (step.mcp) {
      const tool = step.mcp.toolName ?? step.mcp.name ?? step.mcp.serverName ?? 'unknown';
      return `MCP 도구 실행 요청: ${tool}`;
    }
    if (step.filePermission) {
      const path = step.filePermission.absolutePathUri ?? step.filePermission.path ?? '';
      return `파일 접근 권한 요청: ${path}`;
    }
    if (step.executeBrowserJavascript) {
      return '브라우저 JavaScript 실행 요청';
    }
    if (step.captureBrowserScreenshot) {
      return '브라우저 스크린샷 캡처 요청';
    }
    if (step.browserAction || step.browserSubagent) {
      return '브라우저 액션 실행 요청';
    }
    if (step.sendCommandInput) {
      return '터미널 입력 전송 요청';
    }
    if (step.readUrlContent) {
      const url = step.readUrlContent.url ?? '';
      return `URL 콘텐츠 읽기 요청: ${url}`;
    }
    if (step.deploy) {
      return '배포 요청';
    }
    return '에이전트가 권한 요청 중 — 수락 또는 거부가 필요합니다';
  }

  private findActiveCascade(
    summaries: Record<string, TrajectorySummary>
  ): [string, TrajectorySummary] | null {
    const entries = Object.entries(summaries);
    if (entries.length === 0) return null;

    // 1. 현재 워크스페이스에 매칭되는 cascade 중 최근 수정된 것
    if (this.workspaceUri) {
      const wsMatches = entries.filter(([, s]) =>
        s.workspaces?.some(w =>
          w.workspaceFolderAbsoluteUri === this.workspaceUri
        )
      );
      if (wsMatches.length > 0) {
        wsMatches.sort((a, b) =>
          new Date(b[1].lastModifiedTime).getTime() - new Date(a[1].lastModifiedTime).getTime()
        );
        return wsMatches[0] as [string, TrajectorySummary];
      }
    }

    // 2. RUNNING 상태인 cascade
    const running = entries.find(([, s]) => s.status === 'CASCADE_RUN_STATUS_RUNNING');
    if (running) return running as [string, TrajectorySummary];

    // 3. 가장 최근 수정된 cascade
    entries.sort((a, b) =>
      new Date(b[1].lastModifiedTime).getTime() - new Date(a[1].lastModifiedTime).getTime()
    );
    return entries[0] as [string, TrajectorySummary];
  }

  // ─── Step Processing ───

  private processNewSteps(steps: TrajectoryStep[]) {
    for (const step of steps) {
      switch (step.type) {
        case 'CORTEX_STEP_TYPE_USER_INPUT':
          this.handleUserInput(step);
          break;
        case 'CORTEX_STEP_TYPE_NOTIFY_USER':
          this.handleNotifyUser(step);
          break;
        case 'CORTEX_STEP_TYPE_PLANNER_RESPONSE':
          this.handlePlannerResponse(step);
          break;
      }
    }
  }

  /**
   * 사용자 입력 처리
   * - 자동승인 메시지는 무시
   * - Telegram에서 보낸 메시지는 에코 방지
   * - GUI에서 보낸 메시지만 gui_message 이벤트 발생
   */
  private handleUserInput(step: TrajectoryStep) {
    const ui = step.userInput;
    if (!ui) return;

    const text = ui.userResponse || '';
    if (!text) return;

    // 자동승인 시스템 메시지 무시
    if (AUTO_APPROVE_PATTERN.test(text)) return;

    // Telegram에서 보낸 메시지인지 확인 (에코 방지)
    if (this.isTelegramSent(text)) {
      this.output.appendLine('[TrajectoryMonitor] Skipping Telegram-sent echo');
      return;
    }

    this.emit({
      type: 'gui_message',
      content: text,
      timestamp: Date.now(),
    });
  }

  /**
   * notify_user 처리 — 에이전트의 최종 보고 메시지
   * toolCall의 argumentsJson에서 Message 추출
   */
  private handleNotifyUser(step: TrajectoryStep) {
    // NOTIFY_USER step은 보통 PLANNER_RESPONSE의 toolCall에서 파생됨
    // step 자체에 toolCall 정보가 있을 수 있음
    const toolCall = step.metadata?.toolCall;
    if (toolCall?.name === 'notify_user' && toolCall.argumentsJson) {
      const message = this.extractNotifyMessage(toolCall.argumentsJson);
      if (message) {
        this.emit({
          type: 'agent_response',
          content: message,
          timestamp: Date.now(),
        });
        return;
      }
    }

    // notifyUser 필드에 직접 있는 경우
    if (step.notifyUser?.message) {
      this.emit({
        type: 'agent_response',
        content: step.notifyUser.message,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * plannerResponse 처리
   * - response 텍스트가 있으면 agent_response
   * - notify_user toolCall이 있으면 agent_response
   */
  private handlePlannerResponse(step: TrajectoryStep) {
    const pr = step.plannerResponse;
    if (!pr) return;

    // 1. notify_user toolCall에서 메시지 추출
    if (pr.toolCalls) {
      for (const tc of pr.toolCalls) {
        if (tc.name === 'notify_user' && tc.argumentsJson) {
          const message = this.extractNotifyMessage(tc.argumentsJson);
          if (message) {
            this.emit({
              type: 'agent_response',
              content: message,
              timestamp: Date.now(),
            });
            return; // notify_user를 찾으면 response 텍스트는 스킵
          }
        }
      }
    }

    // 2. response 텍스트 (notify_user가 없는 경우에만)
    // 짧은 응답이나 도구 호출만 있는 경우는 스킵
    if (pr.response && pr.response.length > 20) {
      this.emit({
        type: 'agent_response',
        content: pr.response,
        timestamp: Date.now(),
      });
    }
  }

  private extractNotifyMessage(argumentsJson: string): string | null {
    try {
      const args = JSON.parse(argumentsJson);
      return args.Message || args.message || null;
    } catch {
      return null;
    }
  }

  // ─── Cleanup ───

  dispose() {
    this.stopPolling();
    this.listeners = [];
  }
}
