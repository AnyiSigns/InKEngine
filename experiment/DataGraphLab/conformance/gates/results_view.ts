/**
 * C.8 scaling 产物（`runs/scale-<stamp>/results.json`）的共享只读视图（G1.2/G1.3 同一
 * 契约，读取逻辑只此一实现、禁各门禁复制）。长表行形状钉死为与 scale 侧同源契约：
 * `{N, seed, style, arm, metric, value, ci_lo, ci_hi, n}`；arm ∈ heuristic/random/
 * contract_route/trained（follow）与 random/planner/contract_route/trained（goal），
 * metric ∈ pass1/path_excess/steps_over_shortest/routing_acc/safe_action_conflict_rate。
 * 校验只查判定必需的六字段（N/seed/style/arm/metric/value），CI 列缺席不视为破坏；
 * 任何非法行 fail-fast 抛错（错误数据不许静默进门禁）。`meanBy` 为种子均值口径
 * （C.8 均值±std 同源）；切片缺失返回 undefined——判不判失败由调用门禁决定，
 * 本文件不预设意图。
 */

export interface ResultsRow {
  readonly N: number;
  readonly seed: number;
  readonly style: string;
  readonly arm: string;
  readonly metric: string;
  readonly value: number;
}

export interface ResultsFile {
  readonly meta: Record<string, unknown>;
  readonly rows: readonly ResultsRow[];
}

/** 判定切片 = (N, style, arm, metric) 四元组，seed 方向聚合成均值。 */
export interface RowSlice {
  readonly N: number;
  readonly style: string;
  readonly arm: string;
  readonly metric: string;
}

function bad(row: unknown, i: number): Error {
  return new Error(`results.json rows[${String(i)}] 非法（判定必需字段缺失/类型不符）: ${JSON.stringify(row)}`);
}

/** 解析并校验整个 results.json；文件缺失/JSON 破坏/坏行都抛带定位信息的错误。 */
export function loadResultsFile(path: string, readText: (p: string) => string): ResultsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readText(path));
  } catch (err) {
    throw new Error(`results.json 无法解析（${path}）: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed === null || typeof parsed !== 'object') throw bad(parsed, -1);
  const obj = parsed as { meta?: unknown; rows?: unknown };
  if (!Array.isArray(obj.rows)) throw new Error(`results.json 缺 rows 长表（${path}）`);
  const rows: ResultsRow[] = [];
  for (let i = 0; i < obj.rows.length; i++) {
    const r = obj.rows[i] as Record<string, unknown>;
    if (
      r === null || typeof r !== 'object' ||
      typeof r.N !== 'number' || !Number.isFinite(r.N) ||
      typeof r.seed !== 'number' || !Number.isFinite(r.seed) ||
      typeof r.style !== 'string' || typeof r.arm !== 'string' || typeof r.metric !== 'string' ||
      typeof r.value !== 'number' || !Number.isFinite(r.value)
    ) {
      throw bad(obj.rows[i], i);
    }
    rows.push({ N: r.N, seed: r.seed, style: r.style, arm: r.arm, metric: r.metric, value: r.value });
  }
  const meta = obj.meta !== null && typeof obj.meta === 'object' ? (obj.meta as Record<string, unknown>) : {};
  return { meta, rows };
}

function matches(row: ResultsRow, slice: RowSlice): boolean {
  return row.N === slice.N && row.style === slice.style && row.arm === slice.arm && row.metric === slice.metric;
}

/** 切片跨 seed 均值（C.8 报告口径）；无匹配行返回 undefined。 */
export function meanBy(file: ResultsFile, slice: RowSlice): number | undefined {
  const hit = file.rows.filter((r) => matches(r, slice));
  if (hit.length === 0) return undefined;
  return hit.reduce((s, r) => s + r.value, 0) / hit.length;
}

/** 切片覆盖到的 seed 集合（升序去重），供 GateResult.seeds 如实记录。 */
export function seedsBy(file: ResultsFile, slice: RowSlice): number[] {
  return [...new Set(file.rows.filter((r) => matches(r, slice)).map((r) => r.seed))].sort((a, b) => a - b);
}

/** 某 style 全部行里实际出现的臂名（去重、字典序），G1.3 齐全性判定与证据共用。 */
export function armsByStyle(file: ResultsFile, style: string): string[] {
  return [...new Set(file.rows.filter((r) => r.style === style).map((r) => r.arm))].sort();
}
