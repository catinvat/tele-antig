import * as vscode from 'vscode';
import { LSClient, TrajectorySummary, TrajectoryStep } from './lsClient';

/**
 * Trajectory Monitor — 대화 상태를 폴링하여 새 메시지/응답 감지
 *
 * 역할:
 * 1. Language Server에서 주기적으로 대화 요약을 조회
 * 2. 새 step이 추가되면 내용을 분석하여 이벤트 발생
 * 3. 에이전트 응답 (notify_user) → agent_response 이벤트
 * 4. GUI 사용자 입력 → gui_message 이벤트
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

export interface TrajectoryEvent {
  type: 'agent_response' | 'gui_message';
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
  private lastStepCount = 0;
  private lastStatus = '';

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
        this.lastStepCount = summary.stepCount;
        this.lastStatus = summary.status;
        return; // 첫 전환 시에는 기존 step들을 스킵
      }

      // 4. 상태 변화 감지
      const statusChanged = summary.status !== this.lastStatus;
      const newSteps = summary.stepCount - this.lastStepCount;

      if (statusChanged) {
        this.output.appendLine(`[TrajectoryMonitor] Status: ${this.lastStatus} → ${summary.status}`);
      }

      this.lastStatus = summary.status;

      // 5. 새 step이 있으면 조회
      if (newSteps > 0) {
        const steps = await this.lsClient.getTrajectorySteps(cascadeId, this.lastStepCount);
        this.lastStepCount = summary.stepCount;

        if (steps.length > 0) {
          this.processNewSteps(steps);
        }
      }
    } catch (e: any) {
      this.output.appendLine(`[TrajectoryMonitor] Poll error: ${e.message}`);
    }
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
