/**
 * 命令插件共享私有件（非插件：无 spec.json，生成器跳过；同 ports/_shared 先例）。
 * 本文件 = hosts/lib/src/bridge/capability.ts 原样迁入（S3 命令逻辑下沉，语义零改）。
 *
 * 关键：capability 五命令共享 per-宿主状态（capability store；deps.capability 缺省
 * 时用内存兜底 store——put→get 一致性要求同一 deps 共享同一兜底实例），故按 deps
 * 对象身份 WeakMap 缓存兜底 store。
 */

import type { CapabilityRecord, CapabilityStore } from '@ink-ts/host';
import { BridgeError, defaultCapabilityRecord, parseRecord } from '@ink-ts/host';
import type { HostBridgeDeps } from '@ink-ts/host';

/** capability.json 内 baseline 镜像键名。 */
export const BASELINE_KEY = 'tool_baseline';
/** tier_overrides 白名单取值（工具审批档两级；登记面 passthrough）。 */
export const TIER_WHITELIST = ['allow', 'review'] as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 未装配 store 时的内存兜底（测试/最小装配语义与持久化形态一致）；按 deps
 *  缓存实例，保证 capability.put→get 跨命令看到同一状态。 */
const ephemeralStores = new WeakMap<HostBridgeDeps, CapabilityStore>();

export function ephemeralCapabilityStore(deps: HostBridgeDeps): CapabilityStore {
  const cached = ephemeralStores.get(deps);
  if (cached !== undefined) return cached;
  let store: CapabilityRecord = defaultCapabilityRecord();
  const made: CapabilityStore = {
    get: (): CapabilityRecord => store,
    put: (patch: Record<string, unknown>): CapabilityRecord => {
      store = parseRecord({ ...store, ...patch });
      return store;
    },
    reset: (): CapabilityRecord => {
      store = defaultCapabilityRecord();
      return store;
    },
    reload: (): void => {
      // 内存兜底形态无磁盘真源：保持当前状态
    },
  };
  ephemeralStores.set(deps, made);
  return made;
}

/** 响应注入缺省字段（auto 出厂空集）；不写库。 */
export function withDefaults(record: Record<string, unknown>): Record<string, unknown> {
  const defaults = defaultCapabilityRecord();
  const out: Record<string, unknown> = { ...record };
  for (const [key, value] of Object.entries(defaults)) {
    if (out[key] === undefined) out[key] = value;
  }
  return out;
}

/** 单字段校验（任一字段值非法即抛 BridgeError，整体不落盘）。 */
export function validatePatch(patch: Record<string, unknown>): void {
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
}

/** 运行时装配守卫（未 boot/已关停 = storage 缺 = 拒绝；与 rounds 同判）。 */
export function runtimeOrThrow(deps: HostBridgeDeps): void {
  if (deps.runtime.storage === null) {
    throw new BridgeError('运行时引擎未装配（runtime 未 boot/已关停）', 'runtime_unavailable');
  }
}
