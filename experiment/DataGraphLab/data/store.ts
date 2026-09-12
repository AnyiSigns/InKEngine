/**
 * 内容寻址 JSONL 分片存储：append-only、按 (world_version, split, family) 分片。
 *
 * 持久资产存原始 obs——这是本文件的定位：`records.jsonl` 只写 F.2 记录格式
 * `{style, family, instruction, x, state:{answer, verdict}, hist, candidates,
 * target, meta}` 的原始值；特征派生（稀疏 `records.bin`、OBS_DIM 编码）是后续
 * featurize 单元的事，改了特征代码不必重生成数据。meta 是审计面（hash/dedupe
 * 用），不是控制器可见面：只放 task_hash/step_index/split/composition_id/
 * plan_hash 等派生指纹与 `teacher` 坐标，`expected`/`spec`/`plan_hidden` 原值
 * 绝无写入路径（obs 面经 `obsSnapshot` 白名单投影）。
 *
 * 序列化纪律：每行用 `canonicalJson` 规范序列化（键序稳定，禁 `JSON.stringify`
 * 默认序）；行内容自带 `meta.c_hash`（内容 hash，写入前重算保证寻址正确）。
 * 两级去重口径唯一（§6）：任务级 = C.1 六元组 `(style, composition_id,
 * instruction, x, expected, plan_hash)`；步级 = `(task_hash, step_index,
 * observation, action)`——含 `task_hash` 才避免跨任务误并；`observation` 用
 * `hashObj` 稳定规范序列化。外部边界（读回的行）先过 `data/store_schema.ts` 的
 * 四层校验（字段/类型/meta 坐标、style/family 值域、`meta.c_hash` 重算复核），
 * 不一致 fail-fast、报错含 `分片#行号`，不静默降级。默认根 `runs/` 已被
 * gitignore；测试请注入临时目录。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { obsSnapshot, type State } from '../world/operators.js';
import { canonicalJson, hashObj } from '../world/hash.js';
import { worldVersion } from '../world/version.js';
import { taskHash, type Family, type Split, type Step, type Style, type Task } from '../schema.js';
import { SPLIT_VALUES, parseLine, verifyForLoad, withContentHash } from './store_schema.js';

// 内容寻址写侧公式在 store_schema.ts 单一实现，这里只透出 API（禁第二份）。
export { withContentHash } from './store_schema.js';

/** F.2 原始 obs 记录（一步 = 一条）；`target` 为该步动作（算子 id 或 exit）。 */
export interface StoreRecord {
  readonly style: Style;
  readonly family: Family;
  readonly instruction: string;
  readonly x: number | string;
  readonly state: { readonly answer: unknown; readonly verdict: unknown };
  readonly hist: readonly string[];
  readonly candidates: readonly string[];
  readonly target: string;
  readonly meta: Readonly<Record<string, unknown>>;
}

export interface AppendOptions {
  readonly outRoot?: string;
  /** meta 未带 world_version 时的兜底（默认当前 worldVersion）。 */
  readonly worldVersion?: string;
  /** meta 未带 split 时的兜底（两者皆缺即 fail-fast）。 */
  readonly split?: Split;
}

export interface LoadOptions {
  readonly outRoot?: string;
  /** 仅装载该世界版本的分片（缺省装载全部）。 */
  readonly worldVersion?: string;
}

export interface AppendResult {
  readonly appended: number;
  readonly skippedDuplicate: number;
  /** 本批写入涉及的分片路径（相对 outRoot）。 */
  readonly shards: readonly string[];
}

interface ShardIndexEntry {
  readonly world_version: string;
  readonly split: Split;
  readonly family: Family;
  readonly file: string;
  readonly count: number;
}

const RECORDS_SUBDIR = 'records';
const INDEX_NAME = 'index.json';

function pkgRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/** 缺省持久根：包内 `runs/`（gitignore 覆盖，运行产物不入库）。 */
export function defaultOutRoot(): string {
  return join(pkgRoot(), 'runs');
}

/** oracle 一步 → F.2 记录：obs 走白名单投影，meta 只带派生指纹与切分坐标。 */
export function recordFromStep(
  task: Task,
  step: Step,
  extraMeta?: Readonly<Record<string, unknown>>,
): StoreRecord {
  const obs = obsSnapshot(step.obs as unknown as State);
  const rec: StoreRecord = {
    style: task.style,
    family: task.family,
    instruction: task.instruction,
    x: obs.x as number | string,
    state: { answer: obs.answer, verdict: obs.verdict },
    hist: [...obs.hist],
    candidates: [...step.candidates],
    target: step.action,
    meta: {
      task_hash: taskHash(task),
      step_index: step.step,
      split: task.split,
      composition_id: task.composition_id,
      plan_hash: task.plan_hash,
      world_version: worldVersion,
      teacher: 'oracle',
      ...(extraMeta ?? {}),
    },
  };
  return withContentHash(rec);
}

/** 任务级去重键（C.1 六元组）：`plan_hash` 必须单列——`task_hash` 不含 plan。 */
export function taskDedupKey(task: Task): string {
  return hashObj({
    style: task.style,
    composition_id: task.composition_id,
    instruction: task.instruction,
    x: task.x,
    expected: task.expected,
    plan_hash: task.plan_hash,
  });
}

/** 步级去重键：observation 用 `hashObj` 稳定规范序列化；含 task_hash 防跨任务误并。 */
export function stepDedupKey(rec: StoreRecord): string {
  const th = rec.meta.task_hash;
  const si = rec.meta.step_index;
  if (typeof th !== 'string' || typeof si !== 'number') {
    throw new Error('stepDedupKey: meta 缺 task_hash/step_index（步级去重键不可构造，fail-fast）');
  }
  return hashObj({
    task_hash: th,
    step_index: si,
    observation: hashObj({ x: rec.x, answer: rec.state.answer, verdict: rec.state.verdict, hist: [...rec.hist] }),
    action: rec.target,
  });
}

function isTask(item: Task | StoreRecord): item is Task {
  return Array.isArray((item as Task).plan_hidden);
}

/** 两级去重统一入口：Task[] 按六元组、StoreRecord[] 按步级四元组，均保留首现顺序。 */
export function dedup(items: readonly Task[]): Task[];
export function dedup(items: readonly StoreRecord[]): StoreRecord[];
export function dedup(items: readonly (Task | StoreRecord)[]): (Task | StoreRecord)[] {
  const seen = new Set<string>();
  const out: (Task | StoreRecord)[] = [];
  for (const item of items) {
    const key = isTask(item) ? taskDedupKey(item) : stepDedupKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

interface Coords {
  readonly wv: string;
  readonly split: Split;
  readonly family: Family;
}

function resolveCoords(rec: StoreRecord, opts: AppendOptions): Coords {
  const wv =
    typeof rec.meta.world_version === 'string' ? rec.meta.world_version : opts.worldVersion ?? worldVersion;
  const sp = typeof rec.meta.split === 'string' ? rec.meta.split : opts.split;
  if (sp === undefined || !SPLIT_VALUES.includes(sp)) {
    throw new Error(
      `append: 记录无法解析 split/world_version（meta 与 opts 均缺或非法，fail-fast）；world_version=${wv}`,
    );
  }
  return { wv, split: sp as Split, family: rec.family };
}

function shardPath(outRoot: string, c: Coords): string {
  return join(outRoot, RECORDS_SUBDIR, c.wv, c.split, `${c.family}.jsonl`);
}

function shardCoords(wv: string, split: string, family: string): Coords {
  return { wv, split: split as Split, family: family as Family };
}

function listShardFiles(outRoot: string, opts: LoadOptions): Array<{ file: string } & Coords> {
  const recordsDir = join(outRoot, RECORDS_SUBDIR);
  if (!existsSync(recordsDir)) return [];
  const out: Array<{ file: string } & Coords> = [];
  for (const wv of readdirSync(recordsDir).sort()) {
    const wvDir = join(recordsDir, wv);
    // 分片目录 = world_version 目录；index.json 等散文件直接跳过。
    if (!isDir(wvDir)) continue;
    if (opts.worldVersion !== undefined && wv !== opts.worldVersion) continue;
    for (const sp of readdirSync(wvDir).sort()) {
      if (!SPLIT_VALUES.includes(sp)) continue;
      const spDir = join(wvDir, sp);
      if (!isDir(spDir)) continue;
      for (const fam of readdirSync(spDir).sort()) {
        if (!fam.endsWith('.jsonl')) continue;
        out.push({ file: join(spDir, fam), ...shardCoords(wv, sp, fam.slice(0, -'.jsonl'.length)) });
      }
    }
  }
  return out;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 分片索引：按 (world_version, split, family) 记录条数；每次 append 后由盘上实况重建。 */
export function shardIndex(outRoot: string = defaultOutRoot()): ShardIndexEntry[] {
  const entries: ShardIndexEntry[] = [];
  for (const s of listShardFiles(outRoot, {})) {
    const count = readFileSync(s.file, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0).length;
    entries.push({
      world_version: s.wv,
      split: s.split,
      family: s.family,
      file: relative(outRoot, s.file),
      count,
    });
  }
  return entries;
}

function rebuildIndex(outRoot: string): void {
  // index.json 是盘上实况的派生便捷件，键序为字面量固定序（外部消费者只做查表）。
  const doc = { schema: 1, entries: shardIndex(outRoot) };
  writeFileSync(join(outRoot, RECORDS_SUBDIR, INDEX_NAME), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

/** 追加写分片（append-only）：按步级键对盘上既有与本批内部双重去重，跳过重复。 */
export function append(records: readonly StoreRecord[], opts: AppendOptions = {}): AppendResult {
  const outRoot = opts.outRoot ?? defaultOutRoot();
  const groups = new Map<string, StoreRecord[]>();
  for (const rec of records) {
    const finalRec = withContentHash(rec);
    const file = shardPath(outRoot, resolveCoords(finalRec, opts));
    const g = groups.get(file);
    if (g === undefined) groups.set(file, [finalRec]);
    else g.push(finalRec);
  }
  let appended = 0;
  let skippedDuplicate = 0;
  const shards: string[] = [];
  for (const [file, g] of new Map([...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1)))) {
    const existing = new Set<string>();
    if (existsSync(file)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .forEach((l, i) => existing.add(stepDedupKey(parseLine(l, `${relative(outRoot, file)}#${String(i)}`))));
    }
    const fresh: string[] = [];
    for (const rec of g) {
      const key = stepDedupKey(rec);
      if (existing.has(key)) {
        skippedDuplicate++;
        continue;
      }
      existing.add(key);
      fresh.push(canonicalJson(rec));
      appended++;
    }
    if (fresh.length > 0) {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, fresh.map((l) => `${l}\n`).join(''), 'utf8');
    }
    shards.push(relative(outRoot, file));
  }
  if (appended > 0) rebuildIndex(outRoot);
  return { appended, skippedDuplicate, shards };
}

/** 按 split 装载（跨 world_version/family，确定性排序）；schema + 值域 + c_hash 逐行复核。 */
export function load(split: Split, opts: LoadOptions = {}): StoreRecord[] {
  if (!SPLIT_VALUES.includes(split)) throw new Error(`load: 非法 split ${String(split)}`);
  const outRoot = opts.outRoot ?? defaultOutRoot();
  const out: StoreRecord[] = [];
  for (const s of listShardFiles(outRoot, opts)) {
    if (s.split !== split) continue;
    const lines = readFileSync(s.file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim().length === 0) continue;
      const where = `${relative(outRoot, s.file)}#${String(i)}`;
      const rec = verifyForLoad(parseLine(line, where), where);
      if (rec.meta.split !== split) {
        throw new Error(`store schema: 分片 ${s.split} 内发现 meta.split=${String(rec.meta.split)}（索引错位）`);
      }
      out.push(rec);
    }
  }
  return out;
}
