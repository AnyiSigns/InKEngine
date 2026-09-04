/**
 * 集补丁链（core/self_application.py SetPatchChain 移植；storage records
 * 持久化：权威记录 = 链本身）。
 *
 * 版本语义（与 harness 仓库同哲学）：版本号 = 补丁数 + 1（首版 = base
 * 无补丁）；组装（assemble）支持任意版本（回退/审计取用）；回退 =
 * 组装到目标版本为新的 base、清空补丁（链长收敛，旧链在审计中完整
 * 保留）；并发检测 = 提案基准版本与当前版本比对。
 *
 * TS seam 差异：Storage 为接口（实现由宿主注入）；守卫令牌只在目标
 * 为 GuardedStorage 包装层时透传（ENG1-7），其余后端不传令牌同样安全。
 */

import type { Storage } from '../storage/storage.js';
import type { Patch } from '../patch/patchChain.js';
import { PatchChain } from '../patch/patchChain.js';
import { GraphDefinitionError } from '../errors.js';
import type { Json } from '../json.js';

import { _SET_CHAIN_COLLECTION, _SET_CHAIN_KEY } from './constants.js';
import { GuardedStorage } from './guarded_storage.js';

/** SetPatchChain 构造选项。 */
export interface SetPatchChainInit {
  /** 守卫令牌（与 GuardedStorage 包装一致时随链写入透传）。 */
  guard_token?: string | null;
}

/** PatchChain 序列化形态（from_dict 入参）。 */
interface ChainRecord {
  base?: { [key: string]: Json };
  patches?: { op: 'delete' | 'append' | 'replace'; path: (string | number)[]; value: Json }[];
}

export class SetPatchChain {
  private readonly _storage: Storage;
  private readonly _guard_token: string | null;

  constructor(storage: Storage, init: SetPatchChainInit = {}) {
    this._storage = storage;
    this._guard_token = init.guard_token ?? null;
  }

  private async _load(): Promise<PatchChain> {
    const record = await this._storage.get_record(_SET_CHAIN_COLLECTION, _SET_CHAIN_KEY);
    if (record === null || record === undefined) return new PatchChain();
    return PatchChain.from_dict(record as unknown as ChainRecord);
  }

  /** 当前版本（= 补丁数 + 1；空集 = 版本 1）。 */
  async current_version(): Promise<number> {
    const chain = await this._load();
    return chain.patches.length + 1;
  }

  /**
   * 链写入（持有守卫令牌且目标为 GuardedStorage 时随调用透传）。
   * Storage 接口未声明 guard_token 形参（ENG1-7）：普通后端/自定义
   * 实现不接受该参数——令牌只对 GuardedStorage 包装层有意义（其余
   * 后端无守卫语义，不传令牌同样安全）。
   */
  private async _put_record(
    collection: string,
    key: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (this._guard_token !== null && this._storage instanceof GuardedStorage) {
      await this._storage.put_record(collection, key, data, { guard_token: this._guard_token });
    } else {
      await this._storage.put_record(collection, key, data);
    }
  }

  /**
   * 追加一条补丁（append-only）：链记录整体写回（单次存储事务）。
   *
   * expected_version：乐观版本校验（CAS，ENG1-8）——调用方持有的基准
   * 版本号；加载后与当前版本不符 = 并发冲突，拒绝落链。
   *
   * @returns 新版本号。
   */
  async append(patch: Patch, expected_version?: number | null): Promise<number> {
    const chain = await this._load();
    const current = chain.patches.length + 1;
    if (expected_version !== null && expected_version !== undefined && expected_version !== current) {
      throw new GraphDefinitionError(
        `并发冲突: 链已前进（调用方基准版本 ${expected_version}，`
          + `当前 ${current}）——请基于最新链状态重试`,
      );
    }
    chain.apply(patch);
    await this._put_record(_SET_CHAIN_COLLECTION, _SET_CHAIN_KEY, chain.to_dict() as unknown as Record<string, unknown>);
    return chain.patches.length + 1;
  }

  /** 组装集状态（缺省最新版本；version = 回退/审计指定版本）。 */
  async assemble(version?: number | null): Promise<{ [key: string]: Json }> {
    const chain = await this._load();
    if (version === null || version === undefined) {
      return chain.assemble();
    }
    if (version < 1 || version > chain.patches.length + 1) {
      throw new GraphDefinitionError(
        `集版本越界: ${version}（当前 ${chain.patches.length + 1}）`,
      );
    }
    if (version === 1) {
      return chain.assemble('base_only');
    }
    return chain.assemble('partial', 0, version - 1);
  }

  /**
   * 回退到指定版本：仅允许回退链尾（当前版本 - 1，单步回退）。
   *
   * 链完整性在存储层强制：回退目标是「已应用的链尾补丁」本身——其上
   * 有后继补丁 = 拒绝（宿主先回退后继，保持链有序）。回退 = 组装到目标
   * 版本为新的 base、清空补丁（新链独立，旧链数据在审计中完整保留——
   * append-only，历史不撒谎）。调用方负责落审计记录。
   *
   * @param version 回退目标版本（当前版本 - 1；版本 1 = 回退全部补丁）。
   * @param expected_version 乐观版本校验（CAS，ENG1-8）。
   * @returns 回退后的集状态。
   */
  async revert_to(version: number, expected_version?: number | null): Promise<{ [key: string]: Json }> {
    const chain = await this._load();
    const current = chain.patches.length + 1;
    if (expected_version !== null && expected_version !== undefined && expected_version !== current) {
      throw new GraphDefinitionError(
        `回退冲突: 链已前进（调用方基准版本 ${expected_version}，`
          + `当前 ${current}）——请基于最新链尾重新发起回退`,
      );
    }
    if (version < 1 || version > current) {
      throw new GraphDefinitionError(`回退目标版本越界: ${version}（当前 ${current}）`);
    }
    if (version === current) {
      throw new GraphDefinitionError(
        `回退目标须低于当前版本: ${version} == ${current}`
          + '（回退的是已应用补丁，不是链尾本身）',
      );
    }
    if (version !== current - 1) {
      throw new GraphDefinitionError(
        `仅允许回退链尾补丁: 目标版本 ${version}，当前 ${current}`
          + '（一次回退一步——其上存在后继补丁，先回退后继，保持链完整性）',
      );
    }
    // 组装到目标版本 = 目标形态（链尾补丁被回退，其余补丁原样保留）
    const doc = chain.assemble('partial', 0, version - 1);
    await this._put_record(
      _SET_CHAIN_COLLECTION,
      _SET_CHAIN_KEY,
      new PatchChain(doc, []).to_dict() as unknown as Record<string, unknown>,
    );
    return doc;
  }

  /** 链尾补丁摘要（回退审计的内容来源；空链 = null）。 */
  async last_patch(): Promise<{ op: string; path: (string | number)[]; value: Json } | null> {
    const chain = await this._load();
    if (chain.patches.length === 0) return null;
    const last = chain.patches[chain.patches.length - 1]!;
    return {
      op: last.op,
      path: [...last.path],
      value: last.value as Json,
    };
  }
}
