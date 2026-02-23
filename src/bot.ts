import { Bot, InlineKeyboard, Context } from 'grammy';
import * as vscode from 'vscode';
import { AntigravityBridge, AgentEvent } from './bridge';
import { getAllowedChatId } from './config';

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
  private muted = false;
  private eventBuffer: AgentEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private bridgeDisposable: vscode.Disposable | undefined;

  constructor(token: string, bridge: AntigravityBridge, output: vscode.OutputChannel) {
    this.bot = new Bot(token);
    this.bridge = bridge;
    this.output = output;

    this.setupCommands();
    this.setupMessageHandler();
    this.setupCallbackQueries();
    this.setupBridgeListener();
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

    try {
      // 봇 정보 확인
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
          vscode.window.showInformationMessage('Tele-Antig: Telegram 봇 시작됨');
        },
      });
    } catch (e: any) {
      this.running = false;
      this.output.appendLine(`[Bot] Start error: ${e.message}`);
      vscode.window.showErrorMessage(`Tele-Antig: 봇 시작 실패 - ${e.message}`);
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
