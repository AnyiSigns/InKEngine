/**
 * 通道资产目录（通道条件资产的注册容器 + 出厂典型素材）。
 *
 * 与作用域目录不同（作用域资产 = 实体目录的带声明实体），通道资产没有
 * persona/model 身份，是独立的转场算子声明域，故单独设目录容器。本目录为
 * 纯内存数据容器（register/unregister/replace/get/names），形态/契约/条件/
 * 观测全部经 ChannelSpec 校验后才可入册。
 *
 * 受控注册边界：登记/更新/封/下架 = 容器操作 + ChannelSpec 校验；本模块提供
 * 通道资产集合命名与持久化 codec（快照/由行重建），真正落库由受控演化应用
 * 管线经 EvolutionWriter 执行（channels:<set_id> 为受守卫前缀，见
 * core/controlled_evolution/controlled_applier.ts）——本模块不触碰存储，
 * 只声明容器语义与存档形态。出厂素材只声明「典型通道」，供执行层装配/宿主
 * 按需实例化，非静态拓扑。
 */

import { GraphDefinitionError } from '../errors.js';
import {
  CHANNEL_COMMIT_BEST,
  CHANNEL_COMMIT_FULL,
  CHANNEL_SHAPE_DELEGATE,
  CHANNEL_SHAPE_FAN_IN,
  CHANNEL_SHAPE_FAN_OUT,
  CHANNEL_SHAPE_RETURN,
  ChannelSpec,
  channel_with_disabled,
} from './channel_spec.js';

/** 通道资产持久化集合前缀（受守卫前缀 channels:；GuardedStorage 拒绝旁路直写，
 *  唯一写入通道 = EvolutionWriter/受控演化应用管线）。 */
export const CHANNELS_COLLECTION_PREFIX = 'channels:';

/** 通道资产集合名（按集隔离；缺省集 = '-'，与实体注册表缺省同口径）。 */
export function channel_collection(set_id = '-'): string {
  return `${CHANNELS_COLLECTION_PREFIX}${set_id}`;
}

/** 通道目录：通道资产注册容器（重复/未注册/演化不代创建 = 显式拒绝）。 */
export class ChannelDirectory {
  #specs = new Map<string, ChannelSpec>();
  readonly maxChannels: number;

  constructor(opts: { maxChannels?: number } = {}) {
    this.maxChannels = opts.maxChannels ?? 200;
  }

  register(spec: ChannelSpec): void {
    if (this.#specs.has(spec.id)) {
      throw new GraphDefinitionError(`通道重复注册: ${spec.id}`);
    }
    if (this.#specs.size >= this.maxChannels) {
      throw new GraphDefinitionError(
        `通道数量已达配额上限（${this.maxChannels}）: 须合并/废弃既有通道后重提`,
      );
    }
    this.#specs.set(spec.id, spec);
  }

  unregister(channel_id: string): void {
    if (!this.#specs.has(channel_id)) {
      throw new GraphDefinitionError(`通道未注册: ${channel_id}`);
    }
    this.#specs.delete(channel_id);
  }

  replace(spec: ChannelSpec): void {
    if (!this.#specs.has(spec.id)) {
      throw new GraphDefinitionError(`通道未注册（演化不代创建）: ${spec.id}`);
    }
    this.#specs.set(spec.id, spec);
  }

  /** 封通道（下架）：声明置位 disabled=true（替换记录，保留可审计/可回退）。 */
  seal(channel_id: string): void {
    const spec = this.get(channel_id);
    if (spec === null) {
      throw new GraphDefinitionError(`通道未注册（封禁不代创建）: ${channel_id}`);
    }
    if (spec.disabled) {
      throw new GraphDefinitionError(`通道已封禁: ${channel_id}`);
    }
    this.#specs.set(channel_id, channel_with_disabled(spec, true));
  }

  /** 解封通道：清除 disabled 标记（重开既有资产；未注册/未封禁 = 显式拒绝）。 */
  unseal(channel_id: string): void {
    const spec = this.get(channel_id);
    if (spec === null) {
      throw new GraphDefinitionError(`通道未注册（解封不代创建）: ${channel_id}`);
    }
    if (!spec.disabled) {
      throw new GraphDefinitionError(`通道未封禁（解封目标须已封）: ${channel_id}`);
    }
    this.#specs.set(channel_id, channel_with_disabled(spec, false));
  }

  get(channel_id: string): ChannelSpec | null {
    return this.#specs.get(channel_id) ?? null;
  }

  names(): string[] {
    return [...this.#specs.keys()];
  }

  specs(): ChannelSpec[] {
    return [...this.#specs.values()];
  }
}

/** 目录行快照（序列化持久化形态；受控通道逐行落库的读出面）。 */
export function channel_directory_snapshot(dir: ChannelDirectory): Record<string, unknown>[] {
  return dir.specs().map((spec) => spec.to_dict());
}

/** 由持久化行重建目录（幂等装载：重复 id 跳过；畸形行显式抛错）。 */
export function channel_directory_from_rows(rows: readonly unknown[]): ChannelDirectory {
  const dir = new ChannelDirectory();
  for (const row of rows) {
    const spec = ChannelSpec.from_dict(row);
    if (dir.get(spec.id) === null) dir.register(spec);
  }
  return dir;
}

/**
 * 出厂典型通道素材（每次返回新鲜数据）。
 *
 * 覆盖形态四值 + 默认提交契约口径（delegate/return = full 回传；fan_out 由
 * 归并端定契约；典型协作归并用 best/full 见各条注释）。仅声明素材：是否/如何
 * 装配由执行层与宿主产品决定，非写死拓扑。
 */
export function default_channel_seeds(): ChannelSpec[] {
  return [
    new ChannelSpec({
      id: 'delegate',
      label: '委托（1→1）',
      shape: CHANNEL_SHAPE_DELEGATE,
      commit: CHANNEL_COMMIT_FULL,
      conditions: { max_parallel: 1 },
    }),
    new ChannelSpec({
      id: 'fan_out',
      label: '并行派发（1→N）',
      shape: CHANNEL_SHAPE_FAN_OUT,
      commit: CHANNEL_COMMIT_FULL,
    }),
    new ChannelSpec({
      id: 'fan_in',
      label: '归并（N→1）',
      shape: CHANNEL_SHAPE_FAN_IN,
      commit: CHANNEL_COMMIT_BEST,
    }),
    new ChannelSpec({
      id: 'return',
      label: '回传（子执行返回）',
      shape: CHANNEL_SHAPE_RETURN,
      commit: CHANNEL_COMMIT_FULL,
      conditions: { max_parallel: 1 },
    }),
  ];
}
