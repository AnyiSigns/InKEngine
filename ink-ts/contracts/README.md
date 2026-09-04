# ink-ts/contracts — P0 契约冻结产物

> 依据 `.kilo/plans/1788454200000-engine-ts-migration-plan.md` §P0（2026-09-04 修订版）。
> 本目录是迁移新侧的唯一契约真源集合；`inkling/self_check/schemas/` 既有 23 份
> seed schema 保持原样为参照（旧侧不回填），以只读方式消费。

## 缺口审计结论（2026-09-04 实测）

既有 23 份 JSON schema 已覆盖 22 seed_data + manifest 的结构校验，P0 无需重造。
真正缺 schema 覆盖的契约面 = 3 处机制层注册表/枚举，本目录 `schemas/` 已给出草案：

| 契约面 | 现状事实源 | 缺口 | 草案 |
|---|---|---|---|
| 端点注册表 | 引擎 `core/declarative_tools.py:77-104`（7 内置 StrEnum）+ `EndpointTypeSpec/Registry`（:115-183、:372-463）；壳 `tool_decl.rs:24`（2 态）与 `security.rs:481`（5 态+Unknown）双枚举；`self_check/src/schema.rs:1726-1750` 硬编码桥 | 三处双套，无单一注册表 schema | `schemas/endpoint_registry.schema.json` |
| 补丁协议 | `core/self_proposal.py:42-54` PatchKind 10；`core/self_application.py:130-139` ApprovalLevel L0/L1/L2、:145-155 默认分级（9 项，ENTITY 无默认）、:120-127 审计状态 6、:91-114 守卫集合 7 精确 + 4 前缀；`core/patch_chain.py:32-35` PatchOp 3 | 跨 6 派生层镜像、无 schema | `schemas/patch_protocol.schema.json` |
| AssemblyRecipe | 数据面 = 壳 `domain/recipe.rs:499-523` `AssemblyRecipeData`（11 字段，由 seed_data 经 `build_recipe` 映射）；钩子面 = 引擎 `core/runtime.py:336-411`（22 字段中 Callable 注入部分） | 无数据面 schema；`schema.rs:50` 22 字段文本扫描在 TS 迁走后失效 | `schemas/assembly_recipe.schema.json` |

事件类型精确清单（`event_types.json` ↔ 前端 `eventTypes.ts` 逐名对码）：
**seed 权威 48 条 = 前端镜像 48 条，1:1 无差异无重复**（脚本比对结果）。此前 49/47/50
计数分歧为误计，本项闭环；前端镜像后续改为生成物（P1 codegen 落地）。

## 双层规则（本目录强制）

- **数据面**：可 JSON 表达的契约（枚举、注册表条目、12 字段配方数据）→ 落 `schemas/*.json`；
- **钩子面**：Callable/执行体接线（extractor/failure_reason/sandbox_builder、AssemblyRecipe
  的 hooks 字段）→ 不落 JSON，只进 contracts 的 TS 类型层（生成类型 + 手工钩子接口，
  命名带 `Hooks` 后缀）。
- 代码文件禁计划字眼、叙述口吻（§4.2.1 纪律）。

## 目录约定

```
ink-ts/contracts/
├─ README.md              # 本文件：审计结论 + 约定
├─ package.json           # @ink-ts/contracts（private；scripts: generate/check/typecheck）
├─ tsconfig.json          # 严格 noEmit（NodeNext），覆盖 src/**
├─ schemas/               # JSON schema（数据面唯一真源；含 3 份 P0 新增定稿）
├─ fixtures/              # 现行值快照（endpoint_registry / patch_protocol，
│                         #   由 check_contract_sources.py 断言与旧侧一致）
├─ scripts/
│  ├─ check_contract_sources.py   # 双向断言门禁（见下「断言清单」）
│  └─ generate.mjs                # TS 类型生成器（schema union 约束 fixture 常量）
└─ src/
   └─ generated/          # 生成 TS 类型（勿手改；生成后跑 typecheck 验证）
```

## 命令

- `npm --prefix ink-ts/contracts run generate` → 重新生成 `src/generated/`；
- `npm --prefix ink-ts/contracts run typecheck` → tsc 严格校验生成物
  （复用 `inkling/frontend/node_modules` 的 typescript，P1 建独立依赖前临时形态）；
- `python ink-ts/contracts/scripts/check_contract_sources.py` → 断言门禁（exit 0 = PASS）。

## 断言清单（check_contract_sources.py）

1. schema 自身合法 draft-07；fixture 通过对应 schema 校验；
2. `endpoint_registry.fixture.json` ↔ 引擎 `declarative_tools.py` 内置注册表
   （名称/actions/config_requirements/output_fields/sandbox_ops 全字段）；
3. `patch_protocol.fixture.json` ↔ `self_proposal.py`/`self_application.py`/
   `patch_chain.py` 枚举与常量（含声明顺序）；
4. 事件类型名 ↔ `seed_data/event_types.json` 与前端 `eventTypes.ts`（48 = 48）；
5. `tools.json` 全部工具端点 ⊆ 内置 7 且无缺漏；
6. `assembly_recipe.schema.json` 必填字段 ↔ 壳 `recipe.rs` `AssemblyRecipeData`
   11 字段逐名一致。

## 生成物说明

`schema union`（内联）在 `generate.mjs` 中约束 fixture 常量数组——schema 与
fixture 任一方向漂移会在 `typecheck` 编译期暴露，fixture 与 Python/Rust 真源
漂移由断言清单暴露。三层（schema ↔ fixture ↔ 源码）互为校验。

## P0 待办收口

- 三份 schema 草案已定稿并机检（assembly_recipe 暂无现行值实例，其字段面已
  钉到 Rust 结构体，属纯配方形态契约）；
- 双向断言脚本落地（含 seed/事件/tools/Rust 数据面对码）；`self_check` 旧闸门
  未触碰任何旧侧源码/seed，维持基线全绿；
- TS 类型生成器落地 + 生成物 typecheck 通过；旧前端手写事件/工具镜像在 P1
  由「直连 seed 真源 + 生成类型」取代（TS 编译器从 resolveJsonModule 推断类型，
  旧侧不补镜像测试、不回填，符合迁移纪律）。
