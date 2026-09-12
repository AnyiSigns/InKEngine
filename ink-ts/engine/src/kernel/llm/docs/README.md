# llm（kernel/llm）

kernel 侧 LLM 机制契约层：统一 AsyncLLM 接口与数据形态、消息/工具/附件形态、
错误分类体系、ModelChain 容错链、CachingLLM 调用缓存、guard 用量/压缩包装
与机制端口契约——纯契约 + 纯机制包装，厂商传输在 `adapters/llm`。

## 文件
- `base.ts` — `AsyncLLM` 抽象基类（`ainvoke`/`astream`/`aclose`）、`LLMConfig`/`LLMParams`/`LLMChunk`/`LLMResult`、`collect_result` 流式累积、`REASONING_EFFORTS`。
- `messages.ts` — `Message` 四角色消息 + `system`/`user`/`assistant`/`tool_result` 工厂、`to_openai_dict`/`from_dict`、`accumulate_tool_calls` 增量累积、`project_history_baseline` 试跑基线投影、`message_role` 角色归一。
- `_shapes.ts` — `Attachment`/`ToolCallDelta`/`ToolCall`/`Json` 数据形态（跨域契约模块：adapters 载荷/解析消费的公共 seam）。
- `tools.ts` — `ToolSpec` 工具 schema 声明 + `to_openai_tools` OpenAI function 转换。
- `errors.ts` — `LLMError` 异常族、`redact` 出站遮蔽、`classify_llm_error` 分类、`is_transient_llm_error` 瞬时判定。
- `fallback.ts` — `ModelChain` 主备链（指数退避重试 + 备用切换 + 流式首块前重试）与 `RetryPolicy`。
- `cache.ts` — `CachingLLM` 调用缓存（sha256 指纹 + Storage records 持久化 + 版本失效 + TTL）。
- `guard.ts` — `UsageTrackingLLM` 用量闭环 / `CompressingLLM` 回合内压缩包装、`current_node_context`（`AsyncLocalStorage` 节点上下文）。
- `contract.ts` — `llm_contract` 机制契约（effects=storage_seam/llm_port，depends=builder）。
- `index.ts` — barrel 公开面（37 名，mirror Python `__all__` 本地纯契约模块）。
- `_guard_types.ts` — guard 侧 `AsyncLLM` 最小结构契约视图（跨域契约模块：runtime/executor/nodes 按此消费）。
- `_cache_serialize.ts` — 缓存负载序列化私有助手（`_result_to_dict`/`_result_from_dict`/`_stable_json`）。
- `_types.ts` — `ROLES`/`ROLE_ALIASES`/`ATTACHMENT_KINDS`/`ATTACHMENT_SEGMENT_TYPES` 共享常量。

## 依赖
- 上游（本目录实际 import）：`core/errors`（`EngineError`）、`core/context/context_compression`（压缩策略）、`core/storage`（`Storage` 类型）、`kernel/builder/_sha256`（纯 TS sha256）、`dock/ports`（端口常量）；`node:async_hooks`（仅 guard.ts，白名单唯一例外）。
- 下游（实际 import 本目录）：`core/`（nodes、context window+compression、storage/storage_records、tool_index、tool_orchestrator、harness、declarative_tools、execution_runtime）；`kernel/`（executor、runtime、tool_pipeline、self_tools、introspection、registry/contracts）；`adapters/llm`（全部适配器/注册表/解析负载）；公共面 `src/index.ts`「LLM 机制契约」组 `export *`；hosts/lib（`host.ts` 用 `AsyncLLM`/`ModelChain`、`bridge/rounds.ts` 用 `project_history_baseline`）；测试 `test/kernel/llm`（11 测试 + 2 助手）。
