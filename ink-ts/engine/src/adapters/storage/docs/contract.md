# adapters/storage — 存储后端（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` +
> `engine/AGENTS.md` · 移植源：Python `ink_engine/core/storage_memory.py /
> storage_sqlite.py / storage_schema.py / storage.py(create_storage)`

## 定位

core `Storage` async seam 的真实后端：memory（单进程/测试默认）与 sqlite
（Node 22.13+ 内置 node:sqlite DatabaseSync，单机默认持久后端）。三通道
（checkpoint 版本链 / 执行事件日志 / structured records）+ 全量快照/恢复，
与 Python 后端同口径；`create_storage` 按连接串协议前缀路由。

## 文件与职责

| 文件 | 职责 |
| ---- | ---- |
| `index.ts` | `create_storage` 工厂：scheme 解析、sqlite 少斜杠形态拒绝、空路径归一 `:memory:`、`..` 穿越防护、postgres 显式报错 |
| `memory.ts` | MemoryStorage 汇出 + create_memory_storage（实现全在分层基类） |
| `_base.ts` | 内存基座：AsyncLock 串行 + 三通道容器 + 链尾指针（只前进）+ 快照/恢复（JSON 往返，临时文件 + rename 原子落盘，恢复逐字段校验/重复 id 拒绝） |
| `_checkpoints.ts` | 版本链方法层：守卫式续链插入（悬挂/跨线程父指针、event_seq 回退、链尾已前进拒绝；fork 豁免）、显式更新乐观锁（父指针不可变、线程不可迁移）、链索引/删除/父指针改写 |
| `_events_records.ts` | 事件日志（append-only、seq 锁内自增、truncate/trim）+ records（剥离敏感键 + 严格 JSON、分页/前缀下推、delete_collection） |
| `_serialize.ts` | 序列化契约单实现：checkpoint/records 严格判定（类实例/函数/循环引用/NaN 拒绝）、事件负载宽松判定（default=str）、往返深拷贝 |
| `_records_page.ts` | 分页/前缀下推共享原语：prefix 上界 = 末位 code unit +1、cursor 严格大于续页、sqlite key-range 谓词 vs 内存升序窗口 |
| `sqlite.ts` | SqliteStorage 无状态编排面：三通道全方法 + 错误映射（CheckpointConflictError 透传，其余包 StorageError）、事件重放逐条容错 |
| `sqlite_base.ts` | 连接生命周期 + promise 链互斥（单连接写者语义）+ pragma 护栏（busy_timeout 5000/WAL/synchronous NORMAL）+ schema 自检（旧表缺列给删库指令）+ backup 快照/恢复（restore 限可信快照目录内常规文件） |
| `sqlite_checkpoints.ts` | SQL 语句与行转换：GUARDED_INSERT（单语句原子判定防 TOCTOU）/PLAIN_INSERT/乐观锁 UPDATE（SET 不含 parent_id）、行→CheckpointRecord（fromJsonable marker + InterruptState 还原）、更新返回库中真值 |
| `sqlite_json.ts` | strictDumps：断言（复用 _serialize）→ stringify 两步 |
| `sqlite_schema.ts` | 三表 DDL 单一权威（checkpoints/event_log/records，与 Python 同构一字不差）、SCHEMA_SQL 预生成、records 主键 (collection, key) |

## 对外契约面

- `create_storage(connString)` → `Storage`：`''`/`'memory'`/`'memory://'` →
  内存后端；`sqlite:///path`/`sqlite:///:memory:` → SqliteStorage；未知
  scheme / postgresql → 显式报错。
- `MemoryStorage` / `create_memory_storage` / `SqliteStorage` 直接导出。
- 公共面：`src/index.ts` adapters 工厂面 `export * from './adapters/storage/index.js'`。
- 实现的 Storage 能力面（与 core 契约一致）：get/put/list/chain/delete/
  set_checkpoint_parent（checkpoint 通道）、append_event/events_after/
  truncate_events/trim_events/latest_event_seq（事件通道）、put/get/list/
  list_records_page/delete_collection（records 通道）、snapshot/restore/
  close、`snapshot_capable` 能力声明。

## 数据形态（写入不变量，三后端同口径）

- 新节点（checkpoint_id=0）：父指针必须存在且同线程、event_seq 不回退、
  链尾仍是 parent_id（并发写冲突抛 CheckpointConflictError）；fork 分叉豁免
  校验（编辑重放锚点历史链）；新节点 version 恒 1。
- 显式更新（checkpoint_id≠0）：不存在抛 StorageError；跨线程归属拒绝；
  expected_version 乐观锁冲突抛 CheckpointConflictError；父指针不可变
  （改写仅经 `set_checkpoint_parent` 链级 rebase 专属操作）。
- 事件：seq 存储级原子自增（跨实例唯一单调）；append 返回序号（重放/续流
  可得）；负载落库前 strip 敏感键 + 宽松 JSON 往返。
- records：落库前 strip 敏感键 + 严格 JSON 判定（非 JSON 对象抛
  StorageError）；round trip 兼作深拷贝。
- 读取一律返回深拷贝副本（消费方修改不污染存储内快照）。
- sqlite 三表：checkpoints（版本链 + 乐观锁 + AUTOINCREMENT）、event_log
  （append-only）、records（collection+key 主键 upsert）。

## Seam 与 IO 边界

本目录即 IO 真实现层（adapters 允许 node:*）：`node:fs`（内存快照落盘）、
`node:sqlite`（DatabaseSync + backup + serialize/deserialize，后者
@types/node 缺声明以局部接口标注）。core/kernel 侧无任何存储 IO——
`Storage` 接口在 `core/storage/storage.ts`，宿主经 `create_storage` 装配后
注入。

## 装配与消费

宿主装配期 `create_storage("sqlite:///...")` → 注入 Runtime/机制消费方
（如 `core/memory` StorageBackedMemoryStore、GuardedStorage 包装层——令牌/
豁免在包装层消费，put_record opts 不透传后端）。内存后端 `close()` 幂等
无操作；sqlite close 后再读写显式报错（use-after-close 拒绝）。

## 不变式与门禁

- schema 变更即删库重建（不做迁移；启动期自检 checkpoints 表缺列并给出
  DROP 指令）。
- restore 语义 = 单管理者场景（宿主先收敛其它连接再恢复——文件级替换与
  SQL 级排队不互斥，代码注释已显式声明该边界）。
- gate 适用：adapters 反向私有 import 检查；`sqlite.ts`（356 行）按 gate
  规则头注豁免（无状态编排面单文件，拆文件破坏同库并发串行语义）。

## 测试

`test/adapters/storage/`：memory_checkpoints（版本链不变量）、
memory_events_records（事件/records）、memory_snapshot（快照/恢复）、
sqlite（三通道）、sqlite_file（文件库 + schema）、sqlite_snapshot
（backup/restore）、records_page（分页/前缀双后端对账）、helpers.ts；
另 `test/core/entities`（MemoryStorage 消费）、`test/e2e/`（runtime 装配
create_memory_storage）。
