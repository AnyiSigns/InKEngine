# llm 端口提供方（kind=ports）

端口实装位：llm_port。声明真源 = 本目录 `spec.json`（kind=ports、faces.logic
target=host、data.port.implemented=llm_port）；实现随插件同住于 `faces/logic/`
（registry 注册面 + anthropic/openai_compat/openai_response 协议适配器 +
retry_once/sse_common/fetch_transport 传输配套），同住测试 `faces/logic/*.test.ts`
经 `vitest run --root plugins` 执行。

## 数据从哪进 / 能碰什么端口

- 装载：hosts/lib 装配层按 manifest「ports」段动态 import 默认导出工厂，
  产出 { create_llm, register_adapter, adapter_names, get_adapter_class } 注入
  引擎 seam（与旧 `@ink-ts/engine` 的 create_llm 同一语义 slot）。
- 依赖：llm_port 端口（引擎唯一端口词表真源 `dock/ports.ts`）。
- 边界：只实现协议级 HTTP 适配（不 import 厂商 SDK）、不实现模型推理；未知
  adapter 名显式抛 LLMConfigError（附已注册清单）。
- 失败语义：网络/超时/流错误结构化分类（to_llm_error），重试策略
  （RetryPolicy）随端口契约，消费方按目录语义兜底。

## 与引擎的关系

适配器下沉前 engine/src/adapters/llm（S2 整目录迁出）；引擎公共面停供
create_llm/register_adapter/adapter_names/get_adapter_class 等符号，仓库从
公共面经 llm_port 取型（AsyncLLM/LLMConfig/LLMParams/LLMChunk/LLMResult/
REASONING_EFFORTS 等契约）。