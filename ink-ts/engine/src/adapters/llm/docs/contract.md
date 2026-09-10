# adapters/llm — LLM 协议适配器（契约文档）

> 就近导航：本目录 `README.md` · 层权威：
> `docs/subsystems/engine.md` + `engine/AGENTS.md` · 移植源：
> Python `kernel/llm/openai_compat.py / anthropic.py / openai_response.py`

## 定位

把 `kernel/llm` 的 `AsyncLLM` 统一契约（ainvoke/astream）落到具体厂商 HTTP
协议：自写 fetch 传输 + SSE 解析，零厂商 SDK、零第三方 HTTP 客户端。三
协议共享传输 seam 与解析公共原语；协议选择配置驱动（`LLMConfig.adapter`
→ 注册表）。

## 文件与职责

| 文件 | 职责 |
| ---- | ---- |
| `registry.ts` | 适配器注册表：协议全名/兼容别名/厂商别名；setdefault 内置注册；`create_llm` fail-fast |
| `fetch_transport.ts` | 三协议共享传输 seam（LlmTransport.post）：全局 fetch 缺省、逐读空闲超时、异常归一 TimeoutError/NetworkError、流退出 cancel 上游 |
| `retry_once.ts` | 共享重试骨架：with_retry / with_stream_retry（emitted 后不重试）、Sleeper 注入、to_llm_error 兜底分类 |
| `sse_common.ts` | SSE/error 公共原语：data 帧解码、错误体 detail、code/type→状态码提示、raise_for_status、默认超时 120s |
| `openai_compat.ts` / `compat_payload.ts` / `compat_parse.ts` | chat/completions：payload 装配（extra_body 白名单透传 + reasoning_style 映射）、SSE 帧解析（reasoning_content 透传、工具增量、usage 合并、[DONE]/坏帧容错）、非流式解析 |
| `openai_response.ts` / `_responses_payload.ts` / `_responses_parse.ts` | Responses：input items 转换（function_call/output 回环）、扁平 tools、SSE 事件分派（delta/done/completed/usage）、function_call index 自增分桶 |
| `anthropic.ts` / `anthropic_payload.ts` / `anthropic_sse.ts` | Messages：system 抽顶层、tool↔tool_result/tool_use 块、thinking budget 映射（temperature unset、max_tokens 抬升）、cache_control、stop_reason 映射、SSE 跨帧状态（message_start 输入用量暂存） |

## 对外契约面

- `create_llm(config | dict)` → AsyncLLM 实例；`register_adapter(name, cls)`
  可覆盖同名内置（空名抛 LLMConfigError）；`adapter_names()` 有序清单；
  `get_adapter_class(name)` 未注册返回 null。
- 注册名：协议全名 `openai_compatible` / `openai_responses` /
  `anthropic_messages`；兼容别名 `openai_compat` / `openai_response` /
  `anthropic`（旧配置零迁移）；厂商别名 openai / deepseek / zhipu /
  moonshot / ollama（均 OpenAICompatibleLLM 改 base_url）。
- 公共面经 `src/index.ts` llm 组导出注册函数族；适配器类本身随
  registry（LLMAdapterCtor 类型）导出。
- 各适配器构造可选 `{transport?, retry?, sleep?}` 注入面：transport =
  LlmTransport seam；retry = kernel RetryPolicy（默认 null = 单次尝试）。

## 数据形态

- 请求：`build_payload` / `to_input_items` / `build_anthropic_payload`
  统一装配核心字段；`params.extra_body` 仅透传非核心键（核心键白名单
  `_CORE_PAYLOAD_KEYS` / `RESPONSES_CORE_PAYLOAD_KEYS` / `_RESERVED_PAYLOAD_KEYS`
  防覆盖——替换对话/强制关流回归约束）。
- 推理档位：REASONING_EFFORTS 枚举按协议映射——compat 走
  `LLMConfig.extra.reasoning_style`（effort/boolean 两式）；Responses 走
  `reasoning.effort`；Anthropic 走 budget_tokens（low 2048 / medium 8192 /
  high 16384）。
- 响应：统一收敛为 LLMChunk（流式增量）/LLMResult（终态），reasoning 经
  `reasoning_token` 透传；usage 归一 prompt/completion tokens。

## Seam 与 IO 边界

- `LlmTransport`（fetch_transport.ts）：post(url, {headers, json,
  timeout_ms}) → LlmResponse（status + json()/body_text()/aiter_lines()）。
  生产缺省全局 fetch（Node ≥18）；body 只允许消费一次（httpx 语义）；
  逐读空闲计时防挂死；消费方中断在退出路径 cancel 上游（不悬挂连接）。
- fetch 拒绝归一：AbortError+idle.timed_out → TimeoutError、其余 →
  NetworkError（与 `kernel/llm/errors.ts` classify_llm_error 命名对齐）。

## 错误与重试语义

- 传输异常/HTTP ≥400 统一经 classify_llm_error 分类抛 LLMError 族；
- 200 但零数据帧 → LLMEmptyStreamError（可重试瞬时故障）；
- 重试唯一权威在链级（kernel/llm ModelChain RetryPolicy）；适配器默认
  单次（retry=null），独立直用注入策略才开指数退避——杜绝「适配器 × 链」
  叠加；流式已产出帧后失败不重试（防重复帧）。

## 装配与消费

宿主按模型配置（role/model/base_url/adapter）经 `create_llm` 建实例接入
kernel 模型链；e2e/单测注入假 transport 零网络验证。上游 import 仅
`kernel/llm`（base/messages/tools/errors/fallback）。

## 不变式与门禁

- 仅 `kernel/llm` 上游依赖；行数超限文件（无）外均 ≤350；openai_response/
  anthropic 拆分文件以「模块专属命名」防冲突。
- 坏 SSE 帧容错跳过不中断整流；error 帧按 code/type 状态码提示分类抛错。

## 测试

`test/adapters/llm/`：registry（注册/别名/覆盖）、openai_compat（非流式/
流式/重试/空闲超时）、openai_response（SSE 事件/非流式）、anthropic
（payload/流式/重试/空闲超时）、retry_once（两基线退避等价）；共享桩
compat_helpers.ts / anthropic_helpers.ts（假 transport + 录制 sleeper）。
