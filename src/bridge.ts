import * as vscode from 'vscode';

/**
 * Antigravity Agent Manager Bridge
 *
 * 발견된 내부 명령:
 * - antigravity.sendPromptToAgentPanel(text: string) → 에이전트에 프롬프트 전송
 * - antigravity.sendTextToChat(text: string) → 채팅에 텍스트 전송
 * - antigravity.sendChatActionMessage(json: string) → 액션 메시지 전송
 * - antigravity.agent.acceptAgentStep → 에이전트 스텝 수락
 * - antigravity.agent.rejectAgentStep → 에이전트 스텝 거부
 * - antigravity.startNewConversation → 새 대화 시작
 * - antigravity.initializeAgent → 에이전트 초기화
 * - antigravity.openAgent → 에이전트 패널 열기
 *
 * 발견된 Context Keys:
 * - antigravity.canAcceptOrRejectCommand → 터미널 명령 수락/거부 가능
 * - antigravity.canTriggerTerminalCommandAction → 터미널 명령 액션 가능
 * - antigravity.canAcceptOrRejectFocusedHunk → 코드 편집 수락/거부 가능
 * - antigravity.agentBarVisible → 에이전트 바 표시 여부
 *
 * 발견된 StepStatus:
 * - WAITING = 9 → 권한 요청 대기 중 (이 상태에서 accept/reject 가능)
 */

export interface AgentEvent {
  type: 'file_change' | 'terminal_output' | 'step_request' | 'info' | 'error';
  content: string;
  timestamp: number;
}

type AgentEventListener = (event: AgentEvent) => void;

/**
 * 에이전트 활동 상태 추적
 *
 * 권한 요청 감지 방법 (2가지 병행):
 *
 * 1. Context Key 폴링 (정확도 높음):
 *    - antigravity.canAcceptOrRejectCommand 값을 주기적으로 읽기
 *    - false → true 전환 감지 → step_request 발송
 *
 * 2. Activity Stall 감지 (폴백):
 *    - 프롬프트 전송 후 에이전트가 활동하다 갑자기 멈추면 감지
 *    - Context Key 읽기가 불가능한 경우 사용
 */
interface ActivityState {
  /** 마지막 프롬프트 전송 시간 (0 = 프롬프트 미전송) */
  promptSentAt: number;
  /** 프롬프트 이후 첫 활동 감지 여부 */
  hadActivity: boolean;
  /** 마지막 활동 시간 */
  lastActivityAt: number;
  /** 이미 step_request 알림을 보냈는지 (stall 감지용) */
  stallNotified: boolean;
  /** 연속 무활동 알림 횟수 (반복 알림 방지용) */
  stallNotifyCount: number;
}

/** 활동 정지 후 step_request 알림까지 대기 시간 (ms) */
const STALL_THRESHOLD_MS = 12000;
/** 감시 주기 (ms) — context key 폴링 + stall 감지 */
const CHECK_INTERVAL_MS = 2000;
/** 최대 반복 stall 알림 횟수 */
const MAX_STALL_NOTIFICATIONS = 3;

/**
 * Context Key 폴링 대상
 * 이 중 하나라도 true가 되면 → 에이전트가 권한/수락 대기 중
 */
const CONTEXT_KEYS_TO_POLL = [
  'antigravity.canAcceptOrRejectCommand',
  'antigravity.canTriggerTerminalCommandAction',
  'antigravity.canAcceptOrRejectFocusedHunk',
];

export class AntigravityBridge {
  private output: vscode.OutputChannel;
  private listeners: AgentEventListener[] = [];
  private disposables: vscode.Disposable[] = [];
  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private lastDiagnostics: Map<string, number> = new Map();

  /** 에이전트 활동 상태 추적 */
  private activity: ActivityState = {
    promptSentAt: 0,
    hadActivity: false,
    lastActivityAt: 0,
    stallNotified: false,
    stallNotifyCount: 0,
  };
  private checkTimer: ReturnType<typeof setInterval> | undefined;

  /** Context Key 폴링 상태 */
  private contextKeyAvailable = true; // getContext가 작동하는지 여부
  private prevContextKeyState = false; // 이전 폴링의 context key 상태
  private contextNotifiedForThisPrompt = false; // 현재 프롬프트에서 context 알림 보냈는지

  constructor(output: vscode.OutputChannel) {
    this.output = output;
  }

  // ─── Event System ───

  onEvent(listener: AgentEventListener): vscode.Disposable {
    this.listeners.push(listener);
    return new vscode.Disposable(() => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    });
  }

  private emit(event: AgentEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        this.output.appendLine(`[Bridge] Listener error: ${e}`);
      }
    }
  }

  // ─── Activity Tracking ───

  private trackActivity() {
    if (this.activity.promptSentAt === 0) return;
    this.activity.lastActivityAt = Date.now();
    if (!this.activity.hadActivity) {
      this.activity.hadActivity = true;
    }
    // 활동 재개 → stall 알림 리셋 (다시 감지 가능하도록)
    if (this.activity.stallNotified) {
      this.activity.stallNotified = false;
    }
  }

  // ─── Periodic Check (Context Key + Stall Detection) ───

  private async periodicCheck() {
    // 1차: Context Key 폴링 (정확한 감지)
    if (this.contextKeyAvailable) {
      await this.pollContextKeys();
    }

    // 2차: Activity Stall 감지 (폴백)
    // Context Key가 불가능하거나, context로 감지 안 된 경우
    if (!this.contextKeyAvailable) {
      this.checkForStall();
    }
  }

  /**
   * Context Key 폴링 — 에이전트 WAITING 상태를 정확하게 감지
   */
  private async pollContextKeys() {
    try {
      let anyActive = false;

      for (const key of CONTEXT_KEYS_TO_POLL) {
        try {
          const value = await vscode.commands.executeCommand<boolean>('getContext', key);
          if (value === true) {
            anyActive = true;
            break;
          }
        } catch {
          // 개별 key 실패는 무시
        }
      }

      // false → true 전환 감지 (새 권한 요청 발생)
      if (anyActive && !this.prevContextKeyState && !this.contextNotifiedForThisPrompt) {
        this.contextNotifiedForThisPrompt = true;
        this.output.appendLine('[Bridge] Context key detected: agent waiting for approval');
        this.emit({
          type: 'step_request',
          content: '에이전트가 권한 요청 중 — 수락 또는 거부가 필요합니다',
          timestamp: Date.now(),
        });
      }

      // true → false 전환 (수락/거부됨) → 다음 요청 감지 준비
      if (!anyActive && this.prevContextKeyState) {
        this.contextNotifiedForThisPrompt = false;
      }

      this.prevContextKeyState = anyActive;
    } catch {
      // getContext 자체가 불가능 → 폴백 모드로 전환
      this.contextKeyAvailable = false;
      this.output.appendLine('[Bridge] getContext unavailable — using stall detection fallback');
    }
  }

  /**
   * Activity Stall 감지 (폴백) — 에이전트 활동 후 정지 감지
   */
  private checkForStall() {
    const a = this.activity;
    if (a.promptSentAt === 0) return;
    if (!a.hadActivity) return;
    if (a.stallNotified) return;
    if (a.stallNotifyCount >= MAX_STALL_NOTIFICATIONS) return;

    const silenceMs = Date.now() - a.lastActivityAt;
    if (silenceMs >= STALL_THRESHOLD_MS) {
      a.stallNotified = true;
      a.stallNotifyCount++;
      const silenceSec = Math.round(silenceMs / 1000);
      this.output.appendLine(`[Bridge] Agent stalled for ${silenceSec}s — sending step_request (#${a.stallNotifyCount})`);

      this.emit({
        type: 'step_request',
        content: `에이전트가 ${silenceSec}초간 멈춤 — 권한 요청 또는 입력 대기 중일 수 있습니다`,
        timestamp: Date.now(),
      });
    }
  }

  // ─── Activity State Management ───

  private resetActivityTracking() {
    this.activity = {
      promptSentAt: Date.now(),
      hadActivity: false,
      lastActivityAt: 0,
      stallNotified: false,
      stallNotifyCount: 0,
    };
    this.contextNotifiedForThisPrompt = false;
    this.prevContextKeyState = false;
  }

  private clearActivityTracking() {
    this.activity = {
      promptSentAt: 0,
      hadActivity: false,
      lastActivityAt: 0,
      stallNotified: false,
      stallNotifyCount: 0,
    };
    this.contextNotifiedForThisPrompt = false;
    this.prevContextKeyState = false;
  }

  // ─── Watch Setup ───

  startWatching() {
    // 1. 워크스페이스 파일 변경 감시
    if (vscode.workspace.workspaceFolders?.length) {
      this.fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');
      this.disposables.push(
        this.fileWatcher.onDidChange(uri => {
          this.trackActivity();
          this.emit({ type: 'file_change', content: `Modified: ${vscode.workspace.asRelativePath(uri)}`, timestamp: Date.now() });
        }),
        this.fileWatcher.onDidCreate(uri => {
          this.trackActivity();
          this.emit({ type: 'file_change', content: `Created: ${vscode.workspace.asRelativePath(uri)}`, timestamp: Date.now() });
        }),
        this.fileWatcher.onDidDelete(uri => {
          this.trackActivity();
          this.emit({ type: 'file_change', content: `Deleted: ${vscode.workspace.asRelativePath(uri)}`, timestamp: Date.now() });
        }),
        this.fileWatcher
      );
    }

    // 2. 터미널 이벤트 감시
    this.disposables.push(
      vscode.window.onDidOpenTerminal(terminal => {
        this.trackActivity();
        this.emit({ type: 'terminal_output', content: `Terminal opened: ${terminal.name}`, timestamp: Date.now() });
      }),
      vscode.window.onDidCloseTerminal(terminal => {
        this.trackActivity();
        this.emit({ type: 'terminal_output', content: `Terminal closed: ${terminal.name}`, timestamp: Date.now() });
      })
    );

    // 3. 터미널 shell execution 감시 (VS Code 1.93+)
    this.disposables.push(
      vscode.window.onDidStartTerminalShellExecution?.((e) => {
        this.trackActivity();
        this.emit({ type: 'terminal_output', content: `Command started: ${e.execution.commandLine?.value ?? 'unknown'}`, timestamp: Date.now() });

        const streamOutput = async () => {
          try {
            const stream = e.execution.read();
            for await (const data of stream) {
              this.trackActivity();
              this.emit({ type: 'terminal_output', content: data, timestamp: Date.now() });
            }
          } catch { /* stream 종료 */ }
        };
        streamOutput();
      }) ?? vscode.Disposable.from()
    );

    this.disposables.push(
      vscode.window.onDidEndTerminalShellExecution?.((e) => {
        this.trackActivity();
        this.emit({ type: 'terminal_output', content: `Command ended (exit: ${e.exitCode ?? '?'}): ${e.execution.commandLine?.value ?? 'unknown'}`, timestamp: Date.now() });
      }) ?? vscode.Disposable.from()
    );

    // 4. 진단(에러/경고) 변경 감시
    this.disposables.push(
      vscode.languages.onDidChangeDiagnostics(e => {
        for (const uri of e.uris) {
          const diags = vscode.languages.getDiagnostics(uri);
          const errors = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
          const prevCount = this.lastDiagnostics.get(uri.toString()) ?? 0;
          this.lastDiagnostics.set(uri.toString(), errors.length);

          if (errors.length > prevCount) {
            this.trackActivity();
            const newErrors = errors.slice(prevCount);
            for (const err of newErrors) {
              this.emit({ type: 'error', content: `${vscode.workspace.asRelativePath(uri)}:${err.range.start.line + 1}: ${err.message}`, timestamp: Date.now() });
            }
          }
        }
      })
    );

    // 5. 에디터 변경 감시
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) {
          this.trackActivity();
          this.emit({ type: 'info', content: `Active editor: ${vscode.workspace.asRelativePath(editor.document.uri)}`, timestamp: Date.now() });
        }
      })
    );

    // 6. 주기적 체크 (Context Key 폴링 + Stall 감지)
    this.checkTimer = setInterval(() => {
      this.periodicCheck();
    }, CHECK_INTERVAL_MS);

    this.output.appendLine('[Bridge] Watching started (context key polling + stall detection)');
  }

  // ─── Agent Commands ───

  async sendPrompt(text: string): Promise<boolean> {
    try {
      await vscode.commands.executeCommand('antigravity.openAgent');
      await new Promise(r => setTimeout(r, 500));
      await vscode.commands.executeCommand('antigravity.sendPromptToAgentPanel', text);
      this.output.appendLine(`[Bridge] Sent prompt: ${text.substring(0, 50)}...`);
      this.resetActivityTracking();
      return true;
    } catch (e: any) {
      this.output.appendLine(`[Bridge] Send prompt error: ${e.message}`);
      try {
        await vscode.commands.executeCommand('antigravity.sendTextToChat', text);
        this.output.appendLine(`[Bridge] Sent via sendTextToChat (fallback)`);
        this.resetActivityTracking();
        return true;
      } catch (e2: any) {
        this.output.appendLine(`[Bridge] Fallback also failed: ${e2.message}`);
        return false;
      }
    }
  }

  async startNewConversation(): Promise<boolean> {
    try {
      await vscode.commands.executeCommand('antigravity.startNewConversation');
      this.output.appendLine('[Bridge] New conversation started');
      this.clearActivityTracking();
      return true;
    } catch (e: any) {
      this.output.appendLine(`[Bridge] Start conversation error: ${e.message}`);
      return false;
    }
  }

  async acceptStep(): Promise<boolean> {
    try {
      await vscode.commands.executeCommand('antigravity.agent.acceptAgentStep');
      this.output.appendLine('[Bridge] Step accepted');
      this.resetActivityTracking();
      return true;
    } catch (e: any) {
      this.output.appendLine(`[Bridge] Accept step error: ${e.message}`);
      return false;
    }
  }

  async rejectStep(): Promise<boolean> {
    try {
      await vscode.commands.executeCommand('antigravity.agent.rejectAgentStep');
      this.output.appendLine('[Bridge] Step rejected');
      this.clearActivityTracking();
      return true;
    } catch (e: any) {
      this.output.appendLine(`[Bridge] Reject step error: ${e.message}`);
      return false;
    }
  }

  async initializeAgent(): Promise<boolean> {
    try {
      await vscode.commands.executeCommand('antigravity.initializeAgent');
      return true;
    } catch (e: any) {
      this.output.appendLine(`[Bridge] Initialize error: ${e.message}`);
      return false;
    }
  }

  // ─── Getters ───

  getWorkspaceInfo(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) return 'No workspace open';
    return folders.map(f => f.name).join(', ');
  }

  getOpenEditors(): string[] {
    return vscode.window.tabGroups.all.flatMap(group =>
      group.tabs
        .filter(tab => tab.input && 'uri' in (tab.input as any))
        .map(tab => vscode.workspace.asRelativePath((tab.input as any).uri))
    );
  }

  getTerminals(): string[] {
    return vscode.window.terminals.map(t => t.name);
  }

  dispose() {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = undefined;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this.listeners = [];
    this.output.appendLine('[Bridge] Disposed');
  }
}
