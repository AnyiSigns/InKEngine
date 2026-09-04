/**
 * SqliteStorage 底座：连接生命周期 + 并发串行化 + schema 自检 + 快照/恢复
 * （storage_sqlite.py 的连接/pragma/ENG5-6 快照语义切片）。
 *
 * node:sqlite（DatabaseSync）是同步驱动——JS 单线程 run-to-completion 使
 * 单连接内写操作天然原子；跨引擎实例（多连接/多进程）并发依赖 PRAGMA
 * busy_timeout + WAL 单写者排队 + AUTOINCREMENT（seq 不复用）。为显式表达
 * 并发语义，全部公开操作经内部 promise 链互斥（_serial）串行化，与 Python
 * 端 aiosqlite 单连接行为对齐。
 *
 * 快照/恢复：node:sqlite 提供顶层 backup(sourceDb, path)（sqlite3_backup
 * 封装，Node 22.13+）。snapshot = backup 到目标文件（事务级一致副本）；
 * restore = 源库内容整体替换当前库——先经 backup 到临时文件，文件库直接
 * 覆写库文件后重开，内存库经 serialize/deserialize 载入（deserialize 在
 * @types/node 缺失类型声明，本文件以局部接口标注）。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

import { StorageError } from '../../core/errors.js';
import { SCHEMA_SQL } from './sqlite_schema.js';

/** node:sqlite 未声明 serialize/deserialize 的局部标注（Node 24 具备）。 */
interface SerializableDb {
  serialize(): Uint8Array;
  deserialize(data: Uint8Array): void;
}

/** 错误消息提取（python `str(exc)` 同口径）。 */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 快照/恢复能力声明（sqlite 支持文件级备份）。 */
export const SQLITE_SNAPSHOT_CAPABLE = true;

export abstract class SqliteBaseStorage {
  /** 库路径（:memory: = 内存库）。 */
  readonly db_path: string;
  /** 可信快照目录（ENG5-6）：restore(src) 只接受该目录内常规文件。 */
  protected readonly _snapshot_dir: string | null;
  protected _db: DatabaseSync | null = null;
  protected _closed = false;
  /** 并发串行化：全部公开操作经 promise 链互斥（单连接写者语义）。 */
  private _serial_tail: Promise<unknown> = Promise.resolve();

  constructor(db_path = ':memory:', options: { snapshot_dir?: string | null } = {}) {
    this.db_path = db_path;
    if (options.snapshot_dir !== undefined && options.snapshot_dir !== null) {
      this._snapshot_dir = path.resolve(options.snapshot_dir);
    } else if (!db_path.startsWith(':') && !db_path.startsWith('file:')) {
      this._snapshot_dir = path.dirname(path.resolve(db_path));
    } else {
      this._snapshot_dir = null;
    }
  }

  /** 承诺链互斥：串行执行 op（含错误隔离，前序失败不阻塞后续）。 */
  protected _serial<T>(op: () => Promise<T>): Promise<T> {
    const run = this._serial_tail.then(() => op());
    this._serial_tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 确保已连接（关闭后显式报错；已连接直接返回）。 */
  protected async _connect(): Promise<void> {
    if (this._closed) {
      throw new StorageError('存储已关闭（use-after-close：close() 后不可再读写）');
    }
    if (this._db !== null) return;
    try {
      this._db = this._openDb();
    } catch (err) {
      if (this._db !== null) {
        try {
          this._db.close();
        } catch {
          /* 关闭失败不掩盖原错误 */
        }
        this._db = null;
      }
      throw new StorageError(`sqlite 存储连接失败: ${errMsg(err)}`);
    }
  }

  /** 当前连接句柄（调用前须已 _connect）。 */
  protected get db(): DatabaseSync {
    return this._db!;
  }

  /** 开连接 + 并发护栏 pragma + 建表 + schema 自检（Python _connect 同构）。 */
  protected _openDb(): DatabaseSync {
    const db = new DatabaseSync(this.db_path);
    // 跨进程并发护栏：busy_timeout 等待而非立即报错、WAL 读写不互斥、
    // synchronous=NORMAL 崩溃安全与吞吐平衡（WAL 下 fsync 仅 checkpoint 期）。
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(SCHEMA_SQL);
    this._checkSchema(db);
    return db;
  }

  /** 启动期 schema 自检：旧版表缺列时给出明确指令（不做迁移，删库重建）。 */
  private _checkSchema(db: DatabaseSync): void {
    const rows = db.prepare('PRAGMA table_info(checkpoints)').all() as { name: string }[];
    const columns = new Set(rows.map((r) => r.name));
    if (columns.size === 0) return;
    for (const missing of ['error', 'interrupt', 'graph_version', 'plan']) {
      if (!columns.has(missing)) {
        throw new StorageError(
          `检测到旧版 checkpoints 表（缺 ${missing} 列）：本项目不做数据迁移，` +
            '请删除库/表后重启（DROP TABLE checkpoints, event_log, records;）',
        );
      }
    }
  }

  // ── 全量快照（backup：目标 = 源库一致副本）──
  /** 文件级快照/恢复能力声明（sqlite 支持）。 */
  readonly snapshot_capable = true;

  async snapshot(dest: string): Promise<void> {
    return this._serial(async () => {
      await this._connect();
      if (dest === this.db_path) {
        throw new StorageError(`快照目标与源相同: ${dest}（备份须写入不同位置）`);
      }
      try {
        await backup(this.db, dest);
      } catch (err) {
        throw new StorageError(`sqlite 快照失败: ${errMsg(err)}`);
      }
    });
  }

  async restore(src: string): Promise<void> {
    return this._serial(async () => {
      await this._connect();
      if (src === this.db_path) {
        throw new StorageError(`恢复源与当前库相同: ${src}（当前库已是待恢复内容）`);
      }
      const srcAbs = path.resolve(src);
      if (this._snapshot_dir !== null) {
        const rel = path.relative(this._snapshot_dir, srcAbs);
        const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
        if (!inside) {
          throw new StorageError(
            `恢复源不在可信快照目录内: ${src}（可信目录: ${this._snapshot_dir}）`,
          );
        }
      }
      let isFile = false;
      try {
        isFile = fs.statSync(srcAbs).isFile();
      } catch {
        /* 不存在/不可访问 → 非常规文件 */
      }
      if (!isFile) {
        throw new StorageError(`恢复源须为存在的常规文件: ${src}`);
      }
      // 恢复 = 全量替换当前库：先经 backup API 做一致性副本到临时文件
      const tmp = path.join(os.tmpdir(), `inkengine-restore-${process.pid}-${Date.now()}.db`);
      let srcConn: DatabaseSync | null = null;
      try {
        srcConn = new DatabaseSync(srcAbs);
        await backup(srcConn, tmp);
      } catch (err) {
        throw new StorageError(`sqlite 恢复失败: ${errMsg(err)}`);
      } finally {
        try {
          srcConn?.close();
        } catch {
          /* 源连接关闭失败不掩盖 */
        }
      }
      try {
        this._reopenAfterRestore(tmp);
      } finally {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          /* 临时文件清理失败可忽略 */
        }
      }
    });
  }

  /** 关当前连接，按库形态装回快照内容（文件库覆写 + 内存库 deserialize）。 */
  private _reopenAfterRestore(tmp: string): void {
    this.db.close();
    this._db = null;
    if (this.db_path === ':memory:') {
      this._db = this._openDb();
      const tmpConn = new DatabaseSync(tmp);
      try {
        const bytes = (tmpConn as unknown as SerializableDb).serialize();
        (this._db as unknown as SerializableDb).deserialize(bytes);
      } finally {
        tmpConn.close();
      }
      return;
    }
    // 文件库：覆写库文件并清 WAL/shm 伴生文件（防旧 WAL 重放回旧内容）
    fs.copyFileSync(tmp, this.db_path);
    for (const suffix of ['-wal', '-shm']) {
      try {
        fs.rmSync(`${this.db_path}${suffix}`, { force: true });
      } catch {
        /* 伴生文件不存在可忽略 */
      }
    }
    this._db = this._openDb();
  }

  async close(): Promise<void> {
    this._closed = true;
    if (this._db !== null) {
      try {
        this._db.close();
      } catch {
        /* 已关闭的连接忽略 */
      }
      this._db = null;
    }
  }
}
