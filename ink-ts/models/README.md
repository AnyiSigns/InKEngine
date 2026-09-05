# 本地模型与嵌入资产（ink-ts 随迁产品资产）

本目录随迁旧侧 `inkling/models/` 的出厂内嵌本地模型资产，供语义检索链路
（Rust infer 原生推理子进程，D10/§1.3）使用；开发形态默认相对进程工作目录
`ink-ts/models/...`，可用 `INK_EMBEDDING_MODEL_DIR` 显式覆盖落位路径。
任一模型缺失即对应能力降级，不阻塞交付（远端/确定性保底）。

## 语义嵌入（granite-97m）

- 目录：`ink-ts/models/granite-97m`
- 文件：
  - `model_quint8_avx2.onnx`：Q8 量化嵌入图（约 98MB），懒加载首次检索载入；
  - `tokenizer.json`：ModernBERT BPE 分词器；
  - `config.json` + `1_Pooling_config.json`：CLS 池化按 `config.json`
    `bos_token_id`（179934）取定，禁硬编码；
  - `LICENSE`：Apache-2.0 全文（模型 =
    `granite-embedding-97m-multilingual-r2`，IBM Granite Embedding Team，
    Apache-2.0，模型卡
    `https://huggingface.co/ibm-granite/granite-embedding-97m-multilingual-r2`），
    再分发须保留。
- 版本库策略：二进制（onnx/tokenizer.json）不入版本库（见本目录
  `.gitignore`），配置/许可/声明随版本库分发。
