/**
 * capability 命令面（能力记录：自动审批预授权 + 工具回合上限的读档/存档 +
 * 常驻工具基线 + 工具档位登记面）。
 *
 * 语义对齐壳侧 capability 命令：get 只读 + 缺省字段注入（auto 审批字段
 * 出厂空集——不勾选即不预授权；缺省只在响应注入、不落盘固化，显式写档才
 * 存档）；put 整体存储但按单字段并入（读既有 → 并入 → 校验 → 落盘），字段
 * 白名单校验失败不落盘。
 *
 * 字段消费：auto_approve_tools / auto_approve_all_review → host
 * interrupt_policy 并入（活读策略实例，put 后下个请求生效）；max_tool_rounds
 * → rounds.send 每次活读随回合传引擎（无记录 = 引擎缺省 8），引擎组装把值
 * 写入 llm_decider 节点 config 生效（声明 → 组装图运行值；能力/设置面回显）。
 * 推演档位语义已移除（不设档位直接开启），历史残留键读档丢弃。
 *
 * baseline（常驻必带集）：引擎运行时单源（runtime.baseline_names /
 * set_baseline_names——注入面与检索面读同一份数据），capability.json 镜像
 * 存档（data_dir 快照/重启重放位）；set 白名单校验（名称须在引擎全量工具
 * 表）后整集替换并持久化。tier.set = 工具档位登记面（passthrough 白名单
 * 值 allow/review；登记面不具执行语义，能力 get 原样回显）。
 */

import type { CapabilityCommand } from './commands.generated.js';
export { CAPABILITY_COMMANDS, type CapabilityCommand } from './commands.generated.js';
import type {
  CapabilityRecord,
  CapabilityStore,
} from '../capability/store.js';
import {
  defaultCapabilityRecord,
  parseRecord,
} from '../capability/store.js';
import { BridgeError, type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';

/** capability.json 内 baseline 镜像键名。 */
const BASELINE_KEY = 'tool_baseline';
/** tier_overrides 白名单取值（工具审批档两级；登记面 passthrough）。 */
const TIER_WHITELIST = ['allow', 'review'] as const;

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
    reload: (): void => {
      // 内存兜底形态无磁盘真源：保持当前状态
    },
  };
}

/** 响应注入缺省字段（auto 出厂空集）；不写库。 */
function withDefaults(record: Record<string, unknown>): Record<string, unknown> {
  const defaults = defaultCapabilityRecord();
  const out: Record<string, unknown> = { ...record };
  for (const [key, value] of Object.entries(defaults)) {
    if (out[key] === undefined) out[key] = value;
  }
  return out;
}

/** 单字段校验（任一字段值非法即抛 BridgeError，整体不落盘）。 */
function validatePatch(patch: Record<string, unknown>): void {
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
function runtimeOrThrow(deps: HostBridgeDeps): void {
  if (deps.runtime.storage === null) {
    throw new BridgeError('运行时引擎未装配（runtime 未 boot/已关停）', 'runtime_unavailable');
  }
}

/** capability 命令声明（方法名真源 = plugins/commands → commands.generated.ts 派生；装配由 index 聚合生成物元组）。 */
export function buildCapabilityCommands(deps: HostBridgeDeps): Readonly<Record<CapabilityCommand, BridgeHandler>> {
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

  /** 常驻工具基线读取（引擎运行时单源 = 注入面同源数据）。 */
  const baselineGet: BridgeHandler = (): unknown => {
    runtimeOrThrow(deps);
    return { tools: deps.runtime.baseline_names };
  };

  /** 常驻工具基线整集替换（白名单校验 = 引擎 set_baseline_names 结构化
   *  拒绝未知名；成功同步镜像 capability.json 存档）。 */
  const baselineSet: BridgeHandler = async (raw): Promise<unknown> => {
    runtimeOrThrow(deps);
    const params = raw as { tools?: unknown } | null;
    if (params === null || typeof params !== 'object' || !Array.isArray(params.tools)) {
      throw new BridgeError('capability.baseline.set 需 params.tools（字符串清单）', 'invalid_params');
    }
    const names = params.tools as unknown[];
    if (names.some((name) => typeof name !== 'string')) {
      throw new BridgeError('capability.baseline.set tools 须为字符串清单', 'invalid_params');
    }
    let applied: string[];
    try {
      applied = await deps.runtime.set_baseline_names(names as string[]);
    } catch (error) {
      // 引擎白名单校验（未注册工具名）失败显式回传，不落镜像
      throw new BridgeError(
        `capability.baseline.set 被拒: ${error instanceof Error ? error.message : String(error)}`,
        'invalid_params',
      );
    }
    store.put({ [BASELINE_KEY]: [...applied] });
    return { tools: [...applied] };
  };

  /** 工具档位登记面（passthrough 白名单值 allow/review；无执行语义，
   *  能力 get 原样回显，供设置面存档/展示）。 */
  const tierSet: BridgeHandler = async (raw): Promise<unknown> => {
    const params = raw as { tier_overrides?: unknown } | null;
    if (params === null || typeof params !== 'object') {
      throw new BridgeError('capability.tier.set 需 params.tier_overrides', 'invalid_params');
    }
    const overrides = params.tier_overrides;
    if (!isRecord(overrides)) {
      throw new BridgeError('capability.tier.set tier_overrides 须为记录对象', 'invalid_params');
    }
    for (const [name, value] of Object.entries(overrides)) {
      if (name === '') {
        throw new BridgeError('capability.tier.set 工具名不能为空', 'invalid_params');
      }
      if (!(TIER_WHITELIST as readonly string[]).includes(value as string)) {
        throw new BridgeError(
          `capability.tier.set 非法档位值: ${String(value)}（白名单: ${TIER_WHITELIST.join(', ')}）`,
          'invalid_params',
        );
      }
    }
    const record = store.put({ tier_overrides: { ...overrides } });
    return { tier_overrides: record['tier_overrides'] };
  };

  return {
    'capability.get': get,
    'capability.put': put,
    'capability.baseline.get': baselineGet,
    'capability.baseline.set': baselineSet,
    'capability.tier.set': tierSet,
  };
}
