# llm/（LLM 协议适配器）

厂商协议适配：把 core/kernel 的 `AsyncLLM` 统一契约落到具体 HTTP 协议。
自写 fetch 传输 + SSE 解析，零厂商 SDK、零第三方 HTTP 客户端。三协议共享
传输 seam 与解析公共原语；重试唯一权威在链级（kernel/llm ModelChain），
适配器默认单次尝试（杜绝「适配器 × 链」叠加）。

## 文件
- `registry.ts` — 适配器注册机制：协议全名 `openai_compatible` /
  `openai_responses` / `anthropic_messages`（旧简称 openai_compat /
  openai_response / anthropic 为兼容别名）+ OpenAI 兼容厂商别名
  （openai/deepseek/zhipu/moonshot/ollama → 同一类改 base_url）；内置注册
  setdefault 语义（宿主先注册的同名适配器不被覆盖）；`create_llm` 按
  LLMConfig.adapter 选择，未知 adapter 抛 LLMConfigError。
- `fetch_transport.ts` — 三协议共享传输 seam（`LlmTransport.post`）：生产
  默认全局 fetch，可注入 fetch 实现零网络测试；逐读空闲超时
  （AbortController 每读重新武装）；fetch 拒绝归一为 TimeoutError /
  NetworkError（与 kernel/llm errors 分类对齐）；流式退出路径显式 cancel
  上游（取消不悬挂）。
- `retry_once.ts` — 瞬时故障重试骨架（三适配器共享）：`with_retry` /
  `with_stream_retry`（已产出内容后的失败不重试，防重复帧）；RetryPolicy
  数据形态权威在 kernel/llm/fallback，退避睡眠经 Sleeper 注入。
- `sse_common.ts` — SSE/error 解析公共原语：data 帧解码、错误体 detail、
  上游 code/type → 状态码提示词汇、`raise_for_status`、共享默认超时
  （DEFAULT_REQUEST_TIMEOUT_SECONDS = 120s）。
- `openai_compat.ts` + `compat_payload.ts` + `compat_parse.ts` —
  chat/completions 协议：覆盖 OpenAI/DeepSeek/Zhipu/Moonshot/Ollama/
  DashScope compatible-mode；reasoning_content 增量透传为 reasoning_token；
  extra_body 白名单透传（核心请求字段防覆盖）；推理链开关/档位按
  LLMConfig.extra.reasoning_style 映射。
- `openai_response.ts` + `_responses_payload.ts` + `_responses_parse.ts` —
  Responses 协议（/responses 端点）：input 数组承载消息与工具回环项、
  扁平 tools 段、SSE 事件按 type 分发（output_text.delta /
  output_item.done / completed / usage）；function_call 按完成事件次序
  自增 index 分桶。
- `anthropic.ts` + `anthropic_payload.ts` + `anthropic_sse.ts` —
  Messages 协议：system 抽顶层字段、tool 角色转 tool_result、tool_use 块
  表达工具调用；extended thinking 档位 → budget_tokens（开启时不设
  temperature、max_tokens 不足自动抬升）；cache_control ephemeral 缓存断点；
  stop_reason → 统一 finish_reason 映射。

## 依赖
- 上游：`kernel/llm`（base/messages/tools/errors/fallback 契约）。
- 下游：`src/index.ts`（registry 组导出 create_llm/register_adapter/
  adapter_names/get_adapter_class）；`test/adapters/llm/`（协议/流式/重试
  /超时全链路测试，含 compat_helpers、anthropic_helpers 共享桩）、
  `test/e2e/runtime_e2e.test.ts`。
