# 本地模型与离线支持说明

本目录随包承载可离线运行的本地模型资产。开发形态默认相对进程工作目录
（`inkling/models/...`），捆绑形态由安装包 `resources/whisper` 首启解包至
`data_dir/assets/whisper`；可用 `INK_VOICE_MODEL_DIR` / `INK_EMBEDDING_MODEL_DIR`
显式覆盖落位路径。任一模型缺失即对应能力降级，不阻塞交付。

## 语音识别（whisper 嵌入式）

- 目录：`inkling/models/whisper`（开发） / `data_dir/assets/whisper`（捆绑）
- 文件：
  - `model_q8.onnx`：int8 量化语音识别图（约 75MB），输入为单声道
    16kHz 浮点波形（张量名 `audio`，形状 `[1, N]`），输出词表对数
    `[1, seq, vocab]`，贪心解码并跳过特殊标记区间。
  - `tokenizer.json`：whisper BPE 分词器（与 `tokenizers` 0.20 同构）。
  - `config.json`：机器可读声明（`sample_rate` 默认 16000、
    `eot_token_id` 默认 50257）。
- 降级：目录或文件缺失 → 能力探测 `stt=false`，识别调用返回明确错误，
  不静默猜测。
- 采集：Windows 经 waveIn（winmm FFI，零外部依赖）录制为 WAV；非 Windows
  显式报不支持。

## 语音合成（TTS）

- Windows SAPI（`System.Speech`），经 PowerShell 桥调用，零新依赖。
- 文本落临时文件后朗读，避免命令注入。
- 非 Windows 显式报不支持。

## 语义嵌入（granite-97m 随包）

- 目录：`inkling/models/granite-97m` / `data_dir/assets/granite-97m`
- 与语音识别同构的本地 ONNX 推理链路（granite-97m 已随包，详情见嵌入域）。
- 离线支持级复用该模型作为本地嵌入来源。
- 许可：模型 = `granite-embedding-97m-multilingual-r2`（IBM Granite Embedding
  Team，Apache-2.0，模型卡
  `https://huggingface.co/ibm-granite/granite-embedding-97m-multilingual-r2`）；
  打包脚本随模型放置 `LICENSE`（Apache-2.0 全文，取自
  `inkling/licenses/Apache-2.0.txt`），再分发须保留。

## 离线支持级

- 本地端点探测：Ollama 默认地址 `http://localhost:11434` 与
  `http://127.0.0.1:11434`（`/api/tags` 探活，返回模型清单）。
- 本地记忆 / 技能：数据目录 `inkling.sqlite` 存在即视为可用。
- 离线档：`data_dir/offline_settings.json`，字段 `enabled` / `mode`
  （auto|local|cloud）/ `ollama_url` / `use_local_embedding` /
  `use_local_memory`；缺字段补默认值，防双源漂移。
- 同一数据形态双通道：检测到本地模型可选离线配置，无本地模型云端照常。
