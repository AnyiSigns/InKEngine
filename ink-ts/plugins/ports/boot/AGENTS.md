# boot 端口提供方（kind=ports，纯数据资产形态）

端口实装位：无（**纯数据资产**，评审 2026-09-14 裁决：省略 `data.port.implemented`
+ 必带 `data.boot`）。声明真源 = 本目录 `spec.json`（kind=ports、faces.logic
target=host、data.boot）；实现随插件同住于 `faces/logic/`（boot.ts 承载
BOOT_* 系统提示词/ui spec/事件类型/harness 定义数据资产 + index.ts 公开面），
同住测试 `faces/logic/*.test.ts` 经 `vitest run --root plugins` 执行。

## 数据从哪进 / 能碰什么端口

- 装载：hosts/lib 装配层按 manifest「ports」段动态 import 默认导出工厂，
  产出 { BOOT_EVENT_TYPES, BOOT_SYSTEM_PROMPT, BOOT_UI_SPEC,
  boot_harness_definition, ... } 注入引擎配方；e2e 等引擎侧测试用**测试本地
  最小配方常量**（不 import 本插件，文件头 `test-exempt` 注记「真源 =
  plugins/ports/boot」，评审接受 drift 风险）。
- 依赖：数据面契约型（EventTypeSpec/HarnessDefinition/KnowledgeEntry 等经
  `@ink-ts/engine` 取型）；不实现任何端口 IO。
- 边界：只持引导数据形态，不引机制依赖；内容有意收敛于 Python 字面之外
  （工具清单并入 BMeta 单源，boot 不再作为 boot_prompt 知识条目注入）。

## 与引擎的关系

适配器下沉前 engine/src/adapters/boot（S2 整目录迁出）；引擎公共面停供
BOOT_*、boot_harness_definition、build_boot_seed_entries 等符号，仓库经
data.boot 声明 + 装配注入取用。