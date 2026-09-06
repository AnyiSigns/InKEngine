/**
 * capability 命令面（能力记录：推演档位等产品设置的读档/存档）。
 *
 * 语义对齐壳侧 capability 命令：get 只读 + 缺省字段注入（auto 审批字段
 * 出厂空集、simulation_tier 缺省全量——推演默认全开，档位收敛已取消；
 * 缺省只在响应注入、不落盘固化，显式写档才存档）；put 整体存储但按单字段
 * 并入（读既有 → 并入 → 校验 → 落盘），字段白名单校验失败不落盘。
 * TS host 各字段的引擎消费按各自域装配点接入（simulation_tier →
 * route/assembly 迁移消费；auto_approve_* → 审批策略接线）。
 */

import type {
  CapabilityRecord,
  CapabilityStore,
} from '../capability/store.js';
import {
  SIMULATION_TIERS,
  defaultCapabilityRecord,
  parseRecord,
} from '../capability/store.js';
import { BridgeError, type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 未装配 store 时的内存兜底（测试/最小装配语义与持久化形态一致）。 */
function ephemeralCapabilityStore(): CapabilityStore {
  let cached: CapabilityRecord = defaultCapabilityRecord();
  return {
    get: (): CapabilityRecord => cached,
    put: (patch: Record<string, unknown>): CapabilityRecord => {
      cached = parseRecord({ ...cached, ...patch });
      return cached;
    },
  };
}

/** 响应注入缺省字段（auto 出厂空集 + 推演档位缺省全量——推演默认全开，
 *  档位收敛已取消，仅在历史记录保留时回显）；不写库。 */
function withDefaults(record: Record<string, unknown>): Record<string, unknown> {
  const defaults = defaultCapabilityRecord();
  const out: Record<string, unknown> = { ...record };
  if (typeof out['simulation_tier'] !== 'string') out['simulation_tier'] = 'full';
  for (const [key, value] of Object.entries(defaults)) {
    if (out[key] === undefined) out[key] = value;
  }
  return out;
}

/** 单字段校验（任一字段值非法即抛 BridgeError，整体不落盘）。 */
function validatePatch(patch: Record<string, unknown>): void {
  if (patch['simulation_tier'] !== undefined) {
    const tier = patch['simulation_tier'];
    if (typeof tier !== 'string' || !(SIMULATION_TIERS as readonly string[]).includes(tier)) {
      throw new BridgeError(
        `simulation_tier 须为 ${SIMULATION_TIERS.join('/')}，收到 ${String(tier)}`,
        'invalid_params',
      );
    }
  }
  if (patch['max_tool_rounds'] !== undefined) {
    const value = patch['max_tool_rounds'];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 200) {
      throw new BridgeError('max_tool_rounds 须在 1..=200 之间', 'invalid_params');
    }
  }
  if (patch['auto_approve_all_review'] !== undefined) {
    if (typeof patch['auto_approve_all_review'] !== 'boolean') {
      throw new BridgeError('auto_approve_all_review 须为布尔', 'invalid_params');
    }
  }
  if (patch['auto_approve_tools'] !== undefined) {
    const tools = patch['auto_approve_tools'];
    if (
      !Array.isArray(tools)
      || !tools.every((entry): entry is string => typeof entry === 'string')
    ) {
      throw new BridgeError('auto_approve_tools 须为字符串清单', 'invalid_params');
    }
  }
  if (patch['tier_overrides'] !== undefined) {
    const overrides = patch['tier_overrides'];
    if (
      !isRecord(overrides)
      || !Object.values(overrides).every((value) => typeof value === 'string')
    ) {
      throw new BridgeError('tier_overrides 须为 工具名→档位 字符串映射', 'invalid_params');
    }
  }
}

export function buildCapabilityHandlers(
  deps: Pick<HostBridgeDeps, 'capability'>,
): ReadonlyMap<string, BridgeHandler> {
  const store: CapabilityStore = deps.capability ?? ephemeralCapabilityStore();

  const get: BridgeHandler = (): unknown => withDefaults({ ...store.get() });

  const put: BridgeHandler = async (raw): Promise<unknown> => {
    if (!isRecord(raw)) {
      throw new BridgeError('capability.put 需 params 记录对象', 'invalid_params');
    }
    const patch = Object.fromEntries(
      Object.entries(raw).filter(([, value]) => value !== undefined && value !== null),
    );
    validatePatch(patch);
    return store.put(patch);
  };

  return new Map<string, BridgeHandler>([
    ['capability.get', get],
    ['capability.put', put],
  ]);
}
