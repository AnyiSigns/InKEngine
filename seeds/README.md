# seeds/ —— 种子生态仓库（目录即清单）

产品种子身份登记处。领域深度归宿主产品层（领域规则/样例/谓词由产品
自写并成对维护），引擎只带通用种子与 boot 自举基线；text_forge_evo
等产品形态保持独立应用目录，在此登记。

| 种子 | 身份 | 定位 | 版本 | 文档 | 出厂自检 | 演示 |
|---|---|---|---|---|---|---|
| inkling（`seeds/inkling/`） | InKling | 自进化认知伙伴：你用得越多，它越懂你的领域 | 0.1.0 |`manifest.json` | `seeds/inkling/self_check.py`（四项门禁一键聚合） | `seeds/inkling/examples/factory_demo.py`（stub 全链离线；`INK_LLM_*` 切换真实模型） |

登记约定：身份数据（名称/定位/版本/契约清单/自检门禁）以各种子
`manifest.json` 为单一事实源；本目录只登记指针，不复制身份数据。
