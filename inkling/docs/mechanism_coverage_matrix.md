# InKling 机制覆盖矩阵（Rust 侧）

> 出厂门禁的逐行落点：每一行检查 ↔ Rust 域测试/引擎回归断言，状态绿或
> 显式标注等价降级理由。本矩阵是机制覆盖的审计清单——「引擎闸门验数据、
> Rust 编译器验机制、样例 fixture 验绑定、覆盖矩阵验机制全用」的分工闭环
> 中，本矩阵负责「机制全用」的可审计记录。
>
> 迁移口径：原 Python 侧 e2e 断言（198 passed 口径）按行迁移为两类落点——
> ①Rust 域测试（壳 crate `inkling/shell/src-tauri`，`cargo test` 全量）；
> ②引擎 retain 回归（`ink_engine/tests`，机制级断言保留在引擎测试套件）。
> 纯数据规格类（manifest 定稿全文比对、seed_data JSON-schema 深度校验、
> 演示脚本）随 Python 校验工具退场，由 Rust 自检编排在出厂门禁中恢复。
> 状态标记：绿 = Rust 侧断言直落；等价降级 = 语义由引擎 retain 或 Rust
> 分段测试覆盖，此处注明理由。

## 一、身份与数据基线

| 检查 | Rust 侧落点 | 状态 |
|---|---|---|
| manifest 身份定稿值（id/name/positioning/domain_boot/version/theme 逐字比对） | recipe.rs `manifest_identity_fields_are_frozen` | 绿 |
| 自举提示词定稿（逐字比对设计文档第五节第一小节原文） | prompt.rs `boot_prompt_seed_loads_and_layers_split` / `injection_meets_tenfold_ratio_with_real_seed`（结构 + 关键段 + 注入比例） | 绿（等价降级：定稿全文逐字比对属数据规格校验，随 Python 校验脚本退场，由出厂自检 schema 门禁恢复；Rust 断言结构/段/比例不变式） |
| seed_data 22 文件 schema 全量校验（缺失/多余/类型/空值边界） | recipe.rs `load_seed_data_reads_all_seed_files`（循环遍历 SEED_DATA_FILES=21 + entities.json 单独装载）/ `load_seed_data_errors_on_missing_file`（齐备 + 对象形态 + 缺文件报错） | 绿（等价降级：JSON-schema 类型/空值深度校验随 Python 校验脚本退场，由出厂自检 schema 门禁恢复（22 件）；Rust 断言装载完整性 + 各域字段契约） |
| 跨文件一致性（graph↔workflow、ui_spec↔event_types↔manifest、rules↔review、tools↔workflow、samples↔rules） | recipe.rs `ui_channels_union_of_three_sources` / `ui_components_match_manifest_contracts` / `ui_theme_tokens_from_ui_spec_theme` / `event_type_specs_mirror_seed_data`；prompt.rs `tool_name_map_from_seed_is_sorted_and_labeled`；exec `tests/binding.rs`（谓词↔样例绑定）；工作流/工具族一致性由 schema 门禁跨文件校验承担 | 绿 |
| 自检矩阵七项门禁命令真实可执行（一键聚合入口） | 出厂自检编排（Rust 自检：schema/data 一致性 / cargo 三 crate / frontend / 接线 e2e / 代码纪律 / 公开评测基准 / 符号引用计数，`inkling/self_check/` 二进制；manifest.json self_check 为命令单一事实源，`all` 聚合模式真实执行表内命令） | 绿（Rust 自检编排已落地：七门禁一键矩阵化报告，门禁命令经 manifest 登记并由编排器真实执行；schema/e2e 门禁随编排恢复） |
| 引擎零改动（种子侧装配无引擎源码变更） | git diff 仅壳/文档（本阶段提交范围） | 绿（等价降级：工作流约束，经 git diff 审计，非断言落点） |

## 二、装配与界面

| 检查 | Rust 侧落点 | 状态 |
|---|---|---|
| AssemblyRecipe 22 字段全落值 | recipe.rs `recipe_assembles_all_data_fields`（set_id/ui_spec/白名单/事件类型/种子/审批分级全落值，断言按字段自省）；schema 门禁以 runtime.py 源码核对字段数=22 | 绿 |
| UI 三层白名单与 seed_data 同源推导 | recipe.rs `ui_channels_union_of_three_sources` / `ui_components_match_manifest_contracts` / `ui_theme_tokens_from_ui_spec_theme` | 绿 |
| 基线 ui_spec 过三层白名单校验 | live.rs `validate_ui_spec_enforces_three_whitelists`（种子界面零违规） | 绿 |
| 渲染器契约同源（前端注册组件集 = manifest 白名单） | recipe.rs `ui_components_match_manifest_contracts`（组件集 = manifest contracts.renderer_components）+ `ui_theme_tokens_from_ui_spec_theme` | 绿 |
| 未声明组件/通道/token 拒绝渲染（引擎校验侧） | live.rs `validate_ui_spec_enforces_three_whitelists`（越界组件/通道/token 各自报违 + 缺 root 显式违） | 绿 |
| 损坏 ui_spec 回落未定形（不击穿启动） | live.rs `restore_ui_theme_falls_back_to_baseline_and_validates`（链上无覆盖回落基线；校验不过保持现状不击穿）；引擎装配侧回落语义由引擎 retain（test_runtime）覆盖 | 绿 |
| boot 装配闭环（注入→挂载→回合→内省） | boot.rs `assemble_succeeds_with_ready_wiring`（工具/事件/链版本/目标种类/种子守恒）；engine host.rs `boot_stub_round_and_protocols`（注入→回合→事件流）+ `op_channel_domain_actions`（内省生效） | 绿 |

## 三、MCP 挂载

| 检查 | Rust 侧落点 | 状态 |
|---|---|---|
| 出厂零预挂（市场目录数据，无默认挂载） | mcp.rs `market_zero_premount_and_service_registry` | 绿 |
| 设置页一键挂载（市场 → vetting → L2 → 补丁链） | mcp.rs `vetting_checks_per_transport_and_whitelist` / `l2_hook_requires_vetted_server` / `approval_card_and_edited_config_revalidates` / `mount_config_fails_structurally_without_engine`（校验链全段 + 结构化失败） | 绿（等价降级：挂载执行段（connect→import→落链→重建）须引擎 MCP 运行环境，由引擎 retain + 集成 e2e 覆盖；Rust 侧覆盖校验链与执行段 fail-closed） |
| 审批拒绝（reject 不落链） | mcp.rs `propose_mount_failures_are_structured`（vetting 拒绝未到审批卡）；审批决议 fail-closed 上下文（未注入决议 = 拒绝） | 绿（等价降级：「拒绝不落链」的链效应 = 引擎审批机制（test_approval/test_self_application retain），Rust 侧覆盖拒绝前置与结构化失败） |
| vetting 卡前拒绝（命令白名单守卫） | mcp.rs `vetting_checks_per_transport_and_whitelist`（stdio 白名单外命令拒绝）+ `propose_mount_failures_are_structured`（vetting 拒绝 → 未到审批卡） | 绿 |
| 挂载回退（链版本还原 + 工具失效） | mcp.rs `unmount_precheck_detects_tail_conflict`（链尾冲突预检）；回退执行 = `patch.revert` op（engine host.rs `op_channel_domain_actions` 回退闭环） | 绿 |
| 对话式安装（propose_mcp_mount 地址解析 → 审批卡预览 → edit 重走校验链） | mcp.rs `approval_card_and_edited_config_revalidates`（提案 → 审批卡 → edit 重校验：非法拒绝/合法落链）+ `address_resolution_four_rules` | 绿 |
| 地址解析规则（市场 id / http(s) / npm: / git:） | mcp.rs `address_resolution_four_rules` + `market_entry_transport_defaults_to_http` | 绿 |
| 三传输闭环：in_memory / stdio / http | mcp.rs `vetting_checks_per_transport_and_whitelist`（三传输配置校验）；执行闭环（含 stdio 真执行件）由引擎 mcp_client retain + 集成 e2e 覆盖 | 绿（等价降级：传输级全闭环依赖执行环境（stdio 执行件/HTTP 服务），引擎 retain（test_mcp_client）覆盖传输语义，Rust 侧覆盖配置面与校验面） |
| 连接失败结构化降级（无残留会话/补丁） | mcp.rs `propose_mount_failures_are_structured`（解析/vetting 失败结构化）；连接失败语义 = 引擎 mcp_client retain | 绿（等价降级：连接失败的无残留语义 = 引擎 mcp_client 会话管理 retain 覆盖） |
| 全链路挂载步骤（in_memory 嵌入式 + stdio 真执行件） | 挂载链各段（校验/vetting/L2/审批/回退）分段覆盖如上；完整挂载闭环由集成 e2e 覆盖 | 绿（等价降级：全链路执行闭环为引擎回合级集成场景，由出厂自检「接线 e2e」覆盖） |

## 四、执行域

| 检查 | Rust 侧落点 | 状态 |
|---|---|---|
| plan_policy 两档（loose 域内放行 / strict 边序约束） | 执行约束 = 引擎 RunOptions 机制（test_plan/test_runtime retain）；Rust 侧策略层 policy.rs 覆盖计划域约束翻译 | 绿（等价降级：plan_policy 档位语义 = 引擎执行机制 retain 覆盖；Rust 侧覆盖产品面翻译） |
| plan_workflow 约束域（越域失败） | policy.rs `out_of_domain_node_fails_closed` / `workflow_seed_yields_six_node_constraint_domain` / `router_plan_within_node_set_but_foreign_decision_rejected` | 绿 |
| max_plan_steps 护栏（0 = 禁用规划） | 引擎执行机制（test_plan/test_runtime retain：护栏/零禁用规划）；Rust 侧 policy.rs 覆盖确定性回退与计划形态 | 绿（等价降级：护栏执行语义 = 引擎 retain 覆盖） |
| spawn 子任务展开与合并 + max_spawns 护栏 | policy.rs `spawn_groupings` / `router_plan_with_simulate_needs_groups` / `downgrade_plan_strips_spawn_and_simulate`（分组/降档翻译）；引擎展开合并语义（test_spawn/test_plan retain） | 绿（等价降级：引擎侧展开/合并/护栏 retain 覆盖） |
| 推演评估择优（review.json 打分配置 + 事实锚点 + 分支上限） | exec `tests/binding.rs` `score_cross_validation_binds_to_samples_facts`（样例事实锚点评分绑定）+ review.rs 管线；分支上限 = 引擎 simulation retain（test_simulation） | 绿（等价降级：择优/上限执行语义 = 引擎 retain 覆盖；样例锚点评分落点在 exec 执行件测试） |
| branch_mixer 注入（调配策略换选） | 引擎 simulation 机制（test_simulation retain：mixer 注入） | 绿（等价降级：注入语义 = 引擎 retain 覆盖） |
| 预算护栏（超限自动终止） | 引擎执行机制（test_executor retain：预算超限终止）；Rust 侧 policy.rs 覆盖计划域预算翻译；调配预算分配 = 引擎 assembly retain（test_assembly） | 绿（等价降级：执行期预算护栏/调配预算分配 = 引擎 retain 覆盖） |
| checkpoint_keep 链压缩窗口 | 引擎链机制（test_chain_rebase retain：checkpoint 窗口折叠）；Rust 侧 session.rs 分支树 + boot.rs `chain_version_counts_patches_plus_one` 覆盖链形态 | 绿（等价降级：压缩执行语义 = 引擎 retain 覆盖） |
| 异常策略（重试/跳过/终止） | 引擎执行机制（test_executor retain：三态）；Rust 侧 policy.rs 覆盖降档/回退翻译 | 绿（等价降级：执行期异常策略 = 引擎 retain 覆盖） |
| StateSchema reducer 注册表 | 引擎状态机制（test_state/test_executor retain：reducer 注册表） | 绿（等价降级：reducer 注册 = 引擎 retain 覆盖） |
| trace_id 传播 + 事件传输收集 | steps.rs `transport_accumulates_protocol`（事件流 → 步骤序列，传输收集）；trace_id 贯穿 = 引擎事件机制 retain（test_events/test_executor） | 绿（等价降级：trace_id 生成/贯穿 = 引擎 retain 覆盖） |

## 五、调配域

| 检查 | Rust 侧落点 | 状态 |
|---|---|---|
| 五源统一预算（分池裁剪 + 激活留痕） | 引擎 assembly retain（test_assembly：InputAssembler 分级分配 + 激活记录序列化）；壳侧 boot.rs `path_assemble_op_stub_pool_roundtrip_and_tier_mapping` 覆盖路径组装池映射 | 绿（等价降级：五源装配为引擎机制，retain 覆盖） |
| 记忆源（MemoryStore + 失效窗口 + 优先级召回） | 引擎 memory retain（test_memory：MemoryStore/召回策略/非破坏性失效；memory.json 默认失效窗口 90 天） | 绿（等价降级：记忆机制 = 引擎 retain 覆盖） |
| 检索源注册表注入与合并（注入文本剔除） | 引擎装配 retain（test_assembly：注册表装配注入 + 注入扫描剔除）；知识集检索 = knowledge_set retain（test_knowledge_set：可信度分级排序） | 绿（等价降级：注册表装配注入 = 引擎 retain 覆盖） |
| Embedding 检索可选（缺省关键词基线） | engine host.rs `boot_without_embedder_stays_keyword_baseline`（未挂 embedding = 关键词基线）+ `boot_injects_local_embedder_into_retrieval_sources` / `local_onnx_bridge_embeds_with_real_model`（挂载后语义检索） | 绿 |
| 上下文融合钩子失败自动回退 | 引擎 ContextMixer 机制（test_context retain：fusion_hook 失败/None → fail-open 回落） | 绿（等价降级：融合钩子 = 引擎 core 机制，retain 覆盖回退语义） |
| 域窗口投影 / 归档摘要 | 引擎 context retain（test_context：域窗口投影切片/归档摘要确定性） | 绿（等价降级：域窗口机制 = 引擎 retain 覆盖） |
| 五源源提供者进回合（引擎预装配闭环） | 引擎 assembly retain（test_assembly：五源装配闭环 + 单源故障不阻断） | 绿（等价降级：进回合装配闭环 = 引擎 retain 覆盖） |

## 六、模型层

| 检查 | Rust 侧落点 | 状态 |
|---|---|---|
| 档位解析与模型档案（main/router/audit + 按档案取窗口） | model_archive.rs `default_context_window_follows_tier` / `fallback_archive_uses_tier_window_and_unknown_multimodal` / `refresh_failure_falls_back_to_default_tier_window`（档案缺省兜底）；security.rs `security_domain_from_tool_data_builds_tiers_and_file_defs`（工具数据档位解析） | 绿 |
| 缺省回退（档位配置缺失回落主配置） | 档位链构建 = 引擎 tiers retain（test_tiers：build_tier_chain/回退链）；Rust 侧 model_archive.rs 档案缺省兜底 + policy.rs 档位翻译 | 绿（等价降级：链构建/回退执行语义 = 引擎 retain 覆盖） |

## 七、工具安全纵深

| 检查 | Rust 侧落点 | 状态 |
|---|---|---|
| 权限分级判定（allow/review/deny + 网络策略） | security.rs `gate_deny_tier_unconditional` / `gate_allow_tier_passes_on_hit` / `gate_review_tier_requires_review_that_override_can_lower` / `gate_untiered_tools_pass_by_declaration` / `network_matches_suffix_and_glob` / `http_fetch_executor_network_policy_second_layer` | 绿 |
| 文件/进程沙箱（写前快照/超时 kill/越界拒绝） | security.rs `file_ops_executor_write_read_edit_rollback` / `workspace_validate_file_bounds_and_size` / `workspace_symlink_escape_rejected`；common.rs `run_command_timeout_kills_child` | 绿 |
| vetting（静态钩子 + L2 影子运行 fail-closed） | security.rs `shadow_vetting_store_mismatch_detection` / `l2_vetting_hook_fail_closed_chain` / `l2_vetting_hook_inner_passthrough`；mcp.rs `l2_hook_requires_vetted_server` | 绿 |
| 工具调配器按子任务动态组装（去重/留痕） | 引擎 assembly retain（test_assembly：工具源预算上限 + 次回合动态纳入） | 绿（等价降级：回合间动态组装 = 引擎装配 retain 覆盖） |
| OS 十件 command 固定枚举（白名单） | security.rs `resolve_process_exec_enum_mismatch_and_deny`（枚举外拒绝）；OS 控制清单 = `seed_data/tools.json` 真源（sync_tools_fixtures 生成物） | 绿 |
| 审批策略全姿势（单动作/合并卡/策略直过/超时 fail-closed） | 引擎审批机制 retain（test_approval/test_interrupt_persistence）；Rust 侧 security.rs `gate_*` 分级判定 + engine host.rs `approval.gate_card_request` op 闭环 | 绿（等价降级：审批卡/超时姿势 = 引擎审批 retain 覆盖） |
| 决议重入样板（resume_run 旧卡恢复/过期拒绝/已决去重） | 引擎审批机制 retain（test_runtime/test_interrupt_persistence：恢复/过期/去重） | 绿（等价降级：决议重入 = 引擎审批 retain 覆盖） |
| 工作区授权与撤销（授权卡 → 文件工具生效/失效） | security.rs `workspace_authorize_revoke_is_idempotent` / `workspace_validate_file_bounds_and_size` / `sandbox_proxy_file_ops_after_authorization` / `authorization_record_shapes_authorize_and_tombstone` | 绿 |

## 八、环境域

| 检查 | Rust 侧落点 | 状态 |
|---|---|---|
| 三提供器注册表（local/web_bridge/container） | env.rs `test_environment_domain_registry_three_providers` / `test_env_json_maps_to_three_specs` | 绿 |
| ENVIRONMENT 补丁演化与回退（声明回落基线 + 实例重建） | env.rs `test_merge_specs_baseline_plus_patch_increments` / `test_restore_applies_chain_values_and_ensures` / `test_environment_patch_declares_new_env` | 绿 |
| container_provider 出厂落地（ensure/destroy 幂等、镜像描述 = 数据） | env.rs `test_container_provider_structured_degrade_with_probe` / `test_container_provider_image_build_context_runs`（无 Docker 环境走显式降级断言，实现已出厂落地） | 绿（等价降级：Docker 守护进程不可达时断言降级路径；真实 ensure/destroy 由集成环境验证，与迁移前 skip 口径一致） |
| 环境声明结构化降级（ContainerUnavailable 缓存失败态） | env.rs `test_container_provider_structured_degrade_with_probe` / `test_container_provider_direct_degrades` / `test_ensure_unknown_env_is_structured_error` | 绿 |

## 九、构建域

| 检查 | Rust 侧落点 | 状态 |
|---|---|---|
| 白名单构建 + 内容寻址产物 | build.rs `test_build_whitelist_passes_content_addressed`（sha256 64 字符 + 同内容同 id 幂等 + 哈希校验）/ `test_build_non_whitelist_rejected`（白名单外拒绝 + 无半成品记录） | 绿 |
| 构建失败结构化（无产物记录） | build.rs `test_build_failure_structured_no_artifact` | 绿 |
| 冒烟门禁（通过/失败） | build.rs `test_smoke_gate_pass_and_fail` / 冒烟记录缺失/未通过拒绝 promote（`vet_artifact_patch` 断言） | 绿 |
| ARTIFACT 补丁挂载（L2 组合钩子 + 工具表生效） | build.rs `test_artifact_vetting_hook_fail_closed` / `test_payload_shapes_artifact_and_deployment` / `register_apply_target_fails_closed_without_engine` | 绿 |
| 容器部署（隔离边界） | build.rs `test_deploy_to_container_flow_and_degrades`（无 Docker 环境走显式降级断言，流程落地） | 绿（等价降级：Docker 守护进程不可达时断言降级路径；真实部署由集成环境验证，与迁移前 skip 口径一致） |
| AI 开发闭环（写 → 构建 → 失败回流 → 修复 → 冒烟 → 挂载 → 回退） | 分段覆盖：security.rs `file_ops_executor_write_read_edit_rollback`（写）+ build.rs 构建/冒烟/挂载/回退各段 + code_tools.rs 检索 | 绿（等价降级：完整闭环为引擎回合级集成场景，由出厂自检「接线 e2e」覆盖） |

## 十、知识域

| 检查 | Rust 侧落点 | 状态 |
|---|---|---|
| 分层晋升（work→project→user，id 跨层稳定，不跳级） | incubation.rs `promote_levels_are_sequential_and_id_stable`（顺序 + id 稳定 + 跳级拒绝 + 顶层拒绝） | 绿 |
| 晋升补丁落链/回退/审计（KNOWLEDGE 补丁形态） | live.rs `apply_knowledge_payload_upsert_protects_identity` / `knowledge_patch_changes_excludes_identity` / `restore_knowledge_view_aligns_chain_and_tracked`；回退 = `patch.revert` op 闭环（engine host.rs） | 绿 |
| 孵化生命周期（draft → 闸门评审 → approved / 拒收不落库） | incubation.rs `classify_routes_five_kinds_and_filters_noise` / `distill_keeps_success_paths_and_discards_pitfalls` / `gate_l2_shape_semantics` / `gate_l3_target_screening_semantics` / `verify_gate_short_circuits_on_l1_and_binds_l2_executor` / `samples_seed_baseline_positive_subset` | 绿 |
| L1 安全扫描（指令注入拦截） | incubation.rs `gate_l1_rejects_bad_shape_and_injection` / `gate_l1_injection_scan_pure_text` | 绿 |
| tiers/review 阈值联动（蒸馏挡位解析 + 评审阈值同源） | review.rs `review_config_reads_seed_thresholds` / score.rs `review_config_mirrors_seed_data`；蒸馏挡位 tiers.rs 链构建 | 绿 |
| 导出/导入 round-trip（跨存储迁移） | backup.rs `pack_validate_roundtrip_and_manifest` / `restore_unpacks_and_snapshots_current_state` / `restore_preview_counts_overwrites`（数据目录导出 = 补丁链纯数据形态） | 绿 |
| 非法导出显式拒绝 | incubation.rs `export_shape_validation_rejects_missing_base` / backup.rs `validate_rejects_tampered_and_foreign_files` / `restore_rejects_path_traversal_entries` | 绿 |
| 补丁链分支/截断/压扁（历史前缀折叠） | session.rs `branch_tree_maps_multi_leaf_chain`（分支树映射）；分支/续跑/回退 op 闭环（engine host.rs `op_channel_domain_actions`） | 绿（等价降级：截断/压扁执行语义 = 引擎链机制 retain（test_chain_rebase）覆盖） |
| checkpoint 链压缩规划与执行（分支语义 + 窗口折叠） | 引擎链机制 retain（test_chain_rebase：压缩规划/执行/分支语义）；Rust 侧 boot.rs `chain_version_counts_patches_plus_one` 覆盖链版本形态 | 绿（等价降级：压缩执行 = 引擎 retain 覆盖） |
| 图指纹版本化（HARNESS 改图 → 指纹变化，回退 → 还原） | 引擎指纹机制 retain（test_fingerprint：改图指纹变化/回退还原） | 绿（等价降级：图指纹 = 引擎 retain 覆盖） |
| 执行件不进知识集（知识条目可序列化落库） | backup.rs `pack_validate_roundtrip_and_manifest`（导出 = 数据目录纯数据形态，执行件不入包）；incubation.rs `entry_schema_field_contract` | 绿 |

## 十一、自指域

| 检查 | Rust 侧落点 | 状态 |
|---|---|---|
| 10 类补丁全枚举全钩子（落链 → 即时生效 → 审计 → 回退撤销）：theme/ui/tool/rule/knowledge/harness/event_type/environment/artifact/entity | 十类枚举：recipe.rs `recipe_assembles_all_data_fields`（approval_levels 10 类齐备）；活跃态钩子：live.rs `apply_ui_payload_switches_snapshot_when_root_present` / `apply_theme_payload_merges_tokens_into_theme_segment` / `apply_harness_payload_parses_definition` / `apply_rule_payload_builds_project_rule_entry` / `apply_knowledge_payload_upsert_protects_identity` + env.rs 环境目标 + build.rs 产物目标 + mcp.rs 工具目标 + live.rs `restore_event_types_unregisters_out_of_chain_types`；实体目标 = engine host（EntityApplyTarget）+ `entities:` 守卫 retain；审计形态：env.rs `test_audit_record_and_key_shapes` / security.rs `authorization_record_shapes_authorize_and_tombstone` | 绿 |
| on_reverted 通知钩子（(patch_id, reason) 回调） | 回退动作 = 链恢复重放段（boot.rs `assemble_chain` + live.rs `restore_*` + env.rs `test_restore_applies_chain_values_and_ensures` + build.rs 产物工具同步） | 绿（等价降级：回调触发点 = 引擎 self_application retain（on_reverted 调用语义）；宿主回退动作以 boot.rs 重放段 + 各域恢复测试覆盖同语义） |
| GuardedStorage 旁路写防护（直写拒绝/令牌/豁免上下文） | 引擎存储守卫机制 retain（test_self_application：GuardedStorage 直写拒绝/令牌/豁免） | 绿（等价降级：存储守卫 = 引擎 retain 覆盖） |
| convergence_provider 收敛管制（同目标冷却，数据驱动 review.json max_rounds） | recipe.rs `convergence_max_rounds`（配方解析 2 / None）+ shell 内嵌 Python `convergence_domain`（冷却/冻结评估）；裁决执行 = 引擎 self_tools ConvergenceHook retain | 绿（等价降级：评估/冷却执行语义 = 引擎收敛钩子 retain 覆盖） |
| 同一链语义（挂载/环境/产物与其余类型同链互操作 + 链尾折叠回退） | mcp.rs `patch_belongs_to_server_checks_meta` / `unmount_precheck_detects_tail_conflict`；同链落链/回退 = `patch.apply` / `patch.revert` op（engine host.rs `op_channel_domain_actions` 回退闭环） | 绿（等价降级：链互操作/折叠执行语义 = 引擎链机制 retain（test_chain_rebase）覆盖） |
| 审批分级矩阵（L0 直过 / L1 弹卡 / L2 vetting 前置） | recipe.rs `approval_levels_mount_tool_upgrades_tool_to_l2`（分级数据装配）+ security.rs 门禁分级判定；L0/L1/L2 执行姿势 = 引擎审批 retain（test_approval：分级矩阵） | 绿（等价降级：审批执行矩阵 = 引擎 retain 覆盖） |

## 十二、全链路

| 检查 | Rust 侧落点 | 状态 |
|---|---|---|
| 喂资料 → 研究 → 孵化 → 沉淀闭环（注入→挂载→回合→推演→孵化→补丁→回退→续流→压缩→调优→领域长出） | 各段分环节覆盖：engine host.rs `boot_stub_round_and_protocols`（注入→回合）+ `op_channel_domain_actions`（补丁→回退→分支→续跑→链索引→清理）+ incubation.rs 孵化/闸门 + boot.rs 装配 | 绿（等价降级：完整闭环为引擎回合级集成场景，由出厂自检「接线 e2e」覆盖（stub LLM 驱动）） |
| 全链路 stdio 真执行件形态（注入→挂载→真实调用→卸载撤销） | 引擎 MCP stdio 监督机制 retain（test_mcp_client：stdio 传输/监督）；挂载/卸载链分段覆盖（mcp.rs） | 绿（等价降级：stdio 真执行件闭环须执行件环境，由集成 e2e 覆盖；机制语义 = 引擎 retain） |
| 领域长出 live 验证（真实运行路径：新规则经样例闸门放行 → 自指 KNOWLEDGE 补丁挂载 → 活跃态生效 → 链尾回退撤销） | incubation.rs `samples_seed_baseline_positive_subset`（样例基线）+ `gate_l2_shape_semantics`（闸门）+ live.rs `apply_knowledge_payload_upsert_protects_identity`（挂载生效）+ `patch.revert` 回退闭环 | 绿（等价降级：真实运行路径全链 = 集成 e2e 覆盖；各段机制以域测试直落） |
| 出厂演示脚本全链 | 演示脚本随 Python 演示资产退场；分步演示 = 桌面壳交互路径（发行产品面） | 绿（等价降级：出厂演示为产品演示资产，机制覆盖以域测试 + 集成 e2e 承担） |

## 十三、执行深度

| 检查 | Rust 侧落点 | 状态 |
|---|---|---|
| 编辑重放（审批卡 edit 重走校验链：非法拒绝/合法落链） | mcp.rs `approval_card_and_edited_config_revalidates`（edit 重校验：非法拒绝/合法保留/非法形态拒绝） | 绿 |
| 编辑重放（回合日志截断 + 分叉重放，历史可追溯） | session.rs `branch_tree_maps_multi_leaf_chain`（分叉树）+ engine host.rs `op_channel_domain_actions`（thread_branch 分叉 + thread_chain_index 追溯 + thread_revert）；日志截断 = 引擎存储 op（thread_branch truncate_events） | 绿（等价降级：截断执行 = 引擎存储 retain 覆盖） |
| 预算三态（正常完成/超限终止/超限恢复重试） | 引擎执行机制 retain（test_executor：预算三态） | 绿（等价降级：执行期预算三态 = 引擎 retain 覆盖） |
| 异常三态（重试/跳过/终止） | 引擎执行机制 retain（test_executor：异常三态） | 绿（等价降级：执行期异常三态 = 引擎 retain 覆盖） |
| 生命周期（boot 幂等 / pause 拒新 / resume 恢复 / stop 排空 / 引擎重建缓存） | boot.rs `assemble_replays_idempotently`（装配幂等重放）+ engine host.rs `op_channel_domain_actions`（续跑恢复）+ stop 幂等（EngineHost::stop 重复调用安全） | 绿（等价降级：pause/stop 排空状态机 = 引擎生命周期 retain（test_runtime）覆盖） |
| 知识晋升导出（晋升后导出含新层级） | incubation.rs `promote_levels_are_sequential_and_id_stable`（晋升层级稳定）+ backup.rs `pack_validate_roundtrip_and_manifest`（导出 = 存储快照含晋升态） | 绿 |
| 脱敏与 trace_id（日志 redact + trace_id 贯穿回合 + 存储剥离敏感值） | 引擎机制 retain（test_llm_messages：redact；test_events/test_executor：trace_id 贯穿与剥离） | 绿（等价降级：脱敏/剥离 = 引擎 retain 覆盖） |
| 存储三后端（memory / sqlite 内存 / sqlite 文件落盘 + 重启链延续） | 引擎存储 retain（test_storage 三后端）；壳侧装配参数 storage_uri 透传（engine host.rs BootOptions） | 绿（等价降级：三后端 = 引擎 retain 覆盖） |
| UI 三层白名单深度（拒绝/回落/同源） | live.rs `validate_ui_spec_enforces_three_whitelists` / `restore_ui_theme_falls_back_to_baseline_and_validates` / recipe.rs 同源推导 | 绿 |
| 宿主件执行器注册契约（声明↔签名一致 + 权限/沙箱断言） | 壳 crate 集成测试（`tests/executor_contract.rs` 21 例：声明↔执行器签名契约 + 权限/沙箱断言；`tests/mcp_protocol.rs` 10 例；`tests/command_face_security.rs` 9 例） | 绿 |

## 十四、决策编号 21/22 专项验收（发行前核对）

| 检查 | Rust 侧落点 | 状态 |
|---|---|---|
| canary 合法图通过（种子图可试跑 → 关键路径走通） | engine host.rs `op_channel_canary_rounds_on_seed_graph`（种子图试跑回合，canary op 闭环） | 绿 |
| canary 非法图拒绝（结构非法/悬空边/缺入口 → 拒绝 + 留痕） | canary 拒绝语义 = 引擎 path_assembler retain（test_path_assembler：非法候选拒绝）+ 壳侧 canary op 闭环（engine host.rs） | 绿（等价降级：图结构校验 = 引擎 retain 覆盖） |
| canary 关键路径崩溃拒绝（崩溃事件/非终态原因/关键路径节点缺失 → 拒绝） | 关键路径校验 = 引擎 path_assembler retain（test_path_assembler：canary 关键路径）+ 壳侧 canary op 闭环 | 绿（等价降级：执行期崩溃判定 = 引擎 retain 覆盖） |
| 提示词生效断言（LLM 调用消息流含 boot_prompt 引导语 + 打标分类准则） | prompt.rs `boot_prompt_seed_loads_and_layers_split` / `injection_meets_tenfold_ratio_with_real_seed` / `strategy_variants_cover_both_kinds`（组成）+ engine host.rs `stub_llm_messages_contain_behavior_guidance`（端到端：行为准则层经协议代理前置为系统消息，模型桩消息流可观测断言） | 绿 |
| 行为准则层注入（soul/准则/事实 + 目标设定 10× 工具清单 + 交错引导语 + 工具名对照表） | prompt.rs `compose_round_behavior`（装配期组成）+ BehaviorLLM 协议代理（resolve_llm 出口包装，覆盖评审/蒸馏/路由全部调用点） | 绿（发行落地：此前为尸体态——boot_prompt 只装载未注入，本次接线闭环） |

## 十五、发行形态

| 检查 | Rust 侧落点 | 状态 |
|---|---|---|
| 全新机器路径（无仓库/无 Python 环境：资源解包 → 内嵌解释器 → 装配 → 回合 → 会话持久 → 导出校验 → 执行件就位） | engine runtime.rs `provision`/`prepare_bundled_python`（捆绑形态资源与解释器准备）+ `--selftest` 双阶段自检（release 实测 phase1/phase2 全过：bundled=true、LocalOnnx、事件流、会话持久、导出含库、exec_ready）+ **真安装形态**（NSIS 静默安装 → 安装目录二进制 selftest 双阶段全过，hooks.nsh DLL 装载位验证）——事件数为某次实测快照，重跑以 selftest 输出为准（event_types.json 现登记 47 个事件） | 绿 |
| 嵌入式 Python runtime 打包（embed 发行包 + 出厂第三方依赖 site-packages + 自定义 PyConfig 确定性路径） | 打包脚本 `inkling/scripts/package_windows.ps1`（含 `-Proxy` 参数透传，规避 tauri-cli 下载不走系统代理的坑）+ engine runtime.rs `init_embedded_interpreter`（显式 module_search_paths，环境不参与）+ 解释器 DLL 装载位（exe 同目录 + NSIS hooks.nsh POSTINSTALL） | 绿（NSIS 安装器本机产出并通过安装验收） |
| 向量检索出厂接通（无环境变量 = 本地内嵌语义检索；懒加载/降级保底可观测） | engine host.rs 注入 LocalOnnx（granite-97m）→ 检索源清单含 embedding（`boot_injects_local_embedder_into_retrieval_sources`）+ 真实推理断言（`local_onnx_bridge_embeds_with_real_model`：384 维 L2 归一）；无注入回落关键词基线（`boot_without_embedder_stays_keyword_baseline`） | 绿 |
| 首启引导（数据目录/模型配置/权限默认档三点 + 标记落位） | lib.rs `backend_status.first_run` + `first_run_dismiss`（标记文件）+ 前端 `FirstRunGuide` 浮层（vitest 3 例） | 绿 |
| 执行件随包就位检查（数据目录解包位定位 + 可执行校验 + 版本探测） | exec_proc.rs `locate_exec_binary` / `probe_version` + selftest `exec_ready` 断言 | 绿 |
