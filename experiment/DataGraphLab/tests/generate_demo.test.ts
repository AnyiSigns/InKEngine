/**
 * demos/generate_demo 测试（D 表：main --n/--seed/--out，产 JSONL 行数==n）：
 * 临时目录落盘、行数、可读回（含与 store/teacher 的集成回环）、taskHash 稳定、
 * 失败退出码非 0、两种 style 均出现。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildTasks, loadDemoTasks, main, runGenerateDemo } from '../demos/generate_demo.js';
import { recordFromStep, append, load } from '../data/store.js';
import { oracleTrace } from '../teacher/oracle.js';
import { GRAPH } from '../runner/graph.js';
import { canonicalJson } from '../world/hash.js';
import { taskHash, type Task } from '../schema.js';

const tmpRoots: string[] = [];
function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dgl-demo-'));
  tmpRoots.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpRoots.length > 0) rmSync(tmpRoots.pop()!, { recursive: true, force: true });
});

describe('demos/generate_demo（main --n --seed --out）', () => {
  it('成功路径：退出码 0、行数==n、每行可 parse 且 taskHash 稳定可复算', () => {
    const dir = tmpRoot();
    const file = join(dir, 'demo_tasks.jsonl');
    const code = main(['--n', '8', '--seed', '21', '--out', file]);
    expect(code).toBe(0);
    const text = readFileSync(file, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    const lines = text.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(8);
    for (const line of lines) {
      const parsed = JSON.parse(line) as Task;
      expect(canonicalJson(parsed)).toBe(line);
      expect(typeof taskHash(parsed)).toBe('string');
      expect(parsed.plan_hidden.length + 1).toBeGreaterThanOrEqual(2);
      expect(['follow', 'goal']).toContain(parsed.style);
    }
    const [firstAgain] = loadDemoTasks(file);
    expect(taskHash(firstAgain!)).toBe(taskHash(JSON.parse(lines[0]!) as Task));
  });

  it('buildTasks 确定：同 (n, seed) 两次逐字节相同；style 轮转覆盖两族', () => {
    const a = buildTasks(6, 101);
    const b = buildTasks(6, 101);
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    const c = buildTasks(6, 102);
    expect(canonicalJson(a)).not.toBe(canonicalJson(c));
    expect(new Set(a.map((t) => t.style))).toEqual(new Set(['follow', 'goal']));
    expect(new Set(a.map((t) => t.family)).size).toBeGreaterThanOrEqual(2);
  });

  it('集成回环：demo 任务 → oracleTrace → store append → load 按 split 完整读回', () => {
    const dir = tmpRoot();
    const file = join(dir, 'tasks.jsonl');
    const res = runGenerateDemo({ n: 6, seed: 7, out: file });
    expect(res.count).toBe(6);
    const tasks = loadDemoTasks(file);
    expect(tasks).toHaveLength(6);
    const runs = join(dir, 'runs');
    const records = tasks.flatMap((t) => oracleTrace(t, GRAPH).map((s) => recordFromStep(t, s)));
    const appended = append(records, { outRoot: runs });
    expect(appended.appended).toBe(records.length);
    const back = ['train', 'val', 'heldout'].flatMap((sp) => load(sp as Task['split'], { outRoot: runs }));
    expect(back).toHaveLength(records.length);
  });

  it('失败路径：n 非法 → main 返回非 0 且不写文件', () => {
    const dir = tmpRoot();
    const file = join(dir, 'nope.jsonl');
    expect(main(['--n', '0', '--seed', '1', '--out', file])).not.toBe(0);
    expect(main(['--n', 'abc', '--seed', '1', '--out', file])).not.toBe(0);
    expect(main(['--n', '-3', '--out', file])).not.toBe(0);
    expect(() => runGenerateDemo({ n: 0, seed: 1, out: file })).toThrow();
  });

  it('runGenerateDemo 覆盖写：二次调用行数仍==n', () => {
    const dir = tmpRoot();
    const file = join(dir, 'again.jsonl');
    runGenerateDemo({ n: 3, seed: 5, out: file });
    const second = runGenerateDemo({ n: 3, seed: 5, out: file });
    expect(second.count).toBe(3);
    expect(readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0)).toHaveLength(3);
  });
});
