/**
 * Runtime 出厂界面组件启停（组件 tab 管理面；出厂白名单可停用）。
 *
 * 出厂白名单基线 = 配方 ui_allowed_components 未过滤全集；停用集 ⊆ 白名单，
 * 装配期过滤喂校验器与初始界面校验（三层白名单同源）。停用集持久化走
 * records 通道（runtime_config/ui_components_disabled），重启经
 * _load_ui_components_disabled 装配期过滤（同源）。
 */

import {
  UI_COMPONENTS_RECORD_COLLECTION,
  UI_COMPONENTS_RECORD_KEY,
} from './_constants.js';
import { RuntimeSpecs } from './_runtime_specs.js';

/** 出厂界面组件基座：启停白名单 + 持久化。 */
export abstract class RuntimeUiComponents extends RuntimeSpecs {
  /** 出厂界面组件白名单基线（配方 ui_allowed_components 未过滤全集）。 */
  get ui_factory_components(): string[] {
    return [...this._ui_factory_components].sort();
  }

  /** 当前已停用出厂组件名（排序）。 */
  get ui_components_disabled(): string[] {
    return [...this._ui_components_disabled].sort();
  }

  /** 活跃界面组件白名单（出厂全集 - 停用集；校验器/界面校验同源）。 */
  get ui_allowed_components(): string[] {
    const active = new Set(this._ui_factory_components);
    for (const name of this._ui_components_disabled) active.delete(name);
    return [...active].sort();
  }

  /** 停用/恢复出厂组件（组件 tab 勾选落地面；未登记名结构化拒绝）。 */
  async set_ui_components_disabled(names: readonly string[]): Promise<string[]> {
    const requested = new Set(names);
    const unknown = [...requested]
      .filter((name) => !this._ui_factory_components.has(name))
      .sort();
    if (unknown.length > 0) {
      throw new Error(`未登记出厂组件不能停用: ${unknown.join(', ')}`);
    }
    this._ui_components_disabled = requested;
    if (this.validator !== null) {
      this.validator.set_allowed_components(this.ui_allowed_components);
    }
    if (this.storage !== null) {
      await this._write_ui_disabled_record();
    }
    return this.ui_components_disabled;
  }

  /** 停用集落盘（records 通道）。 */
  private async _write_ui_disabled_record(): Promise<void> {
    const { DefaultEvolutionWriter, runtime_config_writer } =
      await import('../evolution_writer/evolution_writer.js');
    const writer =
      this._mechanism_writer ?? new DefaultEvolutionWriter(this.storage!);
    await runtime_config_writer(
      writer,
      UI_COMPONENTS_RECORD_COLLECTION,
      UI_COMPONENTS_RECORD_KEY,
      { disabled: [...this._ui_components_disabled].sort() },
      { asset_id: 'ui_components_disabled', note: 'set_ui_components_disabled' },
    );
  }

  /** 重启装载停用组件集（records 通道；坏形态/缺记录沿用出厂全量白名单）。 */
  async _load_ui_components_disabled(): Promise<ReadonlySet<string>> {
    if (this.storage === null) return new Set();
    let record: Record<string, unknown> | null = null;
    try {
      record = await this.storage.get_record(
        UI_COMPONENTS_RECORD_COLLECTION,
        UI_COMPONENTS_RECORD_KEY,
      );
    } catch {
      // 停用组件集读取失败（沿用出厂全量白名单）
      return new Set();
    }
    const names = (record ?? {})['disabled'];
    if (Array.isArray(names) && names.every((name) => typeof name === 'string')) {
      return new Set(names as string[]);
    }
    return new Set();
  }
}
