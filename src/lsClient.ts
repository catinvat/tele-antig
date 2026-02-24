import * as http from 'http';
import { execFile } from 'child_process';
import * as vscode from 'vscode';

/**
 * Antigravity Language Server HTTP Client
 *
 * LS 프로세스를 자동 발견하고 ConnectRPC JSON 형식으로 API를 호출합니다.
 *
 * 발견 방법:
 * 1. PowerShell로 language_server_windows_x64.exe 프로세스 찾기
 * 2. CommandLine에서 --csrf_token 파싱
 * 3. PID의 listening 포트 중 HTTP 포트 탐지
 *
 * API 호출:
 * - HTTP POST to /exa.language_server_pb.LanguageServerService/{Method}
 * - Content-Type: application/json
 * - x-codeium-csrf-token: {token}
 * - Connect-Protocol-Version: 1
 */

const LS_PROCESS_NAME = 'language_server_windows_x64.exe';
const LS_SERVICE_PATH = '/exa.language_server_pb.LanguageServerService';

/** 대화 요약 */
export interface TrajectorySummary {
  summary: string;
  stepCount: number;
  lastModifiedTime: string;
  trajectoryId: string;
  status: string;
  createdTime: string;
  workspaces: Array<{ workspaceFolderAbsoluteUri: string }>;
  lastUserInputTime: string;
  lastUserInputStepIndex: number;
  latestNotifyUserStep?: number;
}

/** 대화 요약 맵 (cascadeId → summary) */
export interface TrajectorySummaryMap {
  [cascadeId: string]: TrajectorySummary;
}

/** Trajectory Step (제네릭 — 타입별로 다른 필드를 가짐) */
export interface TrajectoryStep {
  type: string;
  status: string;
  metadata?: {
    createdAt?: string;
    completedAt?: string;
    source?: string;
    [key: string]: any;
  };
  // USER_INPUT
  userInput?: {
    items?: Array<{ text?: string; item?: any }>;
    userResponse?: string;
    clientType?: string;
    [key: string]: any;
  };
  // PLANNER_RESPONSE
  plannerResponse?: {
    response?: string;
    thinking?: string;
    toolCalls?: Array<{
      id: string;
      name: string;
      argumentsJson: string;
      [key: string]: any;
    }>;
    messageId?: string;
    [key: string]: any;
  };
  // NOTIFY_USER (보통 toolCall로 포함됨)
  notifyUser?: {
    message?: string;
    blockedOnUser?: boolean;
    [key: string]: any;
  };
  [key: string]: any;
}

export class LSClient {
  private csrfToken = '';
  private httpPort = 0;
  private discovered = false;
  private output: vscode.OutputChannel;

  constructor(output: vscode.OutputChannel) {
    this.output = output;
  }

  get isDiscovered(): boolean {
    return this.discovered;
  }

  /**
   * LS 프로세스를 발견하고 HTTP 포트 + CSRF 토큰을 획득
   */
  async discover(): Promise<boolean> {
    try {
      // 1. PowerShell로 LS 프로세스 정보 획득
      const processInfo = await this.findLSProcess();
      if (!processInfo) {
        this.output.appendLine('[LSClient] Language Server process not found');
        this.discovered = false;
        return false;
      }

      this.csrfToken = processInfo.csrfToken;
      this.output.appendLine(`[LSClient] Found LS process PID=${processInfo.pid}, csrf=${this.csrfToken.substring(0, 8)}...`);

      // 2. PID의 listening 포트들을 가져와서 HTTP 포트 찾기
      const ports = await this.getListeningPorts(processInfo.pid);
      if (ports.length === 0) {
        this.output.appendLine('[LSClient] No listening ports found');
        this.discovered = false;
        return false;
      }

      this.output.appendLine(`[LSClient] Listening ports: ${ports.join(', ')}`);

      // 3. 각 포트에 HTTP 테스트 요청 → 응답하는 포트 = HTTP 포트
      for (const port of ports) {
        const ok = await this.testHttpPort(port);
        if (ok) {
          this.httpPort = port;
          this.discovered = true;
          this.output.appendLine(`[LSClient] HTTP port discovered: ${port}`);
          return true;
        }
      }

      this.output.appendLine('[LSClient] No HTTP port responded');
      this.discovered = false;
      return false;
    } catch (e: any) {
      this.output.appendLine(`[LSClient] Discovery error: ${e.message}`);
      this.discovered = false;
      return false;
    }
  }

  /**
   * 모든 대화 요약 조회
   */
  async getAllTrajectories(): Promise<TrajectorySummaryMap | null> {
    const result = await this.apiCall<{ trajectorySummaries: TrajectorySummaryMap }>(
      'GetAllCascadeTrajectories', {}
    );
    return result?.trajectorySummaries ?? null;
  }

  /**
   * 특정 대화의 step 조회 (offset부터)
   */
  async getTrajectorySteps(cascadeId: string, stepOffset: number): Promise<TrajectoryStep[]> {
    const result = await this.apiCall<{ steps: TrajectoryStep[] }>(
      'GetCascadeTrajectorySteps', { cascadeId, stepOffset }
    );
    return result?.steps ?? [];
  }

  // ─── Private: Process Discovery ───

  private findLSProcess(): Promise<{ pid: number; csrfToken: string } | null> {
    return new Promise((resolve) => {
      // PowerShell 스크립트로 LS 프로세스 찾기
      const script = `
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq '${LS_PROCESS_NAME}' } | ForEach-Object {
  Write-Output "$($_.ProcessId)|$($_.CommandLine)"
}
`.trim();

      execFile('powershell.exe', ['-NoProfile', '-Command', script], {
        timeout: 10000,
        windowsHide: true,
      }, (err, stdout) => {
        if (err) {
          this.output.appendLine(`[LSClient] PowerShell error: ${err.message}`);
          resolve(null);
          return;
        }

        const lines = stdout.trim().split('\n').filter(l => l.trim());
        if (lines.length === 0) {
          resolve(null);
          return;
        }

        // 첫 번째 프로세스 사용
        const line = lines[0].trim();
        const pipeIdx = line.indexOf('|');
        if (pipeIdx < 0) {
          resolve(null);
          return;
        }

        const pid = parseInt(line.substring(0, pipeIdx), 10);
        const cmdLine = line.substring(pipeIdx + 1);

        // --csrf_token 파싱
        const csrfMatch = cmdLine.match(/--csrf_token\s+([a-f0-9-]+)/i);
        if (!csrfMatch) {
          this.output.appendLine('[LSClient] No --csrf_token found in command line');
          resolve(null);
          return;
        }

        resolve({ pid, csrfToken: csrfMatch[1] });
      });
    });
  }

  private getListeningPorts(pid: number): Promise<number[]> {
    return new Promise((resolve) => {
      const script = `
Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Output $_.LocalPort
}
`.trim();

      execFile('powershell.exe', ['-NoProfile', '-Command', script], {
        timeout: 10000,
        windowsHide: true,
      }, (err, stdout) => {
        if (err) {
          this.output.appendLine(`[LSClient] Port discovery error: ${err.message}`);
          resolve([]);
          return;
        }

        const ports = stdout.trim().split('\n')
          .map(l => parseInt(l.trim(), 10))
          .filter(p => !isNaN(p) && p > 0);
        resolve(ports);
      });
    });
  }

  private testHttpPort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const body = JSON.stringify({});
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: `${LS_SERVICE_PATH}/GetAllCascadeTrajectories`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-codeium-csrf-token': this.csrfToken,
          'Connect-Protocol-Version': '1',
        },
        timeout: 3000,
      }, (res) => {
        // 응답을 소비 (메모리 누수 방지)
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          resolve(res.statusCode === 200);
        });
      });

      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.write(body);
      req.end();
    });
  }

  // ─── Private: API Call ───

  private apiCall<T>(method: string, body: Record<string, any>): Promise<T | null> {
    if (!this.discovered) return Promise.resolve(null);

    return new Promise((resolve) => {
      const bodyStr = JSON.stringify(body);
      const req = http.request({
        hostname: '127.0.0.1',
        port: this.httpPort,
        path: `${LS_SERVICE_PATH}/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-codeium-csrf-token': this.csrfToken,
          'Connect-Protocol-Version': '1',
        },
        timeout: 10000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            this.output.appendLine(`[LSClient] API ${method} failed: HTTP ${res.statusCode}`);
            // 401/403 → CSRF 토큰 만료 → 재발견 필요
            if (res.statusCode === 401 || res.statusCode === 403) {
              this.discovered = false;
            }
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(data) as T);
          } catch {
            this.output.appendLine(`[LSClient] API ${method} JSON parse error`);
            resolve(null);
          }
        });
      });

      req.on('error', (err: Error) => {
        this.output.appendLine(`[LSClient] API ${method} error: ${err.message}`);
        // 연결 실패 → LS 재시작됨 → 재발견 필요
        this.discovered = false;
        resolve(null);
      });

      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });

      req.write(bodyStr);
      req.end();
    });
  }
}
