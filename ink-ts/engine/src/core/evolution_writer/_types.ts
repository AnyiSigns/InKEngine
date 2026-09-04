/**
 * EvolutionWriter 域 seam：写入三闸门（补丁链 / 实时数据 / 审计）的存储
 * 契约 + 实现契约。self_application.GuardedStorage 是宿主侧密封类，
 * 未迁入 core；core 以 duck-check（allow_mechanism 函数存在）镜像
 * audit_log 模块的等价判定，本地声明 GuardedEvolutionStorage 结构形态
 * 供类型签名使用。
 */

import type { AuditStorage } from '../audit_log/audit_log.js';
import type { MechanismExemptionScope } from '../audit_log/audit_log.js';

/** 演化资产记录（写入目标集合的载荷；任意 JSON 对象）。 */
export type EvolutionRecord = { [key: string]: unknown };

/** 演化资产种类（受限枚举：六类可演化资产；非法值按 kind 原样落链）。 */
export type EvolutionKind =
  | 'harness'
  | 'event_type'
  | 'entity'
  | 'memory'
  | 'edge_tier'
  | 'runtime_config';

/** EvolutionWriter.write 命名选项（Python kw-only args 的 TS 映射）。 */
export interface EvolutionWriteOptions {
  kind: string;
  asset_id: string;
  note?: string;
  meta?: { [key: string]: unknown } | null;
}

/** 演化写入存储的最小契约：get_record + put_record（duck-typed；
 *  不绑定宿主侧的 Storage 全量接口，core 只用 records 通道两原语）。 */
export interface EvolutionStorage extends AuditStorage {
  get_record(collection: string, key: string): Promise<EvolutionRecord | null>;
  put_record(collection: string, key: string, data: EvolutionRecord): Promise<void>;
}

/** 受守卫演化存储：额外实现 allow_mechanism 豁免入口（与 GuardedAuditStorage
 *  同形；scope.enter/exit 夹住 put 镜像 Python with 语义）。 */
export interface GuardedEvolutionStorage extends EvolutionStorage {
  allow_mechanism(collection?: string | null): MechanismExemptionScope;
}

/** 演化资产统一写入契约（上层管线；底层闸门 = GuardedEvolutionStorage）。
 *  实现须提供 write：完成补丁链 append + 实时数据写 + 审计留痕三重闸门。 */
export interface EvolutionWriter {
  write(
    collection: string,
    key: string,
    data: EvolutionRecord,
    options: EvolutionWriteOptions,
  ): Promise<void>;
}
