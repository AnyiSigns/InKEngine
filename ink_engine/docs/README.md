# InkEngine 文档集

引擎的心智模型：**「机制是引擎，知识是数据，变化是补丁，汇入靠调配」**。

| 文档 | 内容 | 面向 |
|---|---|---|
| [concepts.md](concepts.md) | 概念体系：卡回路/时间线/发散收敛/推演/重规划/声明式化/知识孵化/调配/自指演化/安全纵深等 | 心智模型与宣传 |
| [architecture.md](architecture.md) | 架构总览：分层边界、机制/数据/宿主分工、数据流、门禁纪律 | 架构理解 |
| [extensions.md](extensions.md) | 扩展点目录：谁定义/谁实现/谁消费，逐点代码示例 | 复用者/宿主 |
| [hosts.md](hosts.md) | 宿主接入：Host 五件套、AssemblyRecipe 装配配方、Runtime 生命周期、传输与 MCP 挂载 | 宿主开发者 |
| [api.md](api.md) | 公开 API 速查：稳定公开契约（签名/默认值/语义），不穷举模块内部 | 宿主/复用者编码时查 |
| [security.md](security.md) | 安全模型：敏感键剥离/权限门禁/沙箱/审批/vetting/注入防线/fail-closed 矩阵 | 安全评估 |

代码在 `ink_engine/core`（engine-core，纯机制唯一 seam）；领域深度归
宿主产品层（领域规则/样例/谓词由产品自写并成对维护），机制层只带
通用种子与 boot 自举基线（`ink_engine.seeds`）；Forge（text_forge_evo）
与 stdio_host 为本包的两个宿主参考实现，读取 core API 与种子数据组装
自身流程，不复写机制；`examples/` 附可独立运行的示例。

## 快速导航

- 想理解引擎能干什么：读 `concepts.md`；
- 想嵌入引擎做宿主：读 `hosts.md`；
- 想扩展/替换某个环节：查 `extensions.md` 对应扩展点；
- 想评估安全性：读 `security.md`；
- 想看整体结构：读 `architecture.md`。
