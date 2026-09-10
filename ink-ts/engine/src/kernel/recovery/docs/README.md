# recovery/（kernel/recovery — 恢复/续流解析）

checkpoint 锚点解析 + 增量日志重放 + 子图锚点回溯的**纯解析函数**：
resume 语义（断线续流/新回合续链/编辑重放）的锚点选择、输入状态覆盖、
重放清单编排在此收敛；不触碰引擎运行态（计数器/链尾标志由调用方在解析后
置位），可独立测试。

## 文件
- `recovery.ts` — `resolve_resume`（恢复起点解析：初始状态归一/续链基底/
  锚点回溯/重放清单）+ `tail_checkpoint`（链尾查询）；顶层同线程契约
  （ENG5-13）与图版本校验（仅真恢复）在此。
- `recovery_anchors.ts` — `collect_resume_anchors`：整链索引一次取回后
  内存内按 parent_id 回溯（避免 O(链长) 次串行 DB 往返），收集各级子图
  锚点与最近顶层锚点。
- `recovery_types.ts` — `ResumeResolution`/`ResumeMap`（graph_path 的
  JSON 序列化作键，单射编码）/`ResolveResumeOptions`。
- `contract.ts` — 机制契约：effects=[storage_seam]、depends=[]。
- `index.ts` — 导出面（与 Python `__all__` 对齐）。

## 依赖
- 上游：`core/errors`、`core/events`（type）、`core/json`（type）、
  `core/storage`（Storage/CheckpointRecord/ChainLink）、`core/state`
  （StateSchema，type）。
- 下游：`kernel/executor`（_engine_execute 调 resolve_resume；checkpoint/
  spawn/simulate 调 tail_checkpoint；_node_context/_internals 用 ResumeMap
  类型）、`kernel/multipath/_runner_base`（tail_checkpoint）、
  `kernel/registry/contracts.ts`；公共面 `export * from
  './kernel/recovery/index.js'`；`test/kernel/recovery/`（2 文件）。
