/**
 * 内存存储后端（MemoryStorage）：测试/单进程默认后端，镜像 Python
 * ink_engine/core/storage_memory.py 的 create_storage("memory://") 语义。
 *
 * 三通道 + 全量快照与 sqlite/postgres 后端同口径（checkpoint 版本链 /
 * 执行事件日志 / structured records / 快照 JSON 文件往返），序列化契约、
 * 深拷贝读取与并发安全（AsyncLock 串行化 + checkpoint 乐观锁）见分层
 * 文件：_base（状态+快照）→ _checkpoints（版本链）→ _events_records
 * （事件+records）。本文件只做汇出 + 工厂，声明 Storage 契约。
 *
 * GuardedStorage 令牌/豁免由 core 包装层负责（put_record opts 在包装层
 * 消费，不透传到后端）；close() 幂等无操作（Python MemoryStorage.close
 * 同口径，close 后可继续读写）。
 */

import type { Storage } from '../../core/storage/storage.js';

import { MemoryStorageEventsRecords } from './_events_records.js';

/** 内存后端：checkpoint 版本链 + 事件日志 + structured records + 快照。 */
export class MemoryStorage extends MemoryStorageEventsRecords implements Storage {}

/** 存储后端工厂（镜像 Python create_storage 的 memory:// 分支）。 */
export function create_memory_storage(): MemoryStorage {
  return new MemoryStorage();
}
