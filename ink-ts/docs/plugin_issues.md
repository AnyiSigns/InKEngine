# ink-ts 插件化文档问题卡（plugin_issues.md）

> 决策留痕。本卡在 W7-B 退役清理（d25a1b6）中随组装时代文档一并删除，决策链断开；
> 7F 波重建。原卡 #1–#28（2026-09-07~09-08，插件化阶段 1–9b、宿主分层与启动形态
> 裁决）为已落地历史决策，逐字保真可查 `git show d25a1b6^:ink-ts/docs/plugin_issues.md`；
> 本版编号自 **#29** 续起、连续编号，收录 **W6–W8 存续决策**（内容自
> `.kilo/wave-reports/w6*.md / w7*.md / w8*.md` 提炼），不回填实施进度。
> 主契约：`PLUGINS.md`；设计推演/计划：`docs/component_data_endgame.md`；
> 执行语义权威稿：`docs/agent_execution_design.md`。

## 已裁决项（W6–W8，2026-09-10 ~ 09-12）

| # | 日期/波次 | 问题 | 决策 | 落点 |
|---|---|---|---|---|
| 29 | 2026-09-10 W6-A1 | 白板块模型「谁读哪块/写哪块」的授权形态与缺省语义 | **授权三元组 `(scope, kind, access)` 为可见性唯一裁决源，默认拒绝 fail-closed**：grants={mode, entries[]}，条目无 owner 维度（契约固定）；读 = main 全可见 ∨ 作者读自己 ∨ 显式读条目，写 = main ∨ 显式写条目；未授权读 = 不返回该块（非抛错），未授权写 = 显式抛 `WhiteboardAccessError`；blind 意见互不可见靠「作者读自己」+ 不授权跨读落实，open 给全体协作者 opinion 读条目；五类块（task/opinion/board/conclusion/summary）默认写者/读者由 `default_whiteboard_grants(mode, collaborators, {userScope})` 派生；审计 = `scope × block × read|write`；序列化 `{version:1, grants, blocks, audit}` 未知键容忍 | `engine/src/core/whiteboard/{blocks,grants,board}.ts`（w6a1.md §二） |
| 30 | 2026-09-10 W6-close B | §7.2「运行中变更走 main 仲裁」的落地协议与审计兼容 | **唯一公共门面 `amend_grants(board, {changes, reason}, arbiter_scope)`**：变更声明形态 = 产物保留键 `__amend`（`__next` 同款结构化面，仅结构化、不做 free-text 提取）；仲裁者缺省 main、可经 `WhiteboardSession.arbiter` 召集声明；越权/结构非法 = 本 run fail-closed 显式失败，不留静默通道；**revoke 只收窄后续裁决、历史视图与 read 留痕无追回**（审计为唯一追溯面）；blind→open 升级走 grant 意见互读条目、**mode 字段保持召集声明不换**（mode 是缺省元数据，条目才是裁决源；open 召集即缺省共享无需变更）；审计最小改法 = action 词汇不动 + 审计 kind 扩位 `'amendment'`（否决改 BLOCK_KINDS 与扩 action 两案，块/授权词表与冻结口径不污染） | `engine/src/core/whiteboard/{grants,board,amend}.ts` + `engine/src/core/execution_runtime/{amend_runtime,run_loop,fan_in}.ts`（w6close_b.md §二） |
| 31 | 2026-09-10 W6-close A | `whiteboard_audit` 是否须在事件类型真源登记 | **无需登记**：`core/event_types/registry.ts` 发射宽松（未注册不阻断 + 折叠兜底 = 设计意图非缺口），读写/amendment 审计统一经既有事件带 `RunEvent(action='whiteboard_audit')` + `deps.on_whiteboard_audit` seam 双路转发，不另造通道；后续一切板面写路径审计同源复用本通道——W8-D `__board` 写审计经同一通道转发一次（生效分支显式转发防重复，与 `__amend` 同构） | `engine/src/core/execution_runtime/{run_loop,board_runtime}.ts`；`engine/src/core/event_types/registry.ts`（w6close_a.md §二、w8d.md 协议①） |
| 32 | 2026-09-10 W6-C1 | 圆桌裁决的数据面协议（纯函数、不摸白板/宿主） | **仲裁三档 user > quality > prior**（`ARBITRATION_PRIORITY` 可重排；quality = 双方分值俱有限且不等取高、相等/缺一放下探；prior = seq 小者；皆无 = `{side:null, basis:'tie'}` 交 main 拍板）；冲突检测双路径按信号强度分域（verdict 主路径对全部条目逐条两两、marker 次路径对去重组代表；包含关系且恰单边带反对标记 = 不合并让位冲突）；`adjudicate` 永不抛错（违规 → rejected 记原因；输入门禁 = entry.schema 优先、produces 契约回退）；同主题 = 同一批 fan-in；收敛三判据检查序 = 无新实质（digest 全等，digest 不含 seq）→ ≥k 确认（缺省 2，去重 owner）→ 触顶（缺省 8），**rounds_exhausted 非共识**（converged=false = 停止加轮移交 main 拍板、成本封顶） | `engine/src/core/collab/{normalize,opinion,adjudication,convergence}.ts`（w6c1.md §二/§三） |
| 33 | 2026-09-10 W6-C2 | convene 白板化全链的席位身份与裁决接线 | **意见块 owner = 席位身份**（目录席位 `<scope_id>#<i>`、临时 `temp_scope:<run_id>:0`），非共享目录 id——blind 隔离经 grants 落实而非仅时序、同 scope 并行实例间冲突可检出；子执行下发**单席位最小名册**（可见性等价、避免授权矩阵逐子执行放大）；轮间收敛比较以 `s{seat}` 席位号归一投影（opinions_digest 含 owner，前后轮同构比较）；main 裁决 turn = entry_scope='main' 独立子执行（主持人语义延伸，不走通道闸门），失败回落确定性投影记 degraded；verdict/stance 只进裁决条目面、不进块 content（WhiteboardBlock 固定五字段）；schema 门禁以协作方 produces 契约回退校验，被剔除意见不进综合、无采纳不空跑 main turn | `hosts/lib/src/execution/{convene,convene_board,convene_params}.ts`（w6c2.md 决策点 2/3/5/6） |
| 34 | 2026-09-10 W7-C | 结晶转正阈值取值与 sighting 证据记账 | **`CRYSTALLIZE_MIN_SIGHTINGS=5` / `CRYSTALLIZE_MIN_SUCCESS_RATE=0.8`**：转正门槛不低于择优下架证据线（ORG_RETIRE_MIN_EVIDENCE=5，经验证的小样本下限）；成功率线介于常胜升级线 0.9 与失败域 0.5/0.6 之间——转正须「明显可信」非常胜级严格；**degraded 计分母不计分子**（带短板完成不占转正票，宁缺毋滥）；模式键 = role × 规范化 model（persona 不进键）；观测幂等键 `run_id#seat`（重跑不重复记票）；资产 id 前缀 `crystal:` 防与出厂身份撞名；证据 sample_run_ids 滚动上限 8（审批卡可读性封顶）；sighting 只来自 convene 临时链 settle 点（execution.run 临时入口不进证据流）；观测行走 Storage 普通通道 `org.temp_sightings`（非演化资产，不碰补丁链） | `engine/src/core/controlled_evolution/crystallize.ts` + `hosts/lib/src/execution/convene_board.ts` + `hosts/lib/src/bridge/evolution.ts`（w7c.md §三） |
| 35 | 2026-09-11 W8-C | §六择优半环「只进不出」（提案无宿主入口）的收口与闸行为 | **`evolution.evaluate` 桥与 `evolution.crystallize` 完全对称闭环**：org.archive 快照（flush 收口后读，损坏 = `invalid_archive` 显式拒，不静默空评）→ `evaluate_and_adapt` 产 apply_shortcut/downrank/retire_scope 三提案（keep 仅进回执）→ 三类全在 `GATE_MANDATORY_KINDS` 强制隔离试跑 + 审批 + `ControlledEvolutionApplier` 补丁链落库（复用件与结晶环同源，headless 无挂卡 = `approval_required` fail-closed）；**择优试跑探针 = 「变更意图指向的入口作用域」**（retire=payload.scope、shortcut/downrank=链起点 from；prior 两类缺省探针三键皆无恒 inconclusive，探针使其可验；目标不在装载面 = null → inconclusive → 宁拒勿放）；**参数面放宽 ≠ 通道放宽**（配置只改哪些提案被产，逐条真闸真审批不动）；下架对准宿主实传 `directory_scopes`（在册未 retired 资产 id），退役后重跑幂等 | `engine/src/core/controlled_evolution/{pruning,pruning_adapter,adoption_gate,controlled_applier}.ts` + `hosts/lib/src/bridge/evolution.ts` + `plugins/commands/evolution.evaluate/`（w8c.md §1/§3/§8） |
| 36 | 2026-09-11 W8-C | §十一#6 实验参数固化：评估阈值与白板护栏的产品配置面 | **阈值键表单一真源 = 引擎 `ORG_THRESHOLD_CONFIG_KEYS`**（11 蛇形键 ↔ PruningThresholds 驼峰一一对照，宿主不维护第二表）：配置路径 `model_config.org_evolution.evaluate_thresholds`，值域观测计数=正整数 / 比率=[0,1]，**缺省 = 现实验值零漂移**；非法键/越界值 = 忽略回缺省 + `thresholds_ignored` 逐条留痕、`thresholds_effective` 回显生效档（可审计「这次评估用了什么参数」）；白板护栏 n_max/R 中 `max_steps/max_cost/max_parallel` 经 `org_evolution.guardrails` 接入同一配置面（boot 读入只收非负整数，execution.run options 与 convene budget 覆写优先级不变）；**未成套项如实登记**：圆桌 R（`ConvergenceConfig.rounds_cap`）已是引擎 options 但装配缺省下发点在 convene 域文件、结晶阈值（函数已收 options 只差配置键登记）、`spawn_max_depth`（非择优参数）= 列后续波不强改 | `engine/src/core/controlled_evolution/evaluate_options.ts` + `hosts/lib/src/{boot.ts,bridge/evolution.ts}`（w8c.md §3 参数固化面） |
| 37 | 2026-09-12 W7-B | graph.instance / rounds.todos / approval.list·resolve 三链旧卡面处置 | **整链退役（读死状态旧件，不修复不复活）**：桥面 + 命令插件 + renderer `graphInstanceSnapshot` + evolution_feed「当前回合图组成」段 + introspection `snapshot_graph` 子面与 `set_graph` 生产侧（实测零调用方）+ `BOOT_METATOOLS` 12→11 + 5 个组装事件类型摘除（事件 43）+ CLI `legacy_aliases` 退役别名（`todo_get`/`graph_instance_snapshot`/`pool_*`/`assemble_stats`/`cache_stats`/`path_state`/`session_branch` 等）命中之 -32601 不留别名；cli TUI todos/approvals 视图与 `run_live.ts` 死命令字符串消费 = **保留 + 标注优雅降级不崩**（跨会话挂起卡列表 = 按「从 exec 链尾 interrupt 态新建、不复活旧件」的后续新功能面）；`rounds.branch/fork_trial` 执行模型等价物另由 `execution.branch`（W8-D）承接；连带基线：契约 34→31、插件 159→144、产品开关表 9→7、`orphan_allowlist` 13→12 | 删除面见 d25a1b6 文件树；消费同步 = `ink-ts/CODING.md` §9/§10、`PLUGINS.md`/`plugins/AGENTS.md`、引擎模块 docs 逐行回填（w7b.md §2/§5/§9.3） |
| 38 | 2026-09-12 W7-B | 退役清单中 §八「图=投影」与审批机制本体是否随退 | **两个「不退役」语义单列**：①§八 图=投影——语义未退，**投影数据源从「组装图快照」换为执行轨迹/RunEvent 流**，执行树（`execution.run` 回执 + W8-A 实时事件 → renderer executionIngest/executionTree）= 轨迹投影现役形态；将来图形态观察/审计面从组织档案/RunEvent 新建投影，不复读死状态旧件；②审批机制本体——`kernel/approval` 内核、`review_card` 插件、`self_application`/补丁链/`GuardedStorage` 受控通道全家原样保留；挂起卡用户可见面 = send/resume 回执 `pending{key,payload,checkpoint_id,run_id}` + 执行中弹卡 + `rounds.resume → execution.resume` 决议注入续跑（退役的仅是旧线程链卡队列**桥命令面**）；会话簿记延续 = 回合归档 checkpoint 薄留痕落会话线程链（`records.chain`/`sessions.messages` 只读投影零感知） | `engine/src/kernel/approval/**` + `plugins/ui_features/review_card/**` + `hosts/lib/src/{bridge/rounds.ts,execution/service.ts}` + `renderer/src/shared/session/{executionIngest,executionTree}.ts`（w7b.md §3；w7a.md 语义对齐清单） |

## 重建与后续核对注

- **#29–#31 / #33 关联**：board 类块「协作者写、全体+main 读」授权早已声明（#29），
  运行时写路径 W8-D 才补齐（`__board: {kind:'board', op:'append', content}`，写授权
  前置判定 main/open/grants 显式条目三档、双层 fail-closed、盲模式无授权 = 显式拒绝
  判失败；块 seq = 累计审计条数+1 单调插入计数恢复延续）——落点
  `engine/src/core/execution_runtime/board_runtime.ts`（w8d.md 协议①）。
- **#34 关联**：产品结晶入口 = `evolution.crystallize` 受控通道；旧触发源（指纹命中 +
  组装 settle sighting）随 W7-B 退役，`kernel/skill_crystal` 容器与 memory_recall/
  skill 检索消费保留 + 标注（触发器运行恒空观测位属现状，非死读面误判）。
- **数字基线（2026-09-12 终检，7F 复核复现）**：engine 244 文件 / 2592 passed / 2
  skipped；hosts/lib 42 文件 / 282 passed / 0 failed（链 cwd 口径；仓库根命令式现
  host_spec×4 + retrieval×1 = 既有环境假阳性名单成员，见 w7b.md §7）；机制契约 31 项；
  插件 146 = tool 42 + mcp 5 + command 64 + ui_feature 32 + endpoint 3。来源 = 波次
  终检复跑（vitest 双根 / verify:mechanisms / `sync_plugin_manifest.mjs --check`）；
  历史数字演进链（159→144→145→146、62→63→64 等）以 w7b/w8c/w8d 报告为准。
- 原卡「实施时须现场核对」各阶段小节属阶段 1–9b 历史操作指引，其结论均已入码，
  不再重录；查证一律走 `git show d25a1b6^`。
