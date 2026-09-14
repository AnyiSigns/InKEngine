/**
 * 门禁运行 manifest 落盘测试（run 目录自带版本 pin 证据）：`createGateContext`
 * 给定 runId 时即在 `runs/<run_id>/manifest.json` 落全员版本化快照 + inputs_hash，
 * 六字段全为非空 string、world_version 与 world/version 对齐、generator/acceptor
 * 取源码指纹而非缺省 'unknown'，且两次构造逐字节同一（确定性）。测试使用唯一 run
 * 目录并在收尾整体删除，不污染真实门禁 run；无 runId 不落盘在本文件直接断言
 * （调用前后 `runs/` 下 manifest.json 清单不变）。
 */

import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { acceptorSourceVersion, generatorSourceVersion, manifest } from '../data/provenance.js';
import { hashObj } from '../world/hash.js';
import { createGateContext } from '../conformance/gates/harness.js';
import { worldVersion } from '../world/version.js';

const RUN_ID = 'manifest-selfcheck';
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNS_ROOT = join(PKG_ROOT, 'runs');
const RUN_DIR = join(RUNS_ROOT, RUN_ID);
const MANIFEST_PATH = join(RUN_DIR, 'manifest.json');

/** runs/ 下全部 manifest.json 的相对路径清单（码点序），用于前后快照比对。 */
function manifestInventory(): string[] {
  if (!existsSync(RUNS_ROOT)) return [];
  return readdirSync(RUNS_ROOT, { recursive: true })
    .map((n) => String(n))
    .filter((n) => n.endsWith('manifest.json'))
    .sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
}

function readManifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Record<string, unknown>;
}

describe('门禁 run manifest（runs/<run_id>/manifest.json，全员版本化快照）', () => {
  afterAll(() => {
    rmSync(RUN_DIR, { recursive: true, force: true });
  });

  it('给定 runId：六字段 + inputs_hash 落盘，版本字段取源码指纹而非缺省', () => {
    const ctx = createGateContext({ runId: RUN_ID });
    expect(existsSync(MANIFEST_PATH)).toBe(true);
    const m = readManifest();
    for (const key of [
      'world_version',
      'generator_version',
      'acceptor_version',
      'teacher_pin',
      'controller_code_hash',
      'probe_hash',
      'inputs_hash',
    ]) {
      expect(typeof m[key], key).toBe('string');
      expect(((m[key] as string) ?? '').length, key).toBeGreaterThan(0);
    }
    expect(m.world_version).toBe(worldVersion);
    expect(m.generator_version).not.toBe('unknown');
    expect(m.acceptor_version).not.toBe('unknown');
    expect(m.inputs_hash).toBe(ctx.inputsHash);
    // 磁盘快照与源码指纹函数同源（唯一口径，非第二次实现）。
    expect(m.generator_version).toBe(generatorSourceVersion());
    expect(m.acceptor_version).toBe(acceptorSourceVersion());
  });

  it('确定性：两次构造落盘的 manifest 逐字节相同', () => {
    createGateContext({ runId: RUN_ID });
    const first = readFileSync(MANIFEST_PATH, 'utf8');
    createGateContext({ runId: RUN_ID });
    expect(readFileSync(MANIFEST_PATH, 'utf8')).toBe(first);
  });

  it('无 runId：不落盘——调用前后 runs/ 下 manifest 清单不变', () => {
    const before = manifestInventory();
    const ctx = createGateContext();
    expect(ctx.outDir).toBeUndefined();
    expect(manifestInventory()).toEqual(before);
  });

  it('源码指纹口径：hashObj 16 位十六进制；自调用逐字相同', () => {
    expect(generatorSourceVersion()).toMatch(/^[0-9a-f]{16}$/);
    expect(acceptorSourceVersion()).toMatch(/^[0-9a-f]{16}$/);
    expect(generatorSourceVersion()).toBe(generatorSourceVersion());
    expect(acceptorSourceVersion()).toBe(acceptorSourceVersion());
  });

  it('inputs_hash 绑定 generator/acceptor 源码指纹：版本漂移必须翻转 manifestHash（P1-B）', () => {
    const gv = generatorSourceVersion();
    const av = acceptorSourceVersion();
    const ctx = createGateContext();
    // 与 run 级 manifest.json 快照同参（非缺省 'unknown'）：口径唯一。
    expect(ctx.manifestHash).toBe(hashObj(manifest({ generatorVersion: gv, acceptorVersion: av })));
    expect(ctx.manifestHash).not.toBe(hashObj(manifest()));
    // 任一侧源码版本变化都翻转 manifestHash 与合成 inputs_hash——旧门禁结果不可复用。
    const flippedG = hashObj(manifest({ generatorVersion: 'drift', acceptorVersion: av }));
    const flippedA = hashObj(manifest({ generatorVersion: gv, acceptorVersion: 'drift' }));
    expect(flippedG).not.toBe(ctx.manifestHash);
    expect(flippedA).not.toBe(ctx.manifestHash);
    const inputsOf = (mh: string) => hashObj({ world_version: worldVersion, manifest_hash: mh, fixtures_hash: ctx.fixturesHash });
    expect(inputsOf(flippedG)).not.toBe(ctx.inputsHash);
    expect(inputsOf(flippedA)).not.toBe(ctx.inputsHash);
  });
});
