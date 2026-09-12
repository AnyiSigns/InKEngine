# kernel/llm — LLM 机制契约层（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` + `engine/AGENTS.md`

## 定位

统一 LLM 接入面的机制契约层（Python kernel/llm 移植）：`AsyncLLM` 协议 +
数据形态 + 错误分类 + 纯机制包装（模型链/缓存/用量/压缩）。厂商差异收敛到
`adapters/llm` 适配器内部（SSE 解析/工具增量/reasoning 透传），上层只消费
统一增量模型。边界：本层 0-IO 不自持传输、只调声明端口；公共面两组分列——
「LLM 机制契约（core 纯 seam，`export *` 本 barrel）」与「LLM 协议注册
（`adapters/llm/registry.js`：`adapter_names`/`create_llm`/`get_adapter_class`/`register_adapter`/`LLMAdapterCtor`）」。

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `base.ts` | `AsyncLLM` 抽象基类（`ainvoke`/`astream`/`aclose`）；`LLMConfig`（冻结、base_url 须 http/https、`toJSON` 去凭据）/`LLMParams`/`LLMChunk`/`LLMResult`；`collect_result` 流式累积；`REASONING_EFFORTS`（off/low/medium/high） |
| `messages.ts` | `Message`（四角色 + 附件 + tool_calls + reasoning + id/uuid 注入面）与角色工厂；`to_openai_dict`/`to_dict`/`from_dict`；`accumulate_tool_calls` 按 index 合并增量；`project_history_baseline`（fork/试跑只读基线：保留链首 system 与 user/assistant 文本链，丢 tool/附件/纯工具片段）；`message_role` 角色归一；`StoredMessage` 持久化形态 |
| `_shapes.ts` | `Json`；`Attachment`（kind 枚举 image/video/document、url/path 必携其一、`to_openai_segment`）；`ToolCallDelta`/`ToolCall`（`parse_arguments` 容错/strict 双模式）——跨域公共 seam |
| `tools.ts` | `ToolSpec`（name/description/parameters=JSON Schema dict/permissions=`domain:action:pattern`）；`to_openai_tools`；pydantic 转换不在 TS 端（宿主先转 dict） |
| `errors.ts` | `LLMError` + 11 子类；`redact`（9 组凭据正则、失败安全）；detail 进异常前规范化（控制字符剥离→遮蔽→截断 200）；`classify_llm_error`（状态码/异常名/文本关键词）；`is_transient_llm_error` |
| `fallback.ts` | `ModelChain`：configs 惰性建实例、瞬时故障指数退避重试（`RetryPolicy` 缺省 3 次/1.0s/封顶 10.0s）、耗尽后切备用重置预算、认证失败 fail-closed 不切备用、非 `LLMError` 穿透；流式仅首块前重试/切换，产出后失败直接上抛；`create`/`sleep` 结构注入 |
| `cache.ts` | `CachingLLM`（extends `AsyncLLM`）：sha256 指纹（messages 取 `to_openai_dict` 不含 id + tools + model + tag + params）、Storage records 持久化、`patch_version` 版本比对失效（外部提供者优先/本地 `_epoch` 代际兜底）、`DEFAULT_CACHE_TTL`=86400s + `clock` 注入、`astream` 直通不缓存、`stats()`/`clear()`/`invalidate()`、读写失败静默 fail-open |
| `guard.ts` | `UsageTrackingLLM`（usage 帧 → `ctx.account_usage` + `llm_usage` 事件，缺上下文/失败静默跳过）；`CompressingLLM`（调用前 `compress_message_history` 压缩视图，默认 `ThresholdCompressionPolicy` 30 条/160000 字符、`keep_recent` 缺省 10）；`current_node_context`（`AsyncLocalStorage` set/reset token，executor 节点边界注入） |
| `contract.ts` | `llm_contract: MechanismContract`：id `'llm'`、effects `[PORT_STORAGE_SEAM='storage_seam', PORT_LLM_PORT='llm_port']`、depends `['builder']`（sha256 纯 TS 依赖） |
| `index.ts` | barrel：base 6 + errors 14 + messages 10 + tools 2 + fallback 2 + cache 3 = 37 名 |
| `_guard_types.ts` | guard/消费侧 `AsyncLLM` 最小结构契约视图（`Usage`/`InvokeOptions`/接口版 `LLMConfig`/`LLMChunk`/`LLMResult`）——跨域契约模块 |
| `_cache_serialize.ts` | `_result_to_dict`/`_result_from_dict` 往返 + `_stable_json`（键排序 + `default=str` 兜底；指纹稳定输入，不承诺跨语言字节等价） |
| `_types.ts` | `ROLES`/`Role`/`ROLE_ALIASES`（human→user、ai→assistant）/`ATTACHMENT_KINDS`/`ATTACHMENT_SEGMENT_TYPES`（→image_url/video_url/document_url） |

## 对外契约面

barrel `index.ts` 37 名（逐组核对）：base——`AsyncLLM` `LLMChunk` `LLMConfig` `LLMParams` `LLMResult` `collect_result`；errors——`LLMAuthError` `LLMBadRequestError` `LLMConfigError` `LLMEmptyStreamError` `LLMError` `LLMFormatError` `LLMNetworkError` `LLMNotFoundError` `LLMRateLimitError` `LLMServerError` `LLMTimeoutError` `LLMUnknownError` `classify_llm_error` `is_transient_llm_error`；messages——`Attachment` `Message` `ToolCall` `ToolCallDelta` `accumulate_tool_calls` `assistant` `project_history_baseline` `system` `tool_result` `user`；tools——`ToolSpec` `to_openai_tools`；fallback——`ModelChain` `RetryPolicy`；cache——`CACHE_COLLECTION` `DEFAULT_CACHE_TTL` `CachingLLM`。

公共面：`src/index.ts`「LLM 机制契约（core 纯 seam）」组 `export * from './kernel/llm/index.js'`——37 名全部上公共面。barrel 未含（kernel 内部消费）：guard 三件 `UsageTrackingLLM`/`CompressingLLM`/`current_node_context`、`llm_contract`、`redact`、`message_role`、`REASONING_EFFORTS`、`StoredMessage` 与全部 `_` 前缀私件。机制端口契约经 `kernel/registry/contracts.ts` 收入全量契约清单（verify:mechanisms 三键）。

## 数据形态

- 调用面：`ainvoke(messages, {tools, params}) → LLMResult`；`astream(...) → AsyncIterable<LLMChunk>`（增量语义：加字段不破坏）；usage 帧引擎不解释细节、透传记账。
- 消息面：四角色 system/user/assistant/tool（tool 必带 `tool_call_id` 否则 `LLMConfigError`）；`Message.id` 缺省 32 个 `'0'`（确定性可复现，`uuid` 可注入）；附件仅 user 消息展开为 OpenAI 多模态内容段。
- 错误面：瞬时 = Timeout/RateLimit/Network/Server/EmptyStream；确定性 = Auth/BadRequest/NotFound（Auth 不切备用）；Config/Format/Unknown。状态码映射：408→Timeout、429/402→RateLimit、401/403→Auth、404→NotFound、400/422→BadRequest、5xx→Server。
- 缓存面：记录五字段 `fingerprint/response/tag/created_at/patch_version`（collection=`'llm_cache'`）；命中 = 版本一致且未超 TTL；无版本提供者时本地 `_epoch` 代际兜底；组合包装（ModelChain）模型标签取 `configs[0].model_id`。

## Seam 与 IO 边界

机制端口面（`contract.ts` effects 白名单）：`llm_port`——包装器/模型链对注入的 AsyncLLM 直接发调用（真实适配器宿主按配置注入，`create` 工厂惰性建模型）；`storage_seam`——`CachingLLM` 走 Storage records 通道（`get_record`/`put_record`/`list_records`/`delete_collection`）。依赖端口：`builder` 的纯 TS `sha256_hex`（core 禁 node:crypto）。`node:async_hooks`（guard.ts `AsyncLocalStorage`，等价 contextvars per-async 链隔离）= core/kernel 禁 `node:*` 白名单唯一例外。注入面：`create`/`sleep`（fallback）、`storage`/`clock`/`patch_version`（cache）、`inner` + 节点上下文鸭子协议 `account_usage`/`emit`（guard）。零日志零控制台（上报/切换留痕以静默忽略替代，可观测性在宿主侧）；适配器实时传输/SSE 解析在 `adapters/llm`，不在本机制。

## 装配与消费

- guard 包装在 runtime 装配：`kernel/runtime/_runtime_engine` 以 `CompressingLLM`/`UsageTrackingLLM` 包装注入模型；`kernel/executor`（`_engine_parallel`/`_engine_execute_helpers`）在节点边界 set/reset `current_node_context`；`_node_context`/`_engine_base`/`run_subgraph` 经 `_guard_types` 视图持 `AsyncLLM`。
- core 侧：`core/nodes`（llm_decider/router/agent/seams/tool_pipeline）经 `_guard_types` 视图消费 `AsyncLLM`、直用 `messages`/`tools`/`base.LLMParams`；`core/context`（window/compression）复用 `message_role`；`core/storage/storage_records` 复用 `Message`/`ToolCall`；tool_index/tool_orchestrator/harness/declarative_tools/self_tools/introspection 消费 `ToolSpec`。
- hosts/lib：`host.ts` 单配置 `create_llm` 直建、多配置 `new ModelChain(...)`（fallback 链由 llm 层承载）；`bridge/rounds.ts` 用 `project_history_baseline` 重建分支/试跑基线。
- `adapters/llm` 全部适配器（openai_compat/openai_response/anthropic）实现 base `AsyncLLM` 并注册于 adapters registry；重试唯一权威：适配器默认单次（内部重试关闭），`RetryPolicy` 是瞬时故障重试单一配置点，不叠加放大。
- `llm_contract` 无本目录镜像测试，经 `kernel/registry/contracts.ts` 汇总、由 `test/kernel/registry/contracts_registry.test.ts` 侧覆盖。

## 不变式与门禁

- 0-IO 机制件：只调 contract effects 声明端口；适配器注册/传输不进本层；verify:mechanisms 三键（依赖单向 DAG/runtime depends 闭包/机制层零自持 IO）随 kernel/registry 契约清单强制。
- 容错不变式：认证失败 fail-closed 不切备用（防凭据失效被静默掩盖/数据外转其它端点）；非 `LLMError` 中断（宿主取消）原样穿透不重试；流式产出后不切换不重试（防重复内容）；`astream` 不缓存。
- 缓存 fail-open：读写失败一律按 miss/忽略，绝不阻断调用；params 纳入指纹（宁可多 miss）。
- 凭据面：`LLMConfig.api_key` 不入 `toJSON`、extra 凭据键过滤；上游 detail 进异常前遮蔽+截断（对象级不变量，调用方免二次过滤）；`redact` 失败安全。
- 构造期校验：base_url scheme、角色枚举、`tool_call_id`、附件 url/path、parameters 须 JSON Schema dict（非法抛 `LLMConfigError`/`LLMFormatError`）。

## 测试

镜像测试 `test/kernel/llm/`（11 测试 + 2 助手 `helpers`/`fallback_helpers`）：`base`（LLMConfig/Params/Chunk/collect_result）、`attachments`（Attachment 校验序列化 + Message 多模态）、`messages`（message_role/Message 序列化/ToolCall 解析/project_history_baseline/accumulate_tool_calls）、`tools`（to_openai_tools/ToolSpec 往返）、`errors`（对象级规范化不变量）、`fallback`（重试/流式/配置三组）、`cache`（命中指纹分桶/链形包装/往返/落库字段/fail-open/流式直通）、`cache_lifecycle`（TTL/版本失效/stats/clear）、`guard`（UsageTrackingLLM/CompressingLLM）、`index`（barrel 逐组导出存在性 +「core barrel 不应导出适配器名」边界断言 + 常量值）。

## 疑点与不一致

1. 同目录双 `AsyncLLM` 定义并存：`base.ts` 抽象类（`LLMChunk` readonly 字段类）与 `_guard_types.ts` 结构接口（字段可选）——后者头注释称「落地后本文件导出随之收敛为 base.ts 的 re-export」，而 base.ts/`collect_result` 已落地（adapters 侧全部经 base.js 消费），收敛条件已成立但未收敛；core/nodes 与 kernel/executor/runtime 仍按 `_guard_types` 视图消费。
2. `guard.ts` 头注释「AsyncLLM 实时厂商传输（适配器注册/SSE 流解析/collect_result）属 llm base 批次，尚未随本模块移植」与现状不符——base.ts（`collect_result`/`AsyncLLM` 契约）与 `adapters/llm`（适配器注册/SSE 解析）均已落地，陈旧注释。
3. `errors.ts` 尾部 re-export（`ROLES`/`ATTACHMENT_KINDS`/`ATTACHMENT_SEGMENT_TYPES`/`ROLE_ALIASES`，注释称「仅供 messages.ts 复用」）：messages.ts 实际从 `./_types.js` 直取，全仓无经 errors.js 取这些名的 import（grep 核验）——死转出 + 注释失准。
4. barrel 未含 `message_role`（core/context 两文件跨目录消费）、`redact`（仅 errors 内部）、`REASONING_EFFORTS`（adapters 三文件消费）、guard 三件与 `llm_contract`；是否收编口径未见显式说明（`index.test.ts` 守护现清单并断言适配器名不入 barrel）。
