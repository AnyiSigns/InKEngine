# InKling 第三方组件声明（Third-Party Notices）

本产品 InKling（受控自进化智能体）及其引擎 InKEngine（受控自进化运行时）
以 MIT 许可发布（见仓库根 `LICENSE`，© 2026 Anyi）。

本产品发行物（安装包）随包捆绑以下第三方组件，各自适用其声明许可证。
许可证全文随安装包分发于 `licenses/` 目录与各资源子目录，声明如下。

## 捆绑组件清单

| 组件 | 用途 | 许可证 | 全文位置 |
|---|---|---|---|
| CPython 3.14（内嵌解释器运行时） | 引擎 Python 运行时（`resources/python/`） | PSF License v2 | `resources/python/LICENSE.txt`（随 Python 发行自带） |
| ONNX Runtime | 本地模型推理运行时（`ort` crate 构建期下载的动态库；当前 Windows 安装包未捆绑该 DLL——嵌入能力缺失时降级关键词基线，如未来随包分发本声明即覆盖其 MIT 义务） | MIT | `licenses/ONNX-Runtime-LICENSE.txt` |
| granite-embedding-97m-multilingual-r2（ONNX 权重） | 本地语义嵌入模型（`resources/granite-97m/`，随包分发） | Apache-2.0 | `licenses/Apache-2.0.txt`、`resources/granite-97m/LICENSE` |
| ort（Rust crate，ONNX Runtime 绑定，静态链接入壳二进制） | 引擎侧本地嵌入桥 | MIT OR Apache-2.0 | `licenses/ONNX-Runtime-LICENSE.txt`、`licenses/Apache-2.0.txt` |
| Tauri 2 | 桌面壳框架 | MIT OR Apache-2.0 | 见各依赖仓库 |
| PyO3 / pyo3-async-runtimes | Python↔Rust 桥 | MIT OR Apache-2.0 | 见各依赖仓库 |
| React / react-dom | 前端 UI 库 | MIT | 见各依赖仓库 |
| lucide-react | 图标集 | ISC | 见各依赖仓库 |
| Vite / Vitest / Tailwind CSS / 其余 npm 依赖 | 前端构建与测试 | 各按自身许可 | 见 `inkling/frontend/package.json` 与 node_modules 内 `LICENSE` |
| Python site-packages（httpx/pydantic/mcp/uvloop 等） | 引擎与桥的 Python 依赖 | 各按自身许可 | 见 `resources/python/Lib/site-packages/*.dist-info/licenses` |

## 许可文本说明

- **Apache-2.0**：granite 嵌入模型权重与 `ort` crate（可选条款）适用。
  Apache-2.0 要求再分发时附带许可证副本与必要的归属声明（NOTICE）。
  模型与 crate 均无独立 NOTICE 文件；全文见 `licenses/Apache-2.0.txt`。
- **MIT**：ONNX Runtime（© Microsoft Corporation）适用。MIT 要求再分发时
  保留版权与许可声明；全文见 `licenses/ONNX-Runtime-LICENSE.txt`。
- **PSF**：内嵌 CPython 适用。PSF License v2 全文随 Python 发行附带于
  `resources/python/LICENSE.txt`，请勿删除。

## 模型归属

granite-embedding-97m-multilingual-r2 由 IBM Granite Embedding Team 开发，
Apache-2.0 许可（模型卡：
`https://huggingface.co/ibm-granite/granite-embedding-97m-multilingual-r2`）。
本产品仅作本地嵌入推理使用，未对模型权重做修改。
