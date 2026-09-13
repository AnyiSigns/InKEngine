/**
 * verify:unload S0 失败用例（faces.logic 契约）——临时夹具根 + `--root` 注入：
 * 合法 logic face 对照组 PASS；缺默认导出 / effects 越界 / entry 逃逸三类违规各被
 * 拒绝。夹具在 OS 临时目录构建（mkdtemp），跑完清理，不污染 plugins/ 真源。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGINS_ROOT = join(HERE, '..');

const KINDS = {
  kinds: [
    { kind: 'tool', dir: 'tools' },
    { kind: 'mcp', dir: 'mcp' },
    { kind: 'command', dir: 'commands' },
    { kind: 'ui_feature', dir: 'ui_features' },
    { kind: 'endpoint', dir: 'endpoints' },
  ],
};

/** 在临时目录搭一个插件夹具根，返回根路径。自动补一个最小 ui_feature 装配入口
 *  （auditUiReachability 要求 ≥1 isUiEntry 插件；root.$ref 引自身，不参与可达性）。 */
function makeFixtureRoot(plugins: Array<{ id: string; dir: string; spec: Record<string, unknown>; logicFile?: string }>): string {
  const root = mkdtempSync(join(tmpdir(), 'ink-verify-unload-'));
  for (const { dir } of KINDS.kinds) mkdirSync(join(root, dir), { recursive: true });
  const uiEntry = {
    id: 'inkling.ui',
    dir: 'ui_features/inkling.ui',
    spec: { id: 'inkling.ui', kind: 'ui_feature', capability: 'host_tool', data: { root: { $ref: 'self' } } },
  };
  const allPlugins = [...plugins, uiEntry];
  for (const plugin of allPlugins) {
    const pluginDir = join(root, plugin.dir);
    mkdirSync(join(pluginDir, 'faces', 'logic'), { recursive: true });
    writeFileSync(join(pluginDir, 'spec.json'), `${JSON.stringify(plugin.spec, null, 2)}\n`);
    if (plugin.logicFile !== undefined) {
      writeFileSync(join(pluginDir, 'faces', 'logic', 'index.ts'), plugin.logicFile);
    }
  }
  writeFileSync(join(root, 'kinds.json'), `${JSON.stringify(KINDS, null, 2)}\n`);
  writeFileSync(
    join(root, 'manifest.json'),
    `${JSON.stringify({ plugins: allPlugins.map((p) => ({ id: p.id, kind: p.spec.kind, dir: p.dir })) }, null, 2)}\n`,
  );
  return root;
}

function runVerify(root: string): { status: number; out: string } {
  try {
    const out = execFileSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/verify_unload.ts', '--root', root],
      { cwd: PLUGINS_ROOT, encoding: 'utf8' },
    );
    return { status: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, out: `${e.stdout ?? ''}\n${e.stderr ?? ''}` };
  }
}

function specOf(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    kind: 'tool',
    capability: 'external_tool',
    depends: [],
    actions: [],
    faces: { logic: { target: 'host', entry: './faces/logic/index.ts' } },
    data: { tool: { name: id, description: 's0 fixture' } },
    ...extra,
  };
}

const GOOD_LOGIC_FILE = `export default function createService(): { hello(): string } {\n  return { hello: () => 'hi' };\n}\n`;
const NO_EXPORT_FILE = `export function hello(): string {\n  return 'hi';\n}\n`;

const tmpRoots: string[] = [];

afterAll(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('verify:unload S0 faces.logic 契约失败用例（--root 夹具）', () => {
  it('合法 logic face（默认导出 = 统一工厂）全量审计 PASS', () => {
    const root = makeFixtureRoot([
      { id: 'good_logic', dir: 'tools/good_logic', spec: specOf('good_logic'), logicFile: GOOD_LOGIC_FILE },
    ]);
    tmpRoots.push(root);
    const { status, out } = runVerify(root);
    expect(status).toBe(0);
    expect(out).toContain('verify:unload PASS');
  });

  it('logic entry 缺默认导出被拒（S0 装载协议）', () => {
    const root = makeFixtureRoot([
      { id: 'good_logic', dir: 'tools/good_logic', spec: specOf('good_logic'), logicFile: GOOD_LOGIC_FILE },
      { id: 'no_export', dir: 'tools/no_export', spec: specOf('no_export'), logicFile: NO_EXPORT_FILE },
    ]);
    tmpRoots.push(root);
    const { status, out } = runVerify(root);
    expect(status).toBe(1);
    expect(out).toContain('faces.logic entry 缺默认导出');
    expect(out).toContain('no_export');
  });

  it('contract.effects 越界端口被拒（effects ⊆ 端口词表）', () => {
    const root = makeFixtureRoot([
      { id: 'good_logic', dir: 'tools/good_logic', spec: specOf('good_logic'), logicFile: GOOD_LOGIC_FILE },
      { id: 'bad_effects', dir: 'tools/bad_effects', spec: specOf('bad_effects', { contract: { effects: ['bogus_port'] } }) },
    ]);
    tmpRoots.push(root);
    const { status, out } = runVerify(root);
    expect(status).toBe(1);
    expect(out).toContain('contract.effects 未登记端口: bogus_port');
  });

  it('logic entry 越界逃逸被拒（entry 须为插件目录内相对路径）', () => {
    const root = makeFixtureRoot([
      { id: 'good_logic', dir: 'tools/good_logic', spec: specOf('good_logic'), logicFile: GOOD_LOGIC_FILE },
      {
        id: 'escape_entry',
        dir: 'tools/escape_entry',
        spec: specOf('escape_entry', { faces: { logic: { target: 'host', entry: '../escape.ts' } } }),
      },
    ]);
    tmpRoots.push(root);
    const { status, out } = runVerify(root);
    expect(status).toBe(1);
    expect(out).toContain('faces.logic entry 越界');
  });

  it('三违规同批全被点名（fail-closed 不放过任何一类）', () => {
    const root = makeFixtureRoot([
      { id: 'good_logic', dir: 'tools/good_logic', spec: specOf('good_logic'), logicFile: GOOD_LOGIC_FILE },
      { id: 'no_export', dir: 'tools/no_export', spec: specOf('no_export'), logicFile: NO_EXPORT_FILE },
      { id: 'bad_effects', dir: 'tools/bad_effects', spec: specOf('bad_effects', { contract: { effects: ['bogus_port'] } }) },
      {
        id: 'escape_entry',
        dir: 'tools/escape_entry',
        spec: specOf('escape_entry', { faces: { logic: { target: 'host', entry: '../escape.ts' } } }),
      },
    ]);
    tmpRoots.push(root);
    const { status, out } = runVerify(root);
    expect(status).toBe(1);
    expect(out).toContain('faces.logic entry 缺默认导出');
    expect(out).toContain('contract.effects 未登记端口: bogus_port');
    expect(out).toContain('faces.logic entry 越界');
  });
});
