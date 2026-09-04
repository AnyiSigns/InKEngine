/**
 * 存储后端工厂（create_storage 移植，storage.py 路由语义）。
 *
 * 连接串协议前缀决定后端：memory:// / sqlite:///path / postgresql://。
 * engine adapters 落 memory（本目录）与 sqlite（node:sqlite）两后端；
 * postgres 尚未移植，工厂对其显式报错，避免静默路由到不存在的后端。
 *
 * memory 分支镜像 Python create_storage：裸串/空串（'' / 'memory' /
 * 'memory://'）归一为 MemoryStorage。sqlite 分支与 Python 同构：
 * - 协议前缀按 urlsplit 语义解析（scheme 至首个 ':'）；
 * - ``sqlite:/path`` 少斜杠形态显式拒绝（会静默截断成错误相对路径）；
 * - 空路径归一为 :memory:（持久化未启用需显式指定）；
 * - 路径穿越防护：剥离前导 '/' 后仍含 ``..`` 片段 = 拒绝。
 */

import type { Storage } from '../../core/storage/storage.js';
import {
  SCHEME_MEMORY,
  SCHEME_POSTGRES,
  SCHEME_SQLITE,
} from '../../core/storage/storage_constants.js';

import { MemoryStorage, create_memory_storage } from './memory.js';
import { SqliteStorage } from './sqlite.js';

/** scheme 提取（镜像 urllib.parse.urlsplit().scheme：首个 ':' 前前缀，小写）。 */
function urlScheme(connString: string): string {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(connString);
  return match === null ? '' : match[1]!.toLowerCase();
}

/** 存储后端工厂：连接串协议前缀决定后端（内存/sqlite；postgres 未移植）。 */
export function create_storage(connString: string): Storage {
  const scheme = urlScheme(connString);
  if (scheme === SCHEME_MEMORY || connString === '' || connString === 'memory') {
    return create_memory_storage();
  }
  if (scheme === SCHEME_SQLITE) {
    if (!connString.startsWith('sqlite://')) {
      // 显式前缀校验：sqlite:/path 等少斜杠形态会静默截断成错误相对路径并新建空库
      throw new Error(
        `非法 sqlite 连接串（应为 sqlite:///path 或 sqlite:///:memory:）: ${connString}`,
      );
    }
    // 剥离 "sqlite://" 前缀；:memory: 保留原形（内存库），路径去掉前导 /
    let dbPath = connString.slice(SCHEME_SQLITE.length + 3);
    if (dbPath === '') {
      // 空路径归一为内存库（"sqlite" 裸协议默认值），持久化未启用需显式
      dbPath = ':memory:';
    }
    if (dbPath.startsWith(':') || dbPath.startsWith('file:')) {
      return new SqliteStorage(dbPath);
    }
    // 路径穿越防护：剥离前导 / 后仍含 `..` 片段 = 拒绝
    const clean = dbPath.replace(/^\/+/, '');
    const segments = clean.replace(/\\/g, '/').split('/');
    if (segments.includes('..')) {
      throw new Error(`非法 sqlite 库路径（拒绝 .. 片段）: ${dbPath}`);
    }
    return new SqliteStorage(clean);
  }
  if (scheme === SCHEME_POSTGRES || scheme === 'postgres') {
    throw new Error('postgresql:// 后端未移植（engine adapters 现仅 memory/sqlite）');
  }
  throw new Error(`未知存储连接串协议: ${connString}`);
}

export { MemoryStorage, create_memory_storage, SqliteStorage };
