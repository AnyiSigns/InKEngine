# live 生态缺口清单（随测随记）

> 处置规则见测试说明文档第九节：
> - API/文档漂移（签名失实/示例不可运行）→ 低风险直接改 docs
> - 机制缺陷（承诺行为不成立/崩溃/错误结果）→ 修复 + 单测回补
> - 未定义行为（边界无文档）→ 定语义入文档（低风险直接定）
> - **机制缺失/可完善点（能力缺口或设计选择）→ 记入「缺失清单」，
>   随测试报告提交，向用户询问决策后实施**（不得擅自实施）

## 修复记录（已处置）

| # | 类别 | 描述 | 处置 |
|---|------|------|------|
| 1 | 机制缺陷 | mcp_client http 传输与 mcp SDK 2.x 不兼容：`streamablehttp_client` 改名 `streamable_http_client` 且 `headers` 参数改经 httpx 客户端注入——安装 mcp>=2.0 时 http 传输连接必失败（族 18 真实 http 用例暴露） | 直接修复（测试说明文档第九节缺陷类）：模块级双版本兼容导入 + 2.x 走 `http_client` 注入（退出栈回收）；单测回补 `tests/test_mcp_client.py::test_http_client_import_fallback_resolves`（回归不依赖 live）；族 18 stdio/http/in_memory 三传输真实用例全绿 |
| 2 | 测试设计错误 | test_15_workflow.py::test_workflow_spec_to_graph 缺 `graph = build_workflow_graph(...)` 赋值（NameError）——单测级笔误，live 全量运行暴露 | 直接修复（测试说明文档第九节测试设计错误类）：补赋值后全绿；回归不依赖 live |
| 3 | 测试基础设施缺陷 | live 报告记账起点问题：`live_infra` 非 autouse 时，先于任何 live fixture 请求运行的族（01-04）不入报告，覆盖矩阵误报孤儿模块 | 直接修复：`live_infra` 改 session autouse（报告记账自首个用例生效）；修复后 22 族全录 |
| 4 | 测试基础设施缺陷 | report.py 门禁① 覆盖核对路径不匹配：`passed_files` 取完整 nodeid（`tests/live/test_XX.py`），`MODULE_FILES` 用裸文件名——即使全绿也误报 59 孤儿模块 | 直接修复：`passed_files` 取 `Path(nodeid).name`；修复后覆盖矩阵按模块真实打勾 |

## 缺失清单（待用户决策）

_（暂无）_
