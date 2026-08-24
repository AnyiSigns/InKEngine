# seeds/ —— 种子生态仓库（目录即清单）

产品种子身份登记处。领域深度归宿主产品层（领域规则/样例/谓词由产品
自写并成对维护），引擎只带通用种子与 boot 自举基线；text_forge_evo
等产品形态保持独立应用目录，在此登记。

| 种子 | 身份 | 定位 | 版本 | 文档 | 出厂自检 | 演示 |
|---|---|---|---|---|---|---|
| inkling（`inkling/`） | InKling | 自进化认知伙伴：你用得越多，它越懂你的领域 | 0.1.0 |`manifest.json` + `inkling/docs/manual.md` + `inkling/docs/mechanism_coverage_matrix.md` | `manifest.json` 的 `self_check` 四门禁（命令单一事实源，经 `inkling/self_check/` Rust 自检编排统一执行，全部 ready） | 桌面壳交互路径（`inkling/shell/`；演示资产随机制覆盖迁入文档与集成验证） |

登记约定：身份数据（名称/定位/版本/契约清单/自检门禁）以各种子
`manifest.json` 为单一事实源；本目录只登记指针，不复制身份数据。

定位边界：`ink_engine/examples/domain_template/` 是引擎的教学资产
（内容中性示例领域演示完整链路），不占本仓库的种子生态位。
