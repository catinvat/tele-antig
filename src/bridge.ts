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
 */

export interface AgentEvent {
  type: 'file_change' | 'terminal_output' | 'step_request' | 'info' | 'error';
  content: string;
  timestamp: number;
}

type AgentEventListener = (event: AgentEvent) => void;

export class AntigravityBridge {
  private output: vscode.OutputChannel;
  private listeners: AgentEventListener[] = [];
  private disposables: vscode.Disposable[] = [];
  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private lastDiagnostics: Map<string, number> = new Map();

  constructor(output: vscode.OutputChannel) {
    this.output = output;
  }

  /**
   * 에이전트 이벤트 리스너 등록
   */
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

  /**
   * 파일 변경 감시 시작
   */
  startWatching() {
    // 1. 워크스페이스 파일 변경 감시
    if (vscode.workspace.workspaceFolders?.length) {
      this.fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');
      this.disposables.push(
        this.fileWatcher.onDidChange(uri => {
          this.emit({
            type: 'file_change',
            content: `Modified: ${vscode.workspace.asRelativePath(uri)}`,
            timestamp: Date.now(),
          });
        }),
        this.fileWatcher.onDidCreate(uri => {
          this.emit({
            type: 'file_change',
            content: `Created: ${vscode.workspace.asRelativePath(uri)}`,
            timestamp: Date.now(),
          });
        }),
        this.fileWatcher.onDidDelete(uri => {
          this.emit({
            type: 'file_change',
            content: `Deleted: ${vscode.workspace.asRelativePath(uri)}`,
            timestamp: Date.now(),
          });
        }),
        this.fileWatcher
      );
    }

    // 2. 터미널 이벤트 감시
    this.disposables.push(
      vscode.window.onDidOpenTerminal(terminal => {
        this.emit({
          type: 'terminal_output',
          content: `Terminal opened: ${terminal.name}`,
          timestamp: Date.now(),
        });
      }),
      vscode.window.onDidCloseTerminal(terminal => {
        this.emit({
          type: 'terminal_output',
          content: `Terminal closed: ${terminal.name}`,
          timestamp: Date.now(),
        });
      })
    );

    // 3. 터미널 shell execution 감시 (VS Code 1.93+)
    this.disposables.push(
      vscode.window.onDidStartTerminalShellExecution?.((e) => {
        this.emit({
          type: 'terminal_output',
          content: `Command started: ${e.execution.commandLine?.value ?? 'unknown'}`,
          timestamp: Date.now(),
        });

        // 출력 스트림 수집
        const streamOutput = async () => {
          try {
            const stream = e.execution.read();
            for await (const data of stream) {
              this.emit({
                type: 'terminal_output',
                content: data,
                timestamp: Date.now(),
              });
            }
          } catch {
            // stream 종료
          }
        };
        streamOutput();
      }) ?? vscode.Disposable.from()
    );

    this.disposables.push(
      vscode.window.onDidEndTerminalShellExecution?.((e) => {
        this.emit({
          type: 'terminal_output',
          content: `Command ended (exit: ${e.exitCode ?? '?'}): ${e.execution.commandLine?.value ?? 'unknown'}`,
          timestamp: Date.now(),
        });
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
            const newErrors = errors.slice(prevCount);
            for (const err of newErrors) {
              this.emit({
                type: 'error',
                content: `${vscode.workspace.asRelativePath(uri)}:${err.range.start.line + 1}: ${err.message}`,
                timestamp: Date.now(),
              });
            }
          }
        }
      })
    );

    // 5. 에디터 변경 감시 (활성 에디터)
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) {
          this.emit({
            type: 'info',
            content: `Active editor: ${vscode.workspace.asRelativePath(editor.document.uri)}`,
            timestamp: Date.now(),
          });
        }
      })
    );

    this.output.appendLine('[Bridge] Watching started');
  }

  /**
   * 에이전트에게 프롬프트 전송
   */
  async sendPrompt(text: string): Promise<boolean> {
    try {
      // 에이전트 패널이 열려있는지 확인하고 열기
      await vscode.commands.executeCommand('antigravity.openAgent');
      // 약간의 지연 후 프롬프트 전송
      await new Promise(r => setTimeout(r, 500));
      await vscode.commands.executeCommand('antigravity.sendPromptToAgentPanel', text);
      this.output.appendLine(`[Bridge] Sent prompt: ${text.substring(0, 50)}...`);
      return true;
    } catch (e: any) {
      this.output.appendLine(`[Bridge] Send prompt error: ${e.message}`);
      // 폴백: sendTextToChat 시도
      try {
        await vscode.commands.executeCommand('antigravity.sendTextToChat', text);
        this.output.appendLine(`[Bridge] Sent via sendTextToChat (fallback)`);
        return true;
      } catch (e2: any) {
        this.output.appendLine(`[Bridge] Fallback also failed: ${e2.message}`);
        return false;
      }
    }
  }

  /**
   * 새 대화 시작
   */
  async startNewConversation(): Promise<boolean> {
    try {
      await vscode.commands.executeCommand('antigravity.startNewConversation');
      this.output.appendLine('[Bridge] New conversation started');
      return true;
    } catch (e: any) {
      this.output.appendLine(`[Bridge] Start conversation error: ${e.message}`);
      return false;
    }
  }

  /**
   * 에이전트 스텝 수락
   */
  async acceptStep(): Promise<boolean> {
    try {
      await vscode.commands.executeCommand('antigravity.agent.acceptAgentStep');
      this.output.appendLine('[Bridge] Step accepted');
      return true;
    } catch (e: any) {
      this.output.appendLine(`[Bridge] Accept step error: ${e.message}`);
      return false;
    }
  }

  /**
   * 에이전트 스텝 거부
   */
  async rejectStep(): Promise<boolean> {
    try {
      await vscode.commands.executeCommand('antigravity.agent.rejectAgentStep');
      this.output.appendLine('[Bridge] Step rejected');
      return true;
    } catch (e: any) {
      this.output.appendLine(`[Bridge] Reject step error: ${e.message}`);
      return false;
    }
  }

  /**
   * 에이전트 초기화
   */
  async initializeAgent(): Promise<boolean> {
    try {
      await vscode.commands.executeCommand('antigravity.initializeAgent');
      return true;
    } catch (e: any) {
      this.output.appendLine(`[Bridge] Initialize error: ${e.message}`);
      return false;
    }
  }

  /**
   * 현재 워크스페이스 정보
   */
  getWorkspaceInfo(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) return 'No workspace open';
    return folders.map(f => f.name).join(', ');
  }

  /**
   * 현재 열린 파일 목록
   */
  getOpenEditors(): string[] {
    return vscode.window.tabGroups.all.flatMap(group =>
      group.tabs
        .filter(tab => tab.input && 'uri' in (tab.input as any))
        .map(tab => vscode.workspace.asRelativePath((tab.input as any).uri))
    );
  }

  /**
   * 현재 활성 터미널 목록
   */
  getTerminals(): string[] {
    return vscode.window.terminals.map(t => t.name);
  }

  dispose() {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this.listeners = [];
    this.output.appendLine('[Bridge] Disposed');
  }
}
