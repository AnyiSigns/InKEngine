# InKling 机制覆盖矩阵

> 出厂门禁的逐行落点：每一行检查 ↔ 对应 e2e 用例/数据校验，状态绿或
> 显式标注跳过原因。矩阵是交付物——「引擎闸门验数据、Rust 编译器验
> 机制、样例 fixture 验绑定、覆盖矩阵验机制全用」的分工闭环中，本矩阵
> 负责「机制全用」的可审计清单。
>
> 运行口径：`pytest seeds/inkling/tests/e2e`（引擎 pytest 环境，仓库根
> 运行；stub AsyncLLM 离线确定性，真实模型 live 评测不入出厂门禁）。
> M4 出厂终态：四项门禁一键聚合入口 = `seeds/inkling/self_check.py`
> （schema / cargo test / frontend typecheck / e2e，命令以
> manifest.json self_check 为单一事实源），本矩阵行 ↔ 门禁 ↔ 用例
> 逐行呼应。
> 当前全量：198 passed + 3 skipped（skip 明细见文末）。

## 一、身份与数据基线

| 检查 | 落点（用例/校验） | 状态 |
|---|---|---|
| manifest 身份定稿值（id/name/positioning/domain_boot/version/theme 逐字比对） | tests/schema/validate_seed_data.py check_manifest + manifest.schema.json | 绿 |
| 自举提示词定稿（逐字比对 §5.1 原文） | tests/schema/validate_seed_data.py（boot_prompt 定稿断言）+ test_full_loop.py 注入步骤（host.boot_prompt == 定稿形态） | 绿 |
| seed_data 17 文件 schema 全量校验（缺失/多余/类型/空值边界） | validate_seed_data.py 逐文件 schema 校验（17 schema + manifest schema） | 绿 |
| 跨文件一致性（graph↔workflow、ui_spec↔event_types↔manifest、rules↔review、tools↔workflow、samples↔rules） | validate_seed_data.py 第四步 + exec/tests/binding.rs（谓词↔样例绑定） | 绿 |
| 自检矩阵四项门禁命令真实可执行（一键聚合入口） | manifest.json self_check（schema/cargo_test/frontend/e2e，状态全 ready）+ `seeds/inkling/self_check.py`（M4 出厂门禁入口：命令/状态/耗时/摘要矩阵化报告，失败非零退出） | 绿（M4 落点） |
| 引擎零改动（种子侧装配无引擎源码变更） | git diff 仅 seeds/（本阶段提交范围） | 绿 |

## 二、装配与界面

| 检查 | 落点（用例/校验） | 状态 |
|---|---|---|
| AssemblyRecipe 18 字段全落值 | test_boot_assembly.py test_recipe_17_fields_all_populated（用例名沿用历史命名，断言按源码字段数自省） | 绿 |
| UI 三层白名单与 seed_data 同源推导 | test_boot_assembly.py test_three_layer_whitelists_derived_from_seed_data | 绿 |
| 基线 ui_spec 过三层白名单校验 | test_boot_assembly.py test_ui_spec_passes_three_layer_validation | 绿 |
| 渲染器契约同源（前端注册组件集 = manifest 白名单） | test_execution_depth.py test_renderer_contract_same_source_with_engine_whitelist（夹具组件集 ⊆ 白名单 + 主题 token 同源） | 绿 |
| 未声明组件/通道/token 拒绝渲染（引擎校验侧） | test_execution_depth.py test_ui_three_layer_whitelist_rejects_undeclared | 绿 |
| 损坏 ui_spec 回落未定形（不击穿启动） | test_execution_depth.py test_damaged_ui_spec_falls_back_unformed | 绿 |
| boot 装配闭环（注入→挂载→回合→内省） | test_boot_assembly.py test_boot_assembly_loop / test_ui_spec_survives_boot_and_inspectable | 绿 |

## 三、MCP 挂载

| 检查 | 落点（用例/校验） | 状态 |
|---|---|---|
| 出厂零预挂（市场目录数据，无默认挂载） | test_mcp_mount.py test_market_zero_premount | 绿 |
| 设置页一键挂载（市场 → vetting → L2 → 补丁链） | test_mcp_mount.py test_mount_from_market_in_memory | 绿 |
| 审批拒绝（reject 不落链） | test_mcp_mount.py test_mount_rejected_by_approval | 绿 |
| vetting 卡前拒绝（命令白名单守卫） | test_mcp_mount.py test_mount_vetting_rejected_before_card | 绿 |
| 挂载回退（链版本还原 + 工具失效） | test_mcp_mount.py test_mount_revert_restores_chain | 绿 |
| 对话式安装（propose_mcp_mount 地址解析 → 审批卡预览 → edit 重走校验链） | test_mcp_mount.py test_conversational_install_happy_path / test_conversational_install_edit_revalidates | 绿 |
| 地址解析规则（市场 id / http(s) / npm: / git:） | test_mcp_mount.py test_address_resolution_rules | 绿 |
| 三传输闭环：in_memory / stdio / http | test_mcp_mount.py test_transport_in_memory_full_loop / test_transport_stdio_rust_exec / test_transport_http_full_loop | 绿（stdio 为真实 Rust 执行件；执行件未构建时该用例显式 skipif，构建后跑绿） |
| 连接失败结构化降级（无残留会话/补丁） | test_mcp_mount.py test_connect_failure_degrades_cleanly | 绿 |
| 全链路挂载步骤（in_memory 嵌入式 + stdio 真执行件） | test_full_loop.py test_full_loop_incubate_chain ② / test_full_loop_stdio_rust_exec | 绿（stdio 用例 skipif 同三传输口径） |

## 四、执行域

| 检查 | 落点（用例/校验） | 状态 |
|---|---|---|
| plan_policy 两档（loose 域内放行 / strict 边序约束） | test_execution_domain.py test_plan_policy_loose_within_domain / test_plan_policy_strict_requires_workflow_edge_order | 绿 |
| plan_workflow 约束域（越域失败） | test_execution_domain.py test_plan_workflow_constraint_out_of_domain_fails | 绿 |
| max_plan_steps 护栏（0 = 禁用规划） | test_execution_domain.py test_max_plan_steps_guardrail / test_plan_disabled_when_max_plan_steps_zero | 绿 |
| spawn 子任务展开与合并 + max_spawns 护栏 | test_execution_domain.py test_spawn_subtasks_expand_and_merge / test_max_spawns_guardrail | 绿 |
| 推演评估择优（review.json 打分配置 + 事实锚点 + 分支上限） | test_execution_domain.py test_simulate_evaluates_and_selects_best / test_simulate_facts_anchor_cross_validation / test_max_simulations_guardrail | 绿 |
| branch_mixer 注入（调配策略换选） | test_execution_domain.py test_branch_mixer_injection | 绿 |
| 预算护栏（超限自动终止） | test_execution_domain.py test_budget_guardrail_auto_terminates | 绿 |
| checkpoint_keep 链压缩窗口 | test_execution_domain.py test_checkpoint_keep_chain_compaction | 绿 |
| 异常策略（重试/跳过/终止） | test_execution_domain.py test_max_node_retries_transient_recovery / test_error_on_exception_skip / test_error_on_exception_terminate | 绿 |
| StateSchema reducer 注册表 | test_execution_domain.py test_state_schema_reducer_registry / test_state_schema_custom_reducer_registration | 绿 |
| trace_id 传播 + 事件传输收集 | test_execution_domain.py test_trace_id_propagation / test_transports_collect_engine_events | 绿 |

## 五、调配域

| 检查 | 落点（用例/校验） | 状态 |
|---|---|---|
| 五源统一预算（分池裁剪 + 激活留痕） | test_assembly_domain.py test_five_source_budget_allocation / test_five_source_budget_trim_drops_low_priority | 绿 |
| 记忆源（MemoryStore + 失效窗口 + 优先级召回） | test_assembly_domain.py test_memory_store_recall_with_expiry_window | 绿 |
| 检索源注册表注入与合并（注入文本剔除） | test_assembly_domain.py test_retriever_registry_injection_and_merge | 绿 |
| Embedding 检索可选（缺省关键词基线） | test_assembly_domain.py test_embedding_retriever_optional_llm | 绿 |
| 上下文融合钩子失败自动回退 | test_assembly_domain.py test_fusion_hook_failure_falls_back | 绿 |
| 域窗口投影 / 归档摘要 | test_assembly_domain.py test_domain_window_projection_and_archive_digest | 绿 |
| 五源源提供者进回合（引擎预装配闭环） | test_assembly_domain.py test_assembly_sources_provider_in_round / test_assembly_single_source_failure_does_not_block | 绿 |

## 六、模型层

| 检查 | 落点（用例/校验） | 状态 |
|---|---|---|
| 四挡位建链（router/tool/main/audit） | test_model_layers.py（按挡位建链用例） | 绿 |
| 缺省回退链（挡位配置缺失回落主挡位） | test_model_layers.py（回退链用例）+ test_knowledge_depth.py test_review_threshold_and_tier_semantics_linked | 绿 |

## 七、工具安全纵深

| 检查 | 落点（用例/校验） | 状态 |
|---|---|---|
| 权限分级判定（allow/review/deny + 网络策略） | test_tool_security.py（三档门禁/网络策略用例） | 绿 |
| 文件/进程沙箱（写前快照/超时 kill/越界拒绝） | test_tool_security.py（沙箱代理用例） | 绿 |
| vetting（静态钩子 + L2 影子运行 fail-closed） | test_tool_security.py（影子 vetting 用例） | 绿 |
| 工具调配器按子任务动态组装（去重/留痕） | test_tool_security.py（动态组装用例） | 绿 |
| OS 七件 command 固定枚举（白名单） | test_tool_security.py test_command_enum_mismatch_rejected | 绿 |
| 审批策略全姿势（单动作/合并卡/策略直过/超时 fail-closed） | test_tool_security.py（审批矩阵/超时用例） | 绿 |
| 决议重入样板（resume_run 旧卡恢复/过期拒绝/已决去重） | test_tool_security.py test_resume_run_old_card_recovery / test_resume_run_already_decided_dedupe / test_expired_card_rejected_fail_closed | 绿 |
| 工作区授权与撤销（授权卡 → 文件工具生效/失效） | test_ai_dev_mode.py test_workspace_authorization_card_flow / test_workspace_revoke_returns_to_denied / test_ai_dev_unauthorized_write_rejected | 绿 |

## 八、环境域

| 检查 | 落点（用例/校验） | 状态 |
|---|---|---|
| 三提供器注册表（local/web_bridge/container） | test_env_assembly.py（提供器注册/选择用例） | 绿 |
| ENVIRONMENT 补丁演化与回退（声明回落基线 + 实例重建） | test_env_assembly.py（补丁/回退用例）+ test_self_hooks.py test_hook_environment_roundtrip | 绿 |
| container_provider 出厂落地（ensure/destroy 幂等、镜像描述 = 数据） | test_env_assembly.py（container 用例）；无 Docker 机器显式跳过 | 绿（1 例 skip：Docker 守护进程不可达，实现已出厂落地） |
| 环境声明结构化降级（ContainerUnavailable 缓存失败态） | test_env_assembly.py（降级用例） | 绿 |

## 九、构建域

| 检查 | 落点（用例/校验） | 状态 |
|---|---|---|
| 白名单构建 + 内容寻址产物 | test_build_pipeline.py test_build_whitelist_passes_content_addressed / test_build_non_whitelist_rejected | 绿 |
| 构建失败结构化（无产物记录） | test_build_pipeline.py test_build_failure_structured_no_artifact | 绿 |
| 冒烟门禁（通过/失败） | test_build_pipeline.py test_smoke_gate_pass_and_fail / test_smoke_fail_blocks_artifact_promote | 绿 |
| ARTIFACT 补丁挂载（L2 组合钩子 + 工具表生效） | test_build_pipeline.py test_artifact_patch_mounts_declared_tool / test_artifact_patch_vetting_hash_mismatch_rejected | 绿 |
| 容器部署（隔离边界） | test_build_pipeline.py test_container_deploy_full_loop；无 Docker 机器显式跳过 | 绿（2 例 skip：Docker 守护进程不可达，实现已出厂落地） |
| AI 开发闭环（写 → 构建 → 失败回流 → 修复 → 冒烟 → 挂载 → 回退） | test_ai_dev_mode.py test_ai_dev_full_loop_build_fix_mount | 绿 |

## 十、知识域

| 检查 | 落点（用例/校验） | 状态 |
|---|---|---|
| 分层晋升（work→project→user，id 跨层稳定，不跳级） | test_knowledge_depth.py test_promotion_lifecycle_id_stable_and_chain_landed / test_promotion_cannot_skip_level | 绿 |
| 晋升补丁落链/回退/审计（KNOWLEDGE 补丁形态） | test_knowledge_depth.py test_promotion_patch_revert_via_set_chain | 绿 |
| 孵化生命周期（draft → 闸门评审 → approved / 拒收不落库） | test_knowledge_depth.py test_gate_lifecycle_draft_to_approved_and_rejected | 绿 |
| L1 安全扫描（指令注入拦截） | test_knowledge_depth.py test_gate_l1_injection_rejected | 绿 |
| tiers/review 阈值联动（蒸馏挡位解析 + 评审阈值同源） | test_knowledge_depth.py test_review_threshold_and_tier_semantics_linked | 绿 |
| 导出/导入 round-trip（跨存储迁移） | test_knowledge_depth.py test_export_import_roundtrip_across_storage / test_export_import_persisted_on_shared_storage | 绿 |
| 非法导出显式拒绝 | test_knowledge_depth.py test_export_rejects_invalid_shape | 绿 |
| 补丁链分支/截断/压扁（历史前缀折叠） | test_knowledge_depth.py test_patch_chain_branch_truncate_rebase | 绿 |
| checkpoint 链压缩规划与执行（分支语义 + 窗口折叠） | test_knowledge_depth.py test_checkpoint_chain_compaction_plan_branch_semantics / test_checkpoint_chain_compaction_runtime_execution | 绿 |
| 图指纹版本化（HARNESS 改图 → 指纹变化，回退 → 还原） | test_knowledge_depth.py test_graph_fingerprint_versioned_by_harness_patch / test_round_graph_digest_stable_across_boot | 绿 |
| 执行件不进知识集（知识条目可序列化落库） | test_knowledge_depth.py test_export_import_roundtrip_across_storage（导出 = 补丁链纯数据形态） | 绿 |

## 十一、自指域

| 检查 | 落点（用例/校验） | 状态 |
|---|---|---|
| 9 类补丁全枚举全钩子（落链 → 即时生效 → 审计 → 回退撤销）：theme/ui/tool/rule/knowledge/harness/event_type/environment/artifact | test_self_hooks.py test_hook_theme_roundtrip ~ test_hook_artifact_roundtrip（每类一条） | 绿 |
| on_reverted 通知钩子（(patch_id, reason) 回调） | test_self_hooks.py test_on_reverted_notification_hook_direct | 绿 |
| GuardedStorage 旁路写防护（直写拒绝/令牌/豁免上下文） | test_self_hooks.py test_guarded_storage_blocks_direct_writes | 绿 |
| convergence_provider 收敛管制（同目标冷却，数据驱动 review.json max_rounds） | test_self_hooks.py test_convergence_cooling_blocks_repeated_target | 绿 |
| 同一链语义（挂载/环境/产物与其余类型同链互操作 + 链尾折叠回退） | test_self_hooks.py test_multi_kind_same_chain_semantics | 绿 |
| 审批分级矩阵（L0 直过 / L1 弹卡 / L2 vetting 前置） | test_tool_security.py test_patch_level_l0_l1_l2_matrix | 绿 |

## 十二、全链路

| 检查 | 落点（用例/校验） | 状态 |
|---|---|---|
| 喂资料 → 研究 → 孵化 → 沉淀闭环（注入→挂载→回合→推演→孵化→补丁→回退→续流→压缩→调优→领域长出） | test_full_loop.py test_full_loop_incubate_chain | 绿 |
| 全链路 stdio 真执行件形态（注入→挂载→真实调用→卸载撤销） | test_full_loop.py test_full_loop_stdio_rust_exec；执行件未构建时显式 skipif | 绿（本机 cargo build 后跑绿） |
| 领域长出 live 验证（真实运行路径：新规则经样例闸门放行 → 自指 KNOWLEDGE 补丁挂载 → 活跃态生效 → 链尾回退撤销） | `seeds/inkling/examples/factory_demo.py` 步骤七（M4 出厂演示脚本）+ test_full_loop.py ⑪——演示「机制被使用」而非仅「机制能跑」 | 绿（M4 落点） |
| 出厂演示脚本全链（StubLLM：注入→挂载→回合→孵化→补丁→回退→领域长出，人类可读中文分步 + 事件留痕 + 失败指引） | `seeds/inkling/examples/factory_demo.py`（`python seeds/inkling/examples/factory_demo.py`；stdio 真执行件已构建时走真实路径，未构建降级说明不中断） | 绿（M4 落点，本机全链跑通） |

## 十三、执行深度

| 检查 | 落点（用例/校验） | 状态 |
|---|---|---|
| 编辑重放（审批卡 edit 重走校验链：非法拒绝/合法落链） | test_execution_depth.py test_edit_replay_card_revalidates | 绿 |
| 编辑重放（回合日志截断 + 分叉重放，历史可追溯） | test_execution_depth.py test_edit_replay_fork_and_log_truncation | 绿 |
| 预算三态（正常完成/超限终止/超限恢复重试） | test_execution_depth.py test_budget_three_states | 绿 |
| 异常三态（重试/跳过/终止） | test_execution_depth.py test_error_three_states_retry_skip_terminate | 绿 |
| 生命周期（boot 幂等 / pause 拒新 / resume 恢复 / stop 排空 / 引擎重建缓存） | test_execution_depth.py test_lifecycle_boot_idempotent_and_rebuild_cache / test_lifecycle_pause_rejects_resume_recovers_and_stop_drains | 绿 |
| 知识晋升导出（晋升后导出含新层级） | test_execution_depth.py test_knowledge_promote_then_export_keeps_level | 绿 |
| 脱敏与 trace_id（日志 redact + trace_id 贯穿回合 + 存储剥离敏感值） | test_execution_depth.py test_log_redaction_and_structured_trace_id / test_trace_id_threads_round_and_storage_strips_sensitive | 绿 |
| 存储三后端（memory / sqlite 内存 / sqlite 文件落盘 + 重启链延续） | test_execution_depth.py test_storage_three_backends | 绿 |
| UI 三层白名单深度（拒绝/回落/同源） | test_execution_depth.py test_ui_three_layer_whitelist_rejects_undeclared / test_damaged_ui_spec_falls_back_unformed / test_renderer_contract_same_source_with_engine_whitelist | 绿 |
| 宿主件执行器注册契约（声明↔签名一致 + 权限/沙箱断言） | shell/tests（cargo test --manifest-path seeds/inkling/shell/src-tauri/Cargo.toml，免真实桌面） | 绿（M4 本机 27 例全过：17 执行器契约 + 9 MCP 协议 + 1 lib；真实桌面冒烟为遗留可选） |

## skip 明细（当前环境）

| 用例 | 原因 |
|---|---|
| test_env_assembly.py 1 例（container 声明→运行→销毁） | Docker 守护进程不可达（无 Docker 环境显式跳过，provider 实现已出厂落地） |
| test_build_pipeline.py 2 例（容器部署全链路/降级） | 同上 |
| test_mcp_mount.py stdio 用例、test_full_loop.py stdio 用例 | Rust 执行件未构建时 skipif（本机 cargo build 后已跑绿，非当前 skip） |
