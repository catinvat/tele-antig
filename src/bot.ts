import { Bot, InlineKeyboard, Context, GrammyError, HttpError } from 'grammy';
import * as vscode from 'vscode';
import { AntigravityBridge, AgentEvent } from './bridge';
import { getAllowedChatId } from './config';
import * as https from 'https';

/**
 * Telegram Bot - Antigravity Agent Manager 브릿지
 *
 * 명령어:
 *   일반 메시지 → 에이전트에게 프롬프트 전송
 *   /start → 봇 시작 안내
 *   /new → 새 대화 시작
 *   /status → 현재 상태 (워크스페이스, 열린 파일, 터미널)
 *   /accept → 에이전트 스텝 수락
 *   /reject → 에이전트 스텝 거부
 *   /mute → 알림 끄기
 *   /unmute → 알림 켜기
 */

// 터미널 출력에서 민감한 정보를 마스킹하는 패턴
const SENSITIVE_PATTERNS = [
  /(?:api[_-]?key|apikey|token|secret|password|passwd|credential|auth)[=:]\s*\S+/gi,
  /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/g,       // GitHub tokens
  /sk-[A-Za-z0-9]{20,}/g,                                // OpenAI tokens
  /xox[bpas]-[A-Za-z0-9-]+/g,                            // Slack tokens
  /(?:AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}/g,               // AWS access keys
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g,            // Private keys
  /[0-9]+:[A-Za-z0-9_-]{35,}/g,                          // Telegram bot tokens
];

const MAX_EVENT_BUFFER = 200;

function sanitize(text: string): string {
  let result = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

/** Telegram Legacy Markdown 특수문자 이스케이프 (parse_mode: 'Markdown' 용) */
function escapeMarkdown(text: string): string {
  return text.replace(/([*_`\[])/g, '\\$1');
}

export class TelegramBot {
  private bot: Bot;
  private bridge: AntigravityBridge;
  private output: vscode.OutputChannel;
  private token: string;
  private muted = false;
  private eventBuffer: AgentEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private bridgeDisposable: vscode.Disposable | undefined;

  constructor(token: string, bridge: AntigravityBridge, output: vscode.OutputChannel) {
    this.token = token;
    this.bot = new Bot(token);
    this.bridge = bridge;
    this.output = output;

    // grammy의 fetch() 대신 Node.js https 모듈 사용
    // (Antigravity 환경에서 fetch()가 차단되는 문제 해결)
    this.installHttpsTransport();

    this.setupCommands();
    this.setupMessageHandler();
    this.setupCallbackQueries();
    this.setupBridgeListener();
  }

  /**
   * grammy의 네트워크 통신을 Node.js https 모듈로 교체
   *
   * Antigravity(VS Code fork) 환경에서는 fetch() API가 차단/제한되어
   * grammy의 기본 HTTP 클라이언트가 동작하지 않음.
   * Node.js의 https 모듈은 정상 동작하므로 이를 사용하여 Telegram API 호출.
   */
  private installHttpsTransport() {
    const token = this.token;
    const output = this.output;

    this.bot.api.config.use(async (_prev, method, payload, signal) => {
      return new Promise((resolve, reject) => {
        const url = `https://api.telegram.org/bot${token}/${method}`;

        // payload에서 undefined 값 제거 후 JSON 직렬화
        const cleanPayload: Record<string, unknown> = {};
        if (payload && typeof payload === 'object') {
          for (const [k, v] of Object.entries(payload)) {
            if (v !== undefined) cleanPayload[k] = v;
          }
        }
        const body = JSON.stringify(cleanPayload);

        // getUpdates의 long polling은 timeout이 길어야 함
        // Telegram의 timeout(초) + 여유 30초
        const telegramTimeout = (method === 'getUpdates' && typeof cleanPayload.timeout === 'number')
          ? cleanPayload.timeout as number
          : 0;
        const httpTimeout = (telegramTimeout + 30) * 1000;

        const req = https.request(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body).toString(),
          },
          timeout: httpTimeout,
        }, (res) => {
          let data = '';
          res.on('data', (chunk: string) => { data += chunk; });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              resolve(parsed);
            } catch {
              reject(new Error(`[httpsTransport] JSON parse failed for ${method}: ${data.substring(0, 200)}`));
            }
          });
          res.on('error', (err: Error) => {
            reject(new Error(`[httpsTransport] Response error for ${method}: ${err.message}`));
          });
        });

        req.on('error', (err: Error) => {
          output.appendLine(`[httpsTransport] Request error for ${method}: ${err.message}`);
          reject(err);
        });

        req.on('timeout', () => {
          req.destroy();
          // getUpdates timeout은 정상적인 polling cycle이므로 빈 결과 반환
          if (method === 'getUpdates') {
            resolve({ ok: true, result: [] });
          } else {
            reject(new Error(`[httpsTransport] Timeout for ${method}`));
          }
        });

        // AbortSignal 처리 (bot.stop() 호출 시 요청 취소)
        if (signal) {
          if (signal.aborted) {
            req.destroy();
            reject(new Error('Request aborted'));
            return;
          }
          const onAbort = () => {
            req.destroy();
            // getUpdates abort은 정상 종료 시나리오
            if (method === 'getUpdates') {
              resolve({ ok: true, result: [] });
            } else {
              reject(new Error('Request aborted'));
            }
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }

        req.write(body);
        req.end();
      });
    });

    output.appendLine('[Bot] HTTPS transport installed (bypassing fetch)');
  }

  /**
   * 토큰 유효성 검증 (봇 생성 없이 HTTP로 직접 테스트)
   * @returns { ok: true, botName: string } 또는 { ok: false, error: string }
   */
  static validateToken(token: string): Promise<{ ok: true; botName: string } | { ok: false; error: string }> {
    return new Promise((resolve) => {
      const url = `https://api.telegram.org/bot${token}/getMe`;
      const timeout = setTimeout(() => {
        resolve({ ok: false, error: '⏱️ 연결 시간 초과 (10초). 네트워크를 확인하세요.\n\n가능한 원인:\n• 인터넷 연결 불안정\n• 방화벽이 api.telegram.org 차단\n• 프록시/VPN 필요' });
      }, 10000);

      const req = https.get(url, (res) => {
        clearTimeout(timeout);
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.ok && json.result) {
              resolve({ ok: true, botName: `@${json.result.username} (${json.result.first_name})` });
            } else if (res.statusCode === 401 || res.statusCode === 404) {
              resolve({ ok: false, error: '🔑 봇 토큰이 유효하지 않습니다.\n\n확인 사항:\n1. @BotFather에서 /newbot 으로 봇 생성\n2. 발급받은 토큰 전체를 정확히 복사\n3. "Tele-Antig: Set Token"으로 다시 입력' });
            } else {
              resolve({ ok: false, error: `❌ Telegram API 응답 오류: HTTP ${res.statusCode}\n${json.description || ''}` });
            }
          } catch {
            resolve({ ok: false, error: `❌ 응답 파싱 실패: HTTP ${res.statusCode}` });
          }
        });
      });

      req.on('error', (err) => {
        clearTimeout(timeout);
        const errMsg = err.message || String(err);
        if (errMsg.includes('ENOTFOUND') || errMsg.includes('EAI_AGAIN')) {
          resolve({ ok: false, error: '🌐 DNS 조회 실패: api.telegram.org에 연결할 수 없습니다.\n\n가능한 원인:\n• 인터넷 연결 끊김\n• DNS 서버 문제\n• 프록시/VPN 설정 필요' });
        } else if (errMsg.includes('ECONNREFUSED') || errMsg.includes('ECONNRESET')) {
          resolve({ ok: false, error: '🚫 연결 거부됨: api.telegram.org에 접속할 수 없습니다.\n\n가능한 원인:\n• 방화벽이 Telegram API 차단\n• 프록시/VPN이 필요한 네트워크\n• 기업/학교 네트워크 제한' });
        } else if (errMsg.includes('ETIMEDOUT') || errMsg.includes('TIMEOUT')) {
          resolve({ ok: false, error: '⏱️ 연결 시간 초과.\n\n가능한 원인:\n• 네트워크 속도 문제\n• 방화벽/프록시 문제' });
        } else {
          resolve({ ok: false, error: `❌ 네트워크 오류: ${errMsg}` });
        }
      });

      req.end();
    });
  }

  /**
   * 인증 체크 - allowedChatId가 반드시 설정되어 있어야 함
   */
  private isAuthorized(ctx: Context): boolean {
    const allowedId = getAllowedChatId();
    if (!allowedId) {
      // Chat ID 미설정 시 → 보안을 위해 차단 (미설정=전체허용이 아님)
      return false;
    }
    return ctx.chat?.id.toString() === allowedId;
  }

  private setupCommands() {
    this.bot.command('start', async (ctx) => {
      const allowedId = getAllowedChatId();
      const chatId = ctx.chat.id;

      // Chat ID 미설정 상태: ID를 알려주고 설정 안내
      if (!allowedId) {
        await ctx.reply(
          `🔑 *Tele-Antig 초기 설정*\n\n` +
          `당신의 Chat ID: \`${chatId}\`\n\n` +
          `Antigravity에서 다음을 실행하세요:\n` +
          `Ctrl+Shift+P → "Tele-Antig: Set Chat ID"\n` +
          `→ \`${chatId}\` 입력\n\n` +
          `설정 후 다시 /start 를 보내세요.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      if (!this.isAuthorized(ctx)) {
        await ctx.reply('⛔ 인증되지 않은 사용자입니다.');
        return;
      }

      await ctx.reply(
        `🤖 *Tele-Antig 연결됨*\n\n` +
        `Workspace: ${escapeMarkdown(this.bridge.getWorkspaceInfo())}\n\n` +
        `*명령어:*\n` +
        `• 메시지 입력 → 에이전트에게 전달\n` +
        `• /new → 새 대화 시작\n` +
        `• /status → 현재 상태\n` +
        `• /accept → 스텝 수락\n` +
        `• /reject → 스텝 거부\n` +
        `• /mute → 알림 끄기\n` +
        `• /unmute → 알림 켜기`,
        { parse_mode: 'Markdown' }
      );
    });

    this.bot.command('new', async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      const ok = await this.bridge.startNewConversation();
      await ctx.reply(ok ? '🆕 새 대화를 시작했습니다.' : '❌ 새 대화 시작 실패');
    });

    this.bot.command('status', async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      const editors = this.bridge.getOpenEditors();
      const terminals = this.bridge.getTerminals();

      // 파일명을 이스케이프하여 Markdown 깨짐 방지
      const editorList = editors.slice(0, 10).map(e => `  • ${escapeMarkdown(e)}`).join('\n') || '  (없음)';
      const terminalList = terminals.map(t => `  • ${escapeMarkdown(t)}`).join('\n') || '  (없음)';

      await ctx.reply(
        `📊 *상태*\n\n` +
        `*Workspace:* ${escapeMarkdown(this.bridge.getWorkspaceInfo())}\n` +
        `*열린 파일 (${editors.length}):*\n${editorList}\n` +
        `*터미널 (${terminals.length}):*\n${terminalList}\n` +
        `*알림:* ${this.muted ? '🔇 꺼짐' : '🔔 켜짐'}`,
        { parse_mode: 'Markdown' }
      );
    });

    this.bot.command('accept', async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      const ok = await this.bridge.acceptStep();
      await ctx.reply(ok ? '✅ 스텝을 수락했습니다.' : '❌ 수락 실패 (대기 중인 스텝이 없을 수 있습니다)');
    });

    this.bot.command('reject', async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      const ok = await this.bridge.rejectStep();
      await ctx.reply(ok ? '🚫 스텝을 거부했습니다.' : '❌ 거부 실패');
    });

    this.bot.command('mute', async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      this.muted = true;
      await ctx.reply('🔇 알림이 꺼졌습니다. /unmute 로 다시 켤 수 있습니다.');
    });

    this.bot.command('unmute', async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      this.muted = false;
      await ctx.reply('🔔 알림이 켜졌습니다.');
    });
  }

  private setupMessageHandler() {
    this.bot.on('message:text', async (ctx) => {
      if (!this.isAuthorized(ctx)) {
        const allowedId = getAllowedChatId();
        if (!allowedId) {
          await ctx.reply('⚠️ Chat ID가 설정되지 않았습니다. /start 를 먼저 보내세요.');
        } else {
          await ctx.reply('⛔ 인증되지 않은 사용자입니다.');
        }
        return;
      }

      const text = ctx.message.text;
      if (text.startsWith('/')) return; // 명령어는 스킵

      await ctx.reply('📤 에이전트에게 전달 중...');

      const ok = await this.bridge.sendPrompt(text);
      if (ok) {
        await ctx.reply('✅ 에이전트에게 전달됨. 작업 진행 상황이 알림으로 옵니다.');
      } else {
        await ctx.reply('❌ 전달 실패. 에이전트 패널이 열려있는지 확인하세요.');
      }
    });
  }

  private setupCallbackQueries() {
    // 콜백 쿼리에도 인증 체크 추가
    this.bot.callbackQuery('accept_step', async (ctx) => {
      if (!this.isAuthorized(ctx)) {
        await ctx.answerCallbackQuery({ text: '⛔ 인증되지 않은 사용자' });
        return;
      }
      await ctx.answerCallbackQuery();
      const ok = await this.bridge.acceptStep();
      const originalText = ctx.callbackQuery.message?.text ?? '';
      await ctx.editMessageText(
        originalText + (ok ? '\n\n✅ 수락됨' : '\n\n❌ 수락 실패')
      );
    });

    this.bot.callbackQuery('reject_step', async (ctx) => {
      if (!this.isAuthorized(ctx)) {
        await ctx.answerCallbackQuery({ text: '⛔ 인증되지 않은 사용자' });
        return;
      }
      await ctx.answerCallbackQuery();
      const ok = await this.bridge.rejectStep();
      const originalText = ctx.callbackQuery.message?.text ?? '';
      await ctx.editMessageText(
        originalText + (ok ? '\n\n🚫 거부됨' : '\n\n❌ 거부 실패')
      );
    });
  }

  private setupBridgeListener() {
    this.bridgeDisposable = this.bridge.onEvent((event) => {
      if (this.muted) return;

      // 버퍼 크기 제한 (메모리 보호)
      if (this.eventBuffer.length >= MAX_EVENT_BUFFER) {
        this.eventBuffer.shift(); // 가장 오래된 이벤트 제거
      }
      this.eventBuffer.push(event);
    });

    // 2초마다 버퍼된 이벤트를 Telegram에 전송
    this.flushTimer = setInterval(() => {
      this.flushEvents();
    }, 2000);
  }

  private async flushEvents() {
    if (this.eventBuffer.length === 0) return;

    const chatId = getAllowedChatId();
    if (!chatId) return;

    // 이벤트를 유형별로 그룹화
    const events = this.eventBuffer.splice(0);
    const grouped: Record<string, string[]> = {};

    for (const event of events) {
      if (!grouped[event.type]) grouped[event.type] = [];
      grouped[event.type].push(event.content);
    }

    const parts: string[] = [];

    if (grouped['file_change']) {
      const changes = grouped['file_change'];
      // 파일 경로 이스케이프
      parts.push(`📁 *파일 변경 (${changes.length}):*\n${changes.slice(0, 15).map(c => `  ${escapeMarkdown(c)}`).join('\n')}`);
    }

    if (grouped['terminal_output']) {
      const outputs = grouped['terminal_output'];
      // 터미널 출력: 민감 정보 마스킹 + 길이 제한
      const combined = sanitize(outputs.join('\n')).substring(0, 2000);
      parts.push(`💻 *터미널:*\n\`\`\`\n${combined}\n\`\`\``);
    }

    if (grouped['error']) {
      const errors = grouped['error'];
      parts.push(`🔴 *에러 (${errors.length}):*\n${errors.slice(0, 10).map(e => `  ${escapeMarkdown(e)}`).join('\n')}`);
    }

    if (grouped['step_request']) {
      const steps = grouped['step_request'];
      const keyboard = new InlineKeyboard()
        .text('✅ 수락', 'accept_step')
        .text('🚫 거부', 'reject_step');
      try {
        await this.bot.api.sendMessage(
          chatId,
          `⚠️ *에이전트 권한 요청:*\n${steps.map(s => escapeMarkdown(s)).join('\n')}`,
          { parse_mode: 'Markdown', reply_markup: keyboard }
        );
      } catch (e) {
        this.output.appendLine(`[Bot] Send step request error: ${e}`);
      }
      return; // 권한 요청은 따로 전송
    }

    if (grouped['info']) {
      const infos = grouped['info'];
      parts.push(`ℹ️ ${infos.slice(0, 5).map(i => escapeMarkdown(i)).join('\n')}`);
    }

    if (parts.length === 0) return;

    const message = parts.join('\n\n');

    try {
      await this.bot.api.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (e: any) {
      // Markdown 파싱 에러시 plain text로 재시도
      try {
        await this.bot.api.sendMessage(chatId, message.replace(/[*`_\[\]\\]/g, ''));
      } catch (e2) {
        this.output.appendLine(`[Bot] Send message error: ${e2}`);
      }
    }
  }

  /**
   * 특정 채팅에 메시지 전송 (외부에서 호출용)
   */
  async sendMessage(chatId: string, text: string): Promise<void> {
    try {
      await this.bot.api.sendMessage(chatId, text);
    } catch (e) {
      this.output.appendLine(`[Bot] sendMessage error: ${e}`);
    }
  }

  /**
   * 봇 시작
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.bridge.startWatching();
    this.output.appendLine('[Bot] Starting Telegram bot...');
    this.output.appendLine('[Bot] Validating token with Telegram API...');

    try {
      // 봇 정보 확인 (토큰 유효성 + 네트워크 체크)
      const me = await this.bot.api.getMe();
      this.output.appendLine(`[Bot] Bot: @${me.username} (${me.first_name})`);

      // 인증된 사용자에게 시작 알림
      const chatId = getAllowedChatId();
      if (chatId) {
        await this.bot.api.sendMessage(
          chatId,
          `🟢 *Tele-Antig 연결됨*\nWorkspace: ${escapeMarkdown(this.bridge.getWorkspaceInfo())}`,
          { parse_mode: 'Markdown' }
        ).catch(() => {
          // Markdown 실패시 plain text
          return this.bot.api.sendMessage(chatId, `🟢 Tele-Antig 연결됨\nWorkspace: ${this.bridge.getWorkspaceInfo()}`);
        });
      }

      // long-polling 시작
      this.bot.start({
        onStart: () => {
          this.output.appendLine('[Bot] Polling started');
          vscode.window.showInformationMessage('Tele-Antig: Telegram 봇 시작됨 ✅');
        },
      });
    } catch (e: any) {
      this.running = false;

      // 에러 유형별 구체적 안내 메시지
      let userMessage: string;

      if (e instanceof GrammyError) {
        // Telegram API가 응답했지만 에러 (토큰 문제)
        if (e.error_code === 401 || e.error_code === 404) {
          userMessage = '봇 토큰이 유효하지 않습니다. @BotFather에서 토큰을 확인하고 "Tele-Antig: Set Token"으로 다시 입력하세요.';
        } else {
          userMessage = `Telegram API 오류 (${e.error_code}): ${e.description}`;
        }
      } else if (e instanceof HttpError) {
        // 네트워크 레벨 에러
        userMessage = 'Telegram 서버에 연결할 수 없습니다. 인터넷 연결, 방화벽, VPN/프록시를 확인하세요.';
      } else if (e.message?.includes('Network request')) {
        // grammy의 기본 네트워크 에러 메시지
        userMessage = 'Telegram API에 연결 실패. "Tele-Antig: Test Token"으로 상세 진단을 실행하세요.';
      } else {
        userMessage = e.message || String(e);
      }

      this.output.appendLine(`[Bot] Start error: ${e.message}`);
      this.output.appendLine(`[Bot] Error type: ${e.constructor?.name}`);
      this.output.appendLine(`[Bot] Tip: "Tele-Antig: Test Token" 명령으로 토큰과 네트워크를 진단할 수 있습니다.`);
      vscode.window.showErrorMessage(`Tele-Antig: ${userMessage}`, 'Test Token').then(action => {
        if (action === 'Test Token') {
          vscode.commands.executeCommand('teleAntig.testToken');
        }
      });
      throw e;
    }
  }

  /**
   * 봇 정지
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }

    this.bridgeDisposable?.dispose();

    try {
      await this.bot.stop();
    } catch {
      // ignore
    }

    this.running = false;
    this.output.appendLine('[Bot] Stopped');
    vscode.window.showInformationMessage('Tele-Antig: Telegram 봇 정지됨');
  }

  get isRunning(): boolean {
    return this.running;
  }
}
