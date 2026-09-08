#!/usr/bin/env tsx
/**
 * 同步生成 web 命令面契约夹具（seed_data/web_command_surface.json）。
 *
 * 夹具为 web 侧命令面一致性测试的数据真源：把宿主方法面（@ink-ts/host
 * BRIDGE_METHODS）与 cli 扁平旧名别名面（legacy_aliases legacyAliasTable）
 * 落成单份 JSON 快照；renderer/test/shared/backend/contractMap.test.ts 读该
 * fixture 断言 web 现役 serve 命令面 ⊆ fixture（杜绝 -32601 回归）。
 *
 * 用途说明：本批不要求接入 CI 链（root npm test / self_check all 均不跑
 * 本脚本）；宿主侧增删方法/别名后重跑本脚本生成即可（--check 只校验不
 * 落盘，供评审/CI 后续接入）。
 *
 * 纪律：fixture 是生成物（禁手改）；数值/顺序以源码表为准，脚本只做
 * 结构拷贝与归一化输出（2 空格 JSON，确定性键序）。运行：tsx
 * self_check/scripts/sync_web_command_surface.ts [--check]。
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BRIDGE_METHODS } from '@ink-ts/host';
import { legacyAliasTable } from '../../hosts/cli/src/legacy_aliases.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SEED_ROOT = join(here, '..', '..', 'seed_data');
const FIXTURE = join(SEED_ROOT, 'web_command_surface.json');

const NOTE =
  'web 命令面一致性夹具（生成物）：bridge_methods = @ink-ts/host BRIDGE_METHODS，' +
  'legacy_alias_flats = cli legacyAliasTable() 扁平旧名（点分/别名面 = web 调用允许面）。' +
  '由 ink-ts/self_check/scripts/sync_web_command_surface.ts 生成（禁手改）；' +
  '宿主侧增删方法/别名后重跑生成。';

interface SurfaceFixture {
  version: number;
  note: string;
  bridge_methods: string[];
  legacy_alias_flats: string[];
}

function render(): string {
  const data: SurfaceFixture = {
    version: 1,
    note: NOTE,
    bridge_methods: [...BRIDGE_METHODS],
    legacy_alias_flats: legacyAliasTable().map(({ flat }) => flat),
  };
  return `${JSON.stringify(data, null, 2)}\n`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const rendered = render();
  if (check) {
    if (!(await fileExists(FIXTURE))) {
      console.error(`夹具缺失: ${FIXTURE}`);
      process.exitCode = 1;
      return;
    }
    const current = (await readFile(FIXTURE, 'utf8')).replace(/\r\n/g, '\n');
    if (current !== rendered) {
      console.error(
        `夹具漂移: ${FIXTURE} 与宿主方法面/别名面不一致（重跑 sync_web_command_surface.ts）`,
      );
      process.exitCode = 1;
      return;
    }
    console.log('夹具与宿主方法面/别名面一致');
    return;
  }
  await mkdir(SEED_ROOT, { recursive: true });
  await writeFile(FIXTURE, rendered, 'utf8');
  console.log(
    `已生成 ${relative(join(here, '..'), FIXTURE)}（bridge ${BRIDGE_METHODS.length} + alias ${legacyAliasTable().length}）`,
  );
}

void main();
