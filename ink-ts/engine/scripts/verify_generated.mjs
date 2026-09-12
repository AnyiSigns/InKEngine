#!/usr/bin/env node
/**
 * contracts:verify —— 数据面生成物权威性校验（CODING §7「生成文件禁手改」的
 * 可执行口径）。
 *
 * 做法：把 engine/schemas + engine/fixtures + engine/scripts/generate.mjs
 * 复制到临时目录，用生成器重新生成 src/model/contracts/generated/*，再与仓库
 * 内生成物逐文件**归一化比较**（双方先把 \r\n → \n 归一，消除 checkout 行尾
 * 差异），一致才 PASS。不一致 = generated 被手改或生成器输出已漂移 → 列出
 * 差异行并以非零退出。fixture/schema 本体不参与比较（那是生成器的输入真源）。
 *
 * 可移植：Node 单文件实现，无 bash 依赖；Windows/CI 均以 `node` 直跑。
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, '..');
const REPO_GENERATED = join(ENGINE, 'src', 'model', 'contracts', 'generated');
const GENERATED_FILES = ['endpointTypes.ts', 'patchProtocol.ts', 'index.ts'];

/** 行尾归一（\r\n / \r → \n）；文本语义比较，忽略 checkout 行尾差异。 */
function normalize(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function firstDiffIndex(a, b) {
  const linesA = normalize(a).split('\n');
  const linesB = normalize(b).split('\n');
  const upto = Math.min(linesA.length, linesB.length);
  for (let i = 0; i < upto; i++) {
    if (linesA[i] !== linesB[i]) return i + 1;
  }
  if (linesA.length !== linesB.length) return upto + 1;
  return -1;
}

const tmp = mkdtempSync(join(tmpdir(), 'ink-contracts-verify-'));
try {
  cpSync(join(ENGINE, 'schemas'), join(tmp, 'schemas'), { recursive: true });
  cpSync(join(ENGINE, 'fixtures'), join(tmp, 'fixtures'), { recursive: true });
  mkdirSync(join(tmp, 'scripts'), { recursive: true });
  copyFileSync(join(ENGINE, 'scripts', 'generate.mjs'), join(tmp, 'scripts', 'generate.mjs'));

  const run = spawnSync(process.execPath, ['scripts/generate.mjs'], {
    cwd: tmp,
    encoding: 'utf-8',
  });
  if (run.status !== 0) {
    console.error(`contracts:verify 重新生成失败（exit ${run.status}）:`);
    console.error(run.stderr || run.stdout);
    process.exitCode = 1;
  } else {
    let failed = false;
    for (const name of GENERATED_FILES) {
      const repoText = readFileSync(join(REPO_GENERATED, name), 'utf-8');
      const freshText = readFileSync(join(tmp, 'src', 'model', 'contracts', 'generated', name), 'utf-8');
      const diffAt = firstDiffIndex(repoText, freshText);
      if (diffAt < 0) continue;
      failed = true;
      const repoLines = normalize(repoText).split('\n');
      const freshLines = normalize(freshText).split('\n');
      console.error(`DIFF src/model/contracts/generated/${name}（首个差异行 ${diffAt}）:`);
      for (let i = Math.max(0, diffAt - 3); i < Math.min(repoLines.length, diffAt + 2); i++) {
        console.error(`  仓库   L${i + 1}: ${repoLines[i]}`);
      }
      for (let i = Math.max(0, diffAt - 3); i < Math.min(freshLines.length, diffAt + 2); i++) {
        console.error(`  重生成 L${i + 1}: ${freshLines[i]}`);
      }
    }
    if (failed) {
      console.error(
        'contracts:verify FAIL —— generated 与重生成产物不一致'
          + '（勿手改 generated；重跑 npm run contracts:generate 或修 engine/scripts/generate.mjs）',
      );
      process.exitCode = 1;
    } else {
      console.log(`contracts:verify PASS —— ${GENERATED_FILES.map((f) => `generated/${f}`).join(',')} 与重生成产物一致`);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
