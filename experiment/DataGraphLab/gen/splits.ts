/**
 * 骨架分层与切分（C.1 `_stratum`/`STRATA`/`_split_maps`/`split_of`）。
 *
 * 分层键 = 深度 × 是否含 cond 算子；层内切分先按 `_skelId` 排序，再以
 * `crc32(_skelId+'heldout')%5==0` 判定 heldout≈20%、剩余里 `%20==0` 判定
 * val≈5%，且每层保底 ≥1；层内骨架 <2 直接报错，不静默降级。train/heldout 的
 * 深度×cond 层分布来自同一 STRATA，按构造对齐（G0.5）。
 *
 * 引用方向刻意单向：本文件只依赖 gen/skeletons.ts（SKELETONS/_skelId），
 * gen/generator.ts 再 import 本文件取 STRATA/splitOf。切分映射由 SKELETONS
 * 派生、generator 的 instance/make 又要消费 splitOf，若双向 import 会在 ESM
 * 求值期触发 TDZ（generator 先加载时读到未初始化的 SKELETONS），故算法一律
 * 收在数据持有方。
 */

import { _skelId, SKELETONS, type Skel } from './skeletons.js';
import { crc32 } from '../world/hash.js';
import { emod } from '../world/operators.js';
import type { Split } from '../schema.js';

/** 分层键：`深度|是否含 cond`；单文件唯一口径，difficulty.ts 的课程调度复用。 */
export type StratumKey = string;

/** 层键排序：先深度后是否含 cond（plain 在前），对齐 Python 元组 (len, hasCond)。 */
export function compareStratum(a: StratumKey, b: StratumKey): number {
  const [la, ca] = a.split('|') as [string, string];
  const [lb, cb] = b.split('|') as [string, string];
  if (la !== lb) return Number(la) - Number(lb);
  return ca === cb ? 0 : ca === 'cond' ? 1 : -1;
}

/** C.1 `_stratum`：分层键 = 深度 × 是否含 cond 算子。 */
export function _stratum(sk: Skel): StratumKey {
  const hasCond = sk.plan.some((op) => op.startsWith('cond_'));
  return `${sk.plan.length}|${hasCond ? 'cond' : 'plain'}`;
}

/** 全骨架按层分组（保持 SKELETONS 的排序序）。 */
export const STRATA: ReadonlyMap<StratumKey, readonly Skel[]> = (() => {
  const m = new Map<StratumKey, Skel[]>();
  for (const sk of SKELETONS) {
    const k = _stratum(sk);
    const arr = m.get(k);
    if (arr === undefined) m.set(k, [sk]);
    else arr.push(sk);
  }
  return m;
})();

/**
 * C.1 `_split_maps`：每层 heldout≈20%、val≈5%，每层保底 ≥1；层内 <2 报错。
 * 入参可注入（默认用模块 STRATA），便于测试构造单骨架假层验证报错分支。
 */
export function _splitMaps(strata: ReadonlyMap<StratumKey, readonly Skel[]> = STRATA): {
  heldout: ReadonlySet<string>;
  val: ReadonlySet<string>;
} {
  const heldout = new Set<string>();
  const val = new Set<string>();
  for (const key of [...strata.keys()].sort(compareStratum)) {
    const ordered = [...(strata.get(key) ?? [])].sort((a, b) => _skelId(a).localeCompare(_skelId(b)));
    if (ordered.length < 2) {
      throw new Error(`stratum ${key} 骨架不足 2，无法切 train/heldout：请扩算子或降 MAX_REPEAT`);
    }
    const h = ordered.filter((sk) => emod(crc32(_skelId(sk) + 'heldout'), 5) === 0);
    const hFinal = h.length > 0 ? h : [ordered[0]!];
    for (const sk of hFinal) heldout.add(_skelId(sk));
    const rest = ordered.filter((sk) => !hFinal.includes(sk));
    const v = rest.filter((sk) => emod(crc32(_skelId(sk) + 'val'), 20) === 0);
    const vFinal = v.length > 0 ? v : [rest[0]!];
    for (const sk of vFinal) val.add(_skelId(sk));
  }
  return { heldout, val };
}

/** held-out / val 骨架注册表（composition_id 集合；两套与 train 零重叠）。 */
const _SPLIT_MAPS = _splitMaps();
export const HELDOUT_SKELETONS: ReadonlySet<string> = _SPLIT_MAPS.heldout;
export const VAL_SKELETONS: ReadonlySet<string> = _SPLIT_MAPS.val;

/** 骨架 → 切分归属（train/val/heldout），train/held-out 切分只看 composition_id。 */
export function splitOf(sk: Skel): Split {
  const id = _skelId(sk);
  if (HELDOUT_SKELETONS.has(id)) return 'heldout';
  if (VAL_SKELETONS.has(id)) return 'val';
  return 'train';
}
