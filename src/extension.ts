import * as vscode from 'vscode';
import { AntigravityBridge } from './bridge';
import { TelegramBot } from './bot';
// TelegramBot.validateToken()은 봇 인스턴스 없이 토큰 검증 가능
import { initSecretStorage, getBotToken, getAllowedChatId, setBotToken, setAllowedChatId, getAutoStart } from './config';
import {
  exploreCommands,
  exploreExtensions,
  exploreLmModels,
  testChatSend,
} from './explorer';

let outputChannel: vscode.OutputChannel;
let bridge: AntigravityBridge | undefined;
let bot: TelegramBot | undefined;

export function activate(context: vscode.ExtensionContext) {
  // SecretStorage 초기화 (봇 토큰 암호화 저장용)
  initSecretStorage(context);

  outputChannel = vscode.window.createOutputChannel('Tele-Antig');

  // 봇 시작
  context.subscriptions.push(
    vscode.commands.registerCommand('teleAntig.startBot', async () => {
      await startBot();
    })
  );

  // 봇 정지
  context.subscriptions.push(
    vscode.commands.registerCommand('teleAntig.stopBot', async () => {
      await stopBot();
    })
  );

  // 토큰 설정
  context.subscriptions.push(
    vscode.commands.registerCommand('teleAntig.setToken', async () => {
      const token = await vscode.window.showInputBox({
        prompt: 'Telegram Bot Token을 입력하세요 (@BotFather에서 발급)',
        password: true,
        placeHolder: '123456789:ABCDefGhIjKlMnOpQrStUvWxYz',
        ignoreFocusOut: true,
      });
      if (token) {
        await setBotToken(token);
        vscode.window.showInformationMessage('Tele-Antig: 봇 토큰이 안전하게 저장되었습니다.');
      }
    })
  );

  // Chat ID 설정
  context.subscriptions.push(
    vscode.commands.registerCommand('teleAntig.setChatId', async () => {
      const chatId = await vscode.window.showInputBox({
        prompt: '허용할 Telegram Chat ID를 입력하세요 (/start 명령 후 표시됨)',
        placeHolder: '123456789',
        validateInput: (value) => {
          if (value && !/^\d+$/.test(value)) {
            return 'Chat ID는 숫자만 가능합니다.';
          }
          return null;
        },
      });
      if (chatId) {
        await setAllowedChatId(chatId);
        vscode.window.showInformationMessage(`Tele-Antig: Chat ID ${chatId} 설정됨.`);
      }
    })
  );

  // 토큰 유효성 테스트
  context.subscriptions.push(
    vscode.commands.registerCommand('teleAntig.testToken', async () => {
      const token = await getBotToken();
      if (!token) {
        vscode.window.showErrorMessage(
          'Tele-Antig: 봇 토큰이 설정되지 않았습니다. 먼저 "Tele-Antig: Set Token"을 실행하세요.'
        );
        return;
      }

      outputChannel.show();
      outputChannel.appendLine('[Test] 토큰 유효성 검사 중...');
      outputChannel.appendLine(`[Test] 토큰 형식: ${token.substring(0, 6)}...${token.substring(token.length - 4)} (${token.length}자)`);

      // 토큰 형식 기본 체크
      if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
        outputChannel.appendLine('[Test] ⚠️ 토큰 형식이 올바르지 않습니다. 올바른 형식: 123456789:ABCDefGhIjKlMnOpQrStUvWxYz');
        vscode.window.showErrorMessage(
          'Tele-Antig: 토큰 형식이 잘못되었습니다. @BotFather에서 받은 토큰 전체를 정확히 입력하세요. (예: 123456789:ABCDefGhIjKlMnOpQrStUvWxYz...)'
        );
        return;
      }

      outputChannel.appendLine('[Test] 토큰 형식 OK. Telegram API 연결 테스트 중...');
      const result = await TelegramBot.validateToken(token);

      if (result.ok) {
        outputChannel.appendLine(`[Test] ✅ 성공! 봇: ${result.botName}`);
        vscode.window.showInformationMessage(`Tele-Antig: 토큰 유효! 봇: ${result.botName}. 이제 "Start Bot"으로 시작하세요.`);
      } else {
        outputChannel.appendLine(`[Test] ❌ 실패: ${result.error}`);
        vscode.window.showErrorMessage(`Tele-Antig: 토큰 테스트 실패. Output 패널에서 상세 내용을 확인하세요.`);
      }
    })
  );

  // 에이전트에 테스트 전송
  context.subscriptions.push(
    vscode.commands.registerCommand('teleAntig.testSend', async () => {
      const text = await vscode.window.showInputBox({
        prompt: '에이전트에게 보낼 테스트 메시지를 입력하세요',
        placeHolder: 'Hello from Tele-Antig!',
      });
      if (text) {
        if (!bridge) {
          bridge = new AntigravityBridge(outputChannel);
        }
        outputChannel.show();
        const ok = await bridge.sendPrompt(text);
        outputChannel.appendLine(`[Test] Send result: ${ok}`);
      }
    })
  );

  // 탐색 명령 (Phase 1 유지)
  context.subscriptions.push(
    vscode.commands.registerCommand('teleAntig.exploreCommands', async () => {
      outputChannel.clear();
      outputChannel.show();
      await exploreCommands(outputChannel);
    }),
    vscode.commands.registerCommand('teleAntig.exploreExtensions', async () => {
      outputChannel.clear();
      outputChannel.show();
      await exploreExtensions(outputChannel);
    }),
    vscode.commands.registerCommand('teleAntig.exploreLmModels', async () => {
      outputChannel.clear();
      outputChannel.show();
      await exploreLmModels(outputChannel);
    }),
    vscode.commands.registerCommand('teleAntig.testChatSend', async () => {
      outputChannel.clear();
      outputChannel.show();
      await testChatSend(outputChannel);
    })
  );

  context.subscriptions.push(outputChannel);

  // 자동 시작
  if (getAutoStart()) {
    getBotToken().then(token => {
      if (token) {
        startBot().catch(e => {
          outputChannel.appendLine(`[AutoStart] Failed: ${e.message}`);
        });
      }
    });
  }

  vscode.window.showInformationMessage(
    'Tele-Antig 활성화됨. Command Palette에서 "Tele-Antig: Set Token" → "Tele-Antig: Start Bot" 으로 시작하세요.'
  );
}

async function startBot(): Promise<void> {
  if (bot?.isRunning) {
    vscode.window.showWarningMessage('Tele-Antig: 봇이 이미 실행 중입니다.');
    return;
  }

  const token = await getBotToken();
  if (!token) {
    const action = await vscode.window.showErrorMessage(
      'Tele-Antig: 봇 토큰이 설정되지 않았습니다.',
      'Set Token'
    );
    if (action === 'Set Token') {
      await vscode.commands.executeCommand('teleAntig.setToken');
    }
    return;
  }

  // 토큰 형식 기본 검사
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    const action = await vscode.window.showErrorMessage(
      'Tele-Antig: 저장된 토큰 형식이 올바르지 않습니다. @BotFather에서 받은 토큰을 다시 입력하세요.',
      'Set Token'
    );
    if (action === 'Set Token') {
      await vscode.commands.executeCommand('teleAntig.setToken');
    }
    return;
  }

  // 토큰 유효성 사전 검증 (네트워크 + API)
  outputChannel.show();
  outputChannel.appendLine('[Main] 토큰 검증 중...');
  const validation = await TelegramBot.validateToken(token);
  if (!validation.ok) {
    outputChannel.appendLine(`[Main] 토큰 검증 실패: ${validation.error}`);
    const action = await vscode.window.showErrorMessage(
      `Tele-Antig: ${validation.error.split('\n')[0]}`,
      'Test Token', 'Set Token'
    );
    if (action === 'Test Token') {
      await vscode.commands.executeCommand('teleAntig.testToken');
    } else if (action === 'Set Token') {
      await vscode.commands.executeCommand('teleAntig.setToken');
    }
    return;
  }

  outputChannel.appendLine(`[Main] 토큰 유효: ${validation.botName}`);

  const chatId = getAllowedChatId();
  if (!chatId) {
    const proceed = await vscode.window.showWarningMessage(
      `Tele-Antig: Chat ID 미설정. 봇(${validation.botName}) 시작 후 Telegram에서 /start 를 보내면 Chat ID가 표시됩니다.`,
      '계속',
      '취소'
    );
    if (proceed !== '계속') return;
  }

  outputChannel.appendLine(`[Main] Starting Tele-Antig (${validation.botName})...`);

  bridge = new AntigravityBridge(outputChannel);
  bot = new TelegramBot(token, bridge, outputChannel);

  try {
    await bot.start();
  } catch {
    bridge.dispose();
    bridge = undefined;
    bot = undefined;
  }
}

async function stopBot(): Promise<void> {
  if (bot) {
    await bot.stop();
    bot = undefined;
  }
  if (bridge) {
    bridge.dispose();
    bridge = undefined;
  }
}

export function deactivate() {
  if (bot) {
    bot.stop().catch(() => {});
  }
  if (bridge) {
    bridge.dispose();
  }
  if (outputChannel) {
    outputChannel.dispose();
  }
}
