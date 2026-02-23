import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Antigravity 내부 명령 탐색기
 * Antigravity에서 실행하여 에이전트 관련 API를 발견한다.
 */

const AGENT_KEYWORDS = [
  'agent', 'chat', 'manager', 'jetski', 'antigravity',
  'session', 'conversation', 'cascade', 'prompt', 'gemini',
  'send', 'message', 'brain', 'sidecar'
];

export async function exploreCommands(output: vscode.OutputChannel): Promise<void> {
  output.appendLine('=== Antigravity 내부 명령 탐색 시작 ===\n');

  // 1. 모든 등록된 명령 수집
  output.appendLine('--- [1] 등록된 모든 명령 (에이전트/채팅 관련 필터) ---');
  const allCommands = await vscode.commands.getCommands(true);
  const filtered = allCommands.filter(cmd => {
    const lower = cmd.toLowerCase();
    return AGENT_KEYWORDS.some(kw => lower.includes(kw));
  });

  output.appendLine(`총 명령 수: ${allCommands.length}`);
  output.appendLine(`에이전트 관련 명령: ${filtered.length}\n`);

  // 카테고리별로 그룹핑
  const groups: Record<string, string[]> = {};
  for (const cmd of filtered) {
    const prefix = cmd.split('.').slice(0, 2).join('.');
    if (!groups[prefix]) {
      groups[prefix] = [];
    }
    groups[prefix].push(cmd);
  }

  for (const [prefix, cmds] of Object.entries(groups).sort()) {
    output.appendLine(`[${prefix}] (${cmds.length}개)`);
    for (const cmd of cmds.sort()) {
      output.appendLine(`  - ${cmd}`);
    }
    output.appendLine('');
  }

  // 2. 모든 antigravity.* 명령 (키워드 필터 없이)
  output.appendLine('--- [2] antigravity.* 전체 명령 ---');
  const antigravityCmds = allCommands.filter(cmd => cmd.startsWith('antigravity.'));
  for (const cmd of antigravityCmds.sort()) {
    output.appendLine(`  ${cmd}`);
  }
  output.appendLine(`\n총 ${antigravityCmds.length}개\n`);

  output.appendLine('=== 명령 탐색 완료 ===');
}

export async function exploreExtensions(output: vscode.OutputChannel): Promise<void> {
  output.appendLine('=== 설치된 확장 프로그램 분석 ===\n');

  for (const ext of vscode.extensions.all) {
    const id = ext.id.toLowerCase();
    if (AGENT_KEYWORDS.some(kw => id.includes(kw)) || id.includes('google')) {
      output.appendLine(`[${ext.id}]`);
      output.appendLine(`  이름: ${ext.packageJSON?.displayName || 'N/A'}`);
      output.appendLine(`  활성: ${ext.isActive}`);
      output.appendLine(`  경로: ${ext.extensionPath}`);

      // contributes.commands 확인
      const commands = ext.packageJSON?.contributes?.commands;
      if (commands && Array.isArray(commands)) {
        output.appendLine(`  명령어:`);
        for (const cmd of commands) {
          output.appendLine(`    - ${cmd.command}: ${cmd.title || ''}`);
        }
      }

      // exports 확인
      if (ext.isActive && ext.exports) {
        output.appendLine(`  Exports: ${JSON.stringify(Object.keys(ext.exports))}`);
      }

      output.appendLine('');
    }
  }

  output.appendLine('=== 확장 분석 완료 ===');
}

export async function exploreLmModels(output: vscode.OutputChannel): Promise<void> {
  output.appendLine('=== Language Model API 탐색 ===\n');

  try {
    // vscode.lm API 존재 여부 확인
    if (typeof vscode.lm === 'undefined') {
      output.appendLine('❌ vscode.lm API가 존재하지 않습니다.');
      return;
    }

    output.appendLine('✅ vscode.lm API 존재 확인');

    // selectChatModels 사용 가능 여부
    if (typeof vscode.lm.selectChatModels === 'function') {
      output.appendLine('✅ vscode.lm.selectChatModels 함수 존재');

      // 모든 모델 조회
      try {
        const models = await vscode.lm.selectChatModels({});
        output.appendLine(`\n사용 가능한 모델: ${models.length}개`);
        for (const model of models) {
          output.appendLine(`  - ID: ${model.id}`);
          output.appendLine(`    Name: ${model.name}`);
          output.appendLine(`    Vendor: ${model.vendor}`);
          output.appendLine(`    Family: ${model.family}`);
          output.appendLine(`    Version: ${model.version}`);
          output.appendLine(`    Max Input Tokens: ${model.maxInputTokens}`);
          output.appendLine('');
        }
      } catch (e: any) {
        output.appendLine(`모델 조회 에러: ${e.message}`);
      }

      // 특정 vendor로 조회
      for (const vendor of ['copilot', 'google', 'antigravity', 'gemini']) {
        try {
          const models = await vscode.lm.selectChatModels({ vendor });
          if (models.length > 0) {
            output.appendLine(`Vendor '${vendor}': ${models.length}개 모델 발견`);
            for (const m of models) {
              output.appendLine(`  - ${m.id} (${m.family})`);
            }
          }
        } catch {
          // ignore
        }
      }
    } else {
      output.appendLine('❌ vscode.lm.selectChatModels 함수 없음');
    }
  } catch (e: any) {
    output.appendLine(`LM API 탐색 에러: ${e.message}`);
  }

  output.appendLine('\n=== LM API 탐색 완료 ===');
}

export async function testChatSend(output: vscode.OutputChannel): Promise<void> {
  output.appendLine('=== Chat Send 테스트 ===\n');

  // antigravity 채팅 관련 명령 테스트
  const chatCommands = [
    'antigravity.prioritized.chat.open',
    'antigravity.prioritized.chat.openNewConversation',
    'antigravity.toggleChatFocus',
    'antigravity.openConversationPicker',
  ];

  for (const cmd of chatCommands) {
    try {
      output.appendLine(`시도: ${cmd}`);
      // 명령이 존재하는지만 확인 (실행하지 않음)
      const allCmds = await vscode.commands.getCommands(true);
      const exists = allCmds.includes(cmd);
      output.appendLine(`  존재: ${exists}`);
    } catch (e: any) {
      output.appendLine(`  에러: ${e.message}`);
    }
  }

  // google.antigravity 확장의 exports 확인
  output.appendLine('\n--- google.antigravity 확장 API 분석 ---');
  const antigravityExt = vscode.extensions.getExtension('google.antigravity');
  if (antigravityExt) {
    output.appendLine(`발견: ${antigravityExt.id}`);
    output.appendLine(`활성: ${antigravityExt.isActive}`);

    if (!antigravityExt.isActive) {
      output.appendLine('확장 활성화 시도 중...');
      try {
        await antigravityExt.activate();
        output.appendLine('활성화 성공');
      } catch (e: any) {
        output.appendLine(`활성화 실패: ${e.message}`);
      }
    }

    if (antigravityExt.exports) {
      output.appendLine(`\nExports 키: ${JSON.stringify(Object.keys(antigravityExt.exports))}`);

      // exports의 각 키의 타입 확인
      for (const [key, value] of Object.entries(antigravityExt.exports)) {
        const type = typeof value;
        if (type === 'function') {
          output.appendLine(`  ${key}: function (${(value as Function).length} args)`);
        } else if (type === 'object' && value !== null) {
          output.appendLine(`  ${key}: object { ${Object.keys(value as object).join(', ')} }`);
        } else {
          output.appendLine(`  ${key}: ${type} = ${String(value)}`);
        }
      }
    } else {
      output.appendLine('Exports: 없음 (null/undefined)');
    }
  } else {
    output.appendLine('google.antigravity 확장을 찾을 수 없음');

    // 다른 ID로 시도
    for (const id of ['antigravity', 'Google.antigravity', 'google.antigravity']) {
      const ext = vscode.extensions.getExtension(id);
      if (ext) {
        output.appendLine(`대안 발견: ${ext.id}`);
      }
    }
  }

  // Antigravity 설치 경로에서 내부 확장 분석
  output.appendLine('\n--- Antigravity 내부 확장 경로 확인 ---');
  const possiblePaths = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity', 'resources', 'app', 'extensions', 'antigravity'),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      output.appendLine(`경로 존재: ${p}`);
      const pkgPath = path.join(p, 'package.json');
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          output.appendLine(`확장 이름: ${pkg.name}`);
          output.appendLine(`버전: ${pkg.version}`);
          output.appendLine(`메인: ${pkg.main}`);
          if (pkg.enabledApiProposals) {
            output.appendLine(`API Proposals: ${JSON.stringify(pkg.enabledApiProposals)}`);
          }
        } catch {}
      }
    }
  }

  output.appendLine('\n=== Chat Send 테스트 완료 ===');
}
