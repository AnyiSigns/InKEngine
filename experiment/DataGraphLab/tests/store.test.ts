/**
 * data/store 测试（§6 内容寻址 JSONL 分片 + D 表断言）：append/load 往返、
 * 两级去重（任务级 C.1 六元组 / 步级含 task_hash 四元组）、分片与索引按
 * (world_version, split, family)。全部落系统临时目录，afterEach 清理。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  append,
  dedup,
  load,
  recordFromStep,
  stepDedupKey,
  taskDedupKey,
  withContentHash,
  type StoreRecord,
} from '../data/store.js';
import { oracleTrace } from '../teacher/oracle.js';
import { makeTask } from '../gen/generator.js';
import { GRAPH } from '../runner/graph.js';
import { worldVersion } from '../world/version.js';
import { taskHash } from '../schema.js';
import { hashObj } from '../world/hash.js';
import type { Task } from '../schema.js';

const tmpRoots: string[] = [];
function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dgl-store-'));
  tmpRoots.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpRoots.length > 0) {
    const dir = tmpRoots.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function pool(style: 'follow' | 'goal' = 'follow', seeds = [1, 2, 5, 13]): Task[] {
  const out: Task[] = [];
  for (const seed of seeds) {
    const t = makeTask(seed, style, undefined, 'train');
    if (t !== null) out.push(t);
  }
  return out;
}

function recordsOf(tasks: readonly Task[]): StoreRecord[] {
  const out: StoreRecord[] = [];
  for (const t of tasks) {
    for (const step of oracleTrace(t, GRAPH)) out.push(recordFromStep(t, step));
  }
  return out;
}

function mkTask(overrides: Partial<Task> = {}): Task {
  return {
    style: 'follow',
    family: 'value',
    instruction: '起点值4。按顺序做：翻倍，随后提交',
    x: 4,
    spec: {},
    expected: 8,
    plan_hidden: ['mul2', 'submit'],
    root: 'Int',
    plan_hash: hashObj(['mul2', 'submit']),
    composition_id: 'skel-store-0',
    split: 'train',
    ...overrides,
  };
}

describe('data/store/recordFromStep + append/load 往返（F.2 记录格式）', () => {
  it('记录含 F.2 全字段且顶层绝不带 expected/spec/plan；obs 面走白名单', () => {
    const [t] = pool('follow', [3]);
    const recs = recordsOf([t!]);
    for (const r of recs) {
      expect(Object.keys(r).sort()).toEqual(
        ['candidates', 'family', 'hist', 'instruction', 'meta', 'state', 'style', 'target', 'x'],
      );
      expect(Object.keys(r.state).sort()).toEqual(['answer', 'verdict']);
      expect(typeof r.meta.task_hash).toBe('string');
      expect(r.meta.step_index).toBeTypeOf('number');
      expect(r.meta.plan_hash).toBe(t!.plan_hash);
      expect(r.meta.teacher).toBe('oracle');
      expect(r.meta.world_version).toBe(worldVersion);
      expect(typeof r.meta.c_hash).toBe('string');
    }
  });

  it('append → load 逐条等值往返；分片路径与索引按 (world_version, split, family)', () => {
    const root = tmpRoot();
    const recs = recordsOf(pool('follow', [1, 2]));
    const res = append(recs, { outRoot: root });
    expect(res.appended).toBe(recs.length);
    expect(res.skippedDuplicate).toBe(0);
    const back = load('train', { outRoot: root });
    expect(back).toEqual(recs);
    const shard = join(root, 'records', worldVersion, 'train', 'verify.jsonl');
    const anyFamilyFile = existsSync(shard) || existsSync(join(root, 'records', worldVersion, 'train', 'value.jsonl'));
    expect(anyFamilyFile).toBe(true);
    const index = JSON.parse(readFileSync(join(root, 'records', 'index.json'), 'utf8')) as {
      entries: Array<{ world_version: string; split: string; family: string; count: number }>;
    };
    for (const e of index.entries) {
      expect(e.world_version).toBe(worldVersion);
      expect(e.split).toBe('train');
    }
    const families = new Set(recs.map((r) => r.family));
    expect(new Set(index.entries.map((e) => e.family))).toEqual(families);
    expect(index.entries.reduce((a, e) => a + e.count, 0)).toBe(recs.length);
  });

  it('JSONL 每行键序稳定（canonical 序列化），二次 append 全量去重', () => {
    const root = tmpRoot();
    const recs = recordsOf(pool('follow', [1]));
    append(recs, { outRoot: root });
    const file = join(root, 'records', worldVersion, 'train', recs[0]!.family + '.jsonl');
    const line = readFileSync(file, 'utf8').split('\n')[0]!;
    expect(JSON.parse(line)).toEqual(recs[0]);
    const again = append(recs, { outRoot: root });
    expect(again.appended).toBe(0);
    expect(again.skippedDuplicate).toBe(recs.length);
    expect(load('train', { outRoot: root })).toHaveLength(recs.length);
  });

  it('按 split 装载隔离；未存在 split 返回空数组', () => {
    const root = tmpRoot();
    const trainRecs = recordsOf(pool('follow', [1]));
    const heldRecs = recordsOf(pool('goal', [31]).map((t) => ({ ...t })));
    append(trainRecs, { outRoot: root });
    const heldTasks = [makeTask(31, 'goal', 'goal', 'heldout')].filter((t): t is Task => t !== null);
    append(recordsOf(heldTasks), { outRoot: root });
    expect(load('train', { outRoot: root })).toHaveLength(trainRecs.length);
    const held = load('heldout', { outRoot: root });
    expect(held.length).toBeGreaterThan(0);
    expect(held.every((r) => r.meta.split === 'heldout')).toBe(true);
    expect(heldRecs.length).toBeGreaterThan(0);
    expect(load('val', { outRoot: root })).toEqual([]);
  });

  it('损坏行 fail-fast（schema 校验，不静默降级）', () => {
    const root = tmpRoot();
    const recs = recordsOf(pool('follow', [1]));
    append(recs, { outRoot: root });
    const file = join(root, 'records', worldVersion, 'train', recs[0]!.family + '.jsonl');
    writeFileSync(file, '{"style":"follow"}\n', 'utf8');
    expect(() => load('train', { outRoot: root })).toThrow(/schema|字段/);
  });

  it('split/world_version 缺参 fail-fast（外部边界不静默降级）', () => {
    const root = tmpRoot();
    const rec = recordsOf(pool('follow', [1]))[0]!;
    const stripped: StoreRecord = { ...rec, meta: { teacher: 'oracle' } };
    expect(() => append([stripped], { outRoot: root })).toThrow(/split|world_version/);
  });
});

describe('data/store/dedup（两级去重键，§6 唯一口径）', () => {
  it('任务级：C.1 六元组任一成员变化即不同键；重复任务合并', () => {
    const base = mkTask();
    expect(taskDedupKey(base)).toBe(taskDedupKey(mkTask()));
    const variants: Partial<Task>[] = [
      { style: 'goal' },
      { composition_id: 'other' },
      { instruction: '换个说法' },
      { x: 5 },
      { expected: 9 },
      { plan_hash: 'deadbeefdeadbeef' },
    ];
    const keys = new Set([taskDedupKey(base)]);
    for (const v of variants) {
      const k = taskDedupKey(mkTask(v));
      expect(k, JSON.stringify(v)).not.toBe(base === undefined ? '' : taskDedupKey(base));
      keys.add(k);
    }
    expect(keys.size).toBe(7);
    expect(dedup([base, mkTask(), mkTask({ x: 5 })])).toEqual([base, mkTask({ x: 5 })]);
  });

  it('任务级：同 taskHash 而 plan_hash 不同 → 不合并（步级键不能替代 plan_hash）', () => {
    const a = mkTask();
    const b = mkTask({
      plan_hidden: ['add3', 'add3', 'submit'],
      plan_hash: hashObj(['add3', 'add3', 'submit']),
    });
    expect(taskHash(a)).toBe(taskHash(b));
    expect(taskDedupKey(a)).not.toBe(taskDedupKey(b));
    expect(dedup([a, b])).toHaveLength(2);
  });

  it('步级：同任务同步同 obs 同 action 合并；obs 或 action 不同不合并', () => {
    const recs = recordsOf(pool('follow', [2]));
    const first = recs[0]!;
    expect(stepDedupKey(first)).toBe(stepDedupKey(withContentHash({ ...first })));
    expect(dedup([first, { ...first }])).toHaveLength(1);
    expect(dedup([first, { ...first, target: 'exit' }])).toHaveLength(2);
    expect(dedup([first, { ...first, state: { ...first.state, answer: '__z__' } }])).toHaveLength(2);
    expect(dedup([first, { ...first, hist: [...first.hist, '__z__'] }])).toHaveLength(2);
    const shifted = { ...first, meta: { ...first.meta, step_index: 99 } };
    expect(dedup([first, shifted])).toHaveLength(2);
  });

  it('跨任务：同 obs/action 但 task_hash 不同 → 不合并（步级键含 task_hash）', () => {
    const root = tmpRoot();
    const taskA = mkTask();
    const taskB = mkTask({
      instruction: '起点值4。按顺序做：翻倍，随后提交（变体）',
      composition_id: 'skel-store-B',
    });
    const [recA0] = recordsOf([taskA]);
    const [recB0] = recordsOf([taskB]);
    expect(recA0!.x).toBe(recB0!.x);
    expect(recA0!.target).toBe(recB0!.target);
    expect(stepDedupKey(recA0!)).not.toBe(stepDedupKey(recB0!));
    expect(dedup([recA0!, { ...recB0! }])).toHaveLength(2);
    const merged = append([recA0!, { ...recA0! }, { ...recB0! }], { outRoot: root });
    expect(merged.appended).toBe(2);
    expect(merged.skippedDuplicate).toBe(1);
    expect(load('train', { outRoot: root })).toHaveLength(2);
  });

  it('dedup 保序（首次出现保留）', () => {
    const recs = recordsOf(pool('goal', [31]));
    const dup = [recs[0]!, recs[1]!, { ...recs[0]! }];
    expect(dedup(dup)).toEqual([recs[0]!, recs[1]!]);
  });
});
