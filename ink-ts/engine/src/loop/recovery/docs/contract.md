# kernel/recovery — 恢复/续流解析（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` +
> `engine/AGENTS.md`

## 定位

executor 恢复面的纯解析收敛层：恢复模型 = checkpoint 版本链快照 +
append-only 事件日志。断线续流（快照 + 增量重放）、新回合续链（链尾基底 +
输入覆盖，不重放）、编辑重放（截断 + 新分支）三类语义的锚点解析在此，
执行器 resume 接线消费其结果。

## 文件与职责

| 文件 | 职责 |
| ---- | ---- |
| `recovery.ts` | `resolve_resume(options)` 主解析：continue_chain 续链（读链尾为基底、schema 覆盖合并、不重放、不校验图版本）vs resume_from 真恢复（锚点快照 + reducer 覆盖 + 增量重放 + 顶层锚点回溯 + 图版本校验）；`tail_checkpoint` 链尾查询 |
| `recovery_anchors.ts` | `collect_resume_anchors`：整链索引一次取回 + 内存回溯；非空路径只收未完成/中断锚点（reason null 或 interrupted；reply/stop/error 终态为陈旧结果不收）；空路径取最近顶层锚点 |
| `recovery_types.ts` | `ResumeResolution`（state/last_checkpoint/resume_map/replay，frozen）、`ResumeMap`（JSON.stringify(path) 单射键）、`ResolveResumeOptions` 十一项选项面 |
| `contract.ts` | `recovery_contract`：effects=[storage_seam]、depends=[] |
| `index.ts` | 导出面（四公共 API + 两类型） |

## 对外契约面

- `resolve_resume(options) → ResumeResolution`；`tail_checkpoint(storage,
  thread_id)`；`collect_resume_anchors(storage, tail, resume_map) →
  [top_anchor, resume_map]`。
- 公共面：`src/index.ts:219` `export * from './kernel/recovery/index.js'`
  （全量直通）。
- 机制注册：`recovery_contract` 入 ALL_MECHANISM_CONTRACTS。

## 数据形态

- `ResolveResumeOptions`：storage（null = 纯内存无恢复语义）/state/schema/
  thread_id/chain_thread（spawn 实例独立子链）/resume_from/continue_chain/
  graph_path（顶层空数组才做嵌套回溯）/replay/resume_map/graph_version。
- `ResumeResolution`：解析产物四字段（replay = 待补发事件清单）。
- resume_map 键编码：`JSON.stringify(graph_path)`（Python tuple 键词典的
  TS 单射镜像）。

## Seam 与 IO 边界

- 消费 storage_seam 端口：只读四方法（get_latest_checkpoint/get_checkpoint/
  chain_index/events_after），经注入 Storage 接口调用；0-IO 不自持存储。
- 纯解析：不触碰运行态计数器/链尾标志（调用方解析后置位）。

## 装配与消费

executor 各层消费：`_engine_execute`（resolve_resume 主调用）、
checkpoint/spawn/simulate（tail_checkpoint 跨引擎续链跟随）、
_node_context/_internals（ResumeMap 形态）；multipath runner 复用
tail_checkpoint。宿主经公共面装配（存储后端由 adapters/storage 提供）。

## 不变式与门禁

- 重放纪律：事件只从最终锚点重放一次（resume_from 与回溯出的顶层锚点取
  后者，event_seq 不高于前者，重放区间为超集——先重放子集再重放超集会
  出现重复事件）。
- 顶层同线程契约（ENG5-13）：graph_path 为空时 chain_thread 必须 ===
  thread_id，分离只允许出现在嵌套层；违反抛裸 Error（见疑点）。
- 图版本校验只作用 resume_from（真恢复）；continue_chain 同 thread 换图
  合法不校验；不匹配抛 GraphVersionMismatchError；旧数据无指纹跳过校验。
- 已知边界：JS 无协作取消，重放集是超集是合法语义（消费方幂等）。

## 疑点与不一致

1. **契约违反抛裸 Error**：`resolve_resume` 内 ENG5-13 同线程断言用
   `throw new Error(...)`，而同文件锚点缺失抛 `StorageError`、版本不匹配
   抛 `GraphVersionMismatchError`——同一函数三种错误面（core/errors 的
   EngineError 族惯例未贯彻到底），代码未说明差异缘由。
2. **`collect_resume_anchors` 防御分支**：锚点不在链索引时构造临时
   ChainLink「沿传入记录回溯一步」——该异常状态无错误上报，静默降级
   （注释自述防御，未见测试覆盖该分支）。
3. **recovery.ts 头注**自述「执行器的恢复接线（scheduler resume 路径）随
   executor 移植后在宿主侧接入」——现存措辞是移植期叙述（scheduler 一词
   在 TS 侧无对应物），与当前代码（executor 已接线）状态不同步。
4. **`ResumeMap` 编码未复用**：`recovery_anchors.ts` 与
   `recovery_types.ts` 各自内联 `JSON.stringify(path)` 键编码，无共享
   helper（子图引擎路径匹配侧按同编码查表——编码若漂移两处会失配，仅靠
   约定同步）。
5. 目录无 impl.ts、测试镜像在 test/kernel/recovery/（与 AGENTS.md
   「同目录 *.test.ts」口径不符——与 registry/builder 组同款发现）。

## 测试

`test/kernel/recovery/`：recovery.test.ts（resolve_resume 三路径：续链/
真恢复/版本校验）、recovery_anchors.test.ts（回溯收集/终态不收/顶层锚点）。
