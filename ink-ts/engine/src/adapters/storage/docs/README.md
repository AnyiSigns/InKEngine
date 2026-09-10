# storage/（存储后端）

core `Storage` async seam 的真实后端：memory（单进程/测试默认）与 sqlite
（Node 22.13+ 内置 node:sqlite DatabaseSync，单机默认持久后端）。三通道 +
全量快照/恢复与 Python 后端同口径；`create_storage` 按连接串协议前缀路由
（memory:// / sqlite:///path / sqlite:///:memory:；postgresql 未移植显式
报错，不静默路由）。

## 文件
- `index.ts` — `create_storage` 工厂：scheme 按首个 `:` 前缀解析；
  sqlite 少斜杠形态（`sqlite:/path`）显式拒绝（防静默截断建错库）；空路径
  归一 `:memory:`；路径剥离前导 `/` 后仍含 `..` 片段拒绝（穿越防护）。
- `memory.ts` — `MemoryStorage` 汇出 + `create_memory_storage` 工厂
  （仅声明 Storage 契约，实现全在分层基类）。
- `_base.ts` — 内存后端公共基座：AsyncLock 串行化 + 三通道容器 + 自增
  计数 + per-thread 链尾指针（只前进）+ 快照/恢复（JSON 文件往返，
  临时文件 + rename 原子落盘；恢复逐字段校验、重复 checkpoint id 拒绝）。
- `_checkpoints.ts` — checkpoint 版本链方法层：守卫式续链插入（悬挂/跨线程
  父指针、event_seq 回退、链尾已前进拒绝；fork 豁免）+ 显式更新乐观锁
  （expected_version 冲突抛 CheckpointConflictError；父指针不可变、线程
  不可迁移）+ 链索引/删除（跨线程 id 不静默删除）/父指针改写（链级 rebase
  专属）。读取一律深拷贝。
- `_events_records.ts` — 事件日志方法层（append-only，seq 锁内自增分配，
  跨实例唯一单调；truncate/trim/latest_event_seq）+ records 方法层
  （put 前剥离敏感键 + 严格 JSON 判定，round trip 兼作深拷贝；分页/前缀
  下推与 sqlite 同口径；delete_collection）。
- `_serialize.ts` — 序列化契约（内存与 sqlite 共享单实现）：checkpoint/
  records 严格 JSON 判定（类实例/函数/循环引用/NaN 拒绝——杜绝「内存后端
  静默通过、切 sqlite 即错」漂移）；事件负载宽松判定（不可序列化叶值
  default=str 字符串化）；from_dict/to_dict 往返作深拷贝。
- `_records_page.ts` — records 分页/前缀下推共享原语：prefix 上界 = 末位
  code unit +1；cursor = 上一页尾 key 严格大于续页；sqlite 下推为 key-range
  谓词（走主键索引），内存按升序窗口扫描；limit 0/负 = 无界（旧语义）。
- `sqlite.ts` — `SqliteStorage` 无状态编排面：三通道全方法 + 错误映射
  （CheckpointConflictError 透传，其余包成带 sqlite 前缀的 StorageError）；
  事件重放逐条容错解析（单条损坏跳过不中断整段）。
- `sqlite_base.ts` — sqlite 底座：连接生命周期（close 后 use 报错）+
  promise 链互斥（`_serial` 单连接写者语义，对齐 Python aiosqlite）+
  pragma 护栏（busy_timeout 5000 / WAL / synchronous NORMAL）+ 启动期
  schema 自检（旧表缺列给删库重建指令，不做迁移）+ 快照/恢复（node:sqlite
  backup；restore 经临时文件一致副本后整体替换，内存库走 serialize/
  deserialize；restore 源限可信快照目录内常规文件）。
- `sqlite_checkpoints.ts` — checkpoint 通道语句与行转换：GUARDED_INSERT
  （单条语句原子判定防 TOCTOU）/PLAIN_INSERT/乐观锁 UPDATE（SET 不含
  parent_id）；行 → CheckpointRecord（JSON 列解析 + fromJsonable 内联
  marker 还原 + InterruptState 还原）；写入侧 CheckpointData 类型收窄；
  更新返回库中真值（回读）。
- `sqlite_json.ts` — `strictDumps`：断言（复用 _serialize 共享判定）→
  stringify 两步，无第二套判定逻辑。
- `sqlite_schema.ts` — 三表 DDL 单一权威（checkpoints/event_log/records，
  表/列/索引名与 Python 一字不差）；`SCHEMA_SQL` 预生成文本建表即执行；
  records 主键（collection, key）。

## 依赖
- 上游：`core/storage`（Storage 契约/CheckpointRecord/ChainLink/常量）、
  `core/events`（EngineEvent/parse_event_lenient）、`core/errors`
  （StorageError/CheckpointConflictError）、`core/json`（deepCopy）、
  `core/security`（strip_sensitive）、`kernel/interrupt`（InterruptState）。
- 下游：`src/index.ts`（adapters 工厂面 `export *`）；宿主经
  `create_storage` 装配后注入 core/kernel 的 Storage seam 消费方
  （如 `core/memory` StorageBackedMemoryStore）；`test/adapters/storage/`
  （memory/sqlite/快照/分页）、`test/core/entities`、`test/e2e/`。

## 备注
- 写入不变量（三后端同口径）：新节点守卫式续链 + 链尾并发写保护；显式更新
  乐观锁 + 父指针不可变（父指针改写仅 `set_checkpoint_parent` 链级 rebase
  专属）；新节点 version 恒 1。
- GuardedStorage 令牌/豁免由 core 包装层负责（put_record opts 在包装层
  消费，不透传后端）；memory `close()` 幂等无操作，sqlite close 后再读写
  显式报错。
