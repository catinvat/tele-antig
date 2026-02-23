import * as vscode from 'vscode';

const SECTION = 'teleAntig';

// SecretStorage 인스턴스 (extension.ts에서 초기화)
let secretStorage: vscode.SecretStorage | undefined;

export function initSecretStorage(context: vscode.ExtensionContext): void {
  secretStorage = context.secrets;
}

/**
 * 봇 토큰은 SecretStorage에 저장 (암호화됨, settings.json에 노출 안됨)
 */
export async function getBotToken(): Promise<string> {
  if (!secretStorage) return '';
  return (await secretStorage.get('botToken')) ?? '';
}

export async function setBotToken(token: string): Promise<void> {
  if (!secretStorage) throw new Error('SecretStorage not initialized');
  await secretStorage.store('botToken', token);
}

export async function deleteBotToken(): Promise<void> {
  if (!secretStorage) return;
  await secretStorage.delete('botToken');
}

/**
 * allowedChatId는 일반 설정에 저장 (민감하지 않음)
 */
export function getAllowedChatId(): string {
  return vscode.workspace.getConfiguration(SECTION).get<string>('allowedChatId', '');
}

export function getAutoStart(): boolean {
  return vscode.workspace.getConfiguration(SECTION).get<boolean>('autoStart', false);
}

export async function setAllowedChatId(chatId: string): Promise<void> {
  await vscode.workspace.getConfiguration(SECTION).update('allowedChatId', chatId, vscode.ConfigurationTarget.Global);
}
