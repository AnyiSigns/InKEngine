# contracts/（结点契约与数据面契约生成物）

两类契约的承载目录：`contracts.ts` 为结点契约与机制装配开关的声明式数据
形态（纯类型/纯校验，零执行逻辑）；`generated/` 为数据面契约的 TS 生成物
（真源 `engine/schemas/` + `engine/fixtures/`，禁手改，contracts:verify
守漂移）。

## 文件
- `contracts.ts` — 结点契约 + 装配开关 + 质量闸门窄协议。
- `generated/index.ts` / `endpointTypes.ts` / `patchProtocol.ts` — 生成文件
  （engine/scripts/generate.mjs 依据 schemas+fixtures 生成，勿手改）。

## 关键导出
- `NodeContract`：结点契约——输入/输出 schema（复用 SchemaSpec 声明语言）+
  安全档 0/1/2（0 最严，与审批档 L0-L2 同阶）+ 版本（行为变更 = 升版）；
  to_dict/from_dict 随图定义数据落库，旧版本快照服务审计复现与回退；
  契约可缺省（无契约结点不受契约门约束，pool 结点类型登记与执行期契约校验共用）。
- `PathAssemblyConfig`：已随组装链路退役删除（类与 as_path_assembly_config()，W7-B）。
- `PathAssemblyFlags`：七块独立 feature flag（contract/edge_evidence/
  settle_hooks/pool_governance/assembler/multipath/fingerprint_cache），
  缺省全关；`from_boot` 按 BOOT_KEY_* 长键按名读取（键名是装配协议的一部分，
  对应壳侧 BootOptions 透传 JSON），`to_boot_dict` 反向序列化。
- `BOOT_KEY_*` 七个常量：装配透传键。
- `QualityGate`：产出质量判定窄协议（domain + artifact → bool 或
  Promise<bool>；实现归使用方；settle 只记录布尔结论，未注入闸门走
  fail-closed 降级链）。
- generated 组：`BUILTIN_ENDPOINT_NAMES`/`BUILTIN_ENDPOINTS`（七个内置端点
  spec：actions/config_requirements/output_fields/sandbox_ops）、`FieldKind`、
  `PATCH_KINDS`/`PATCH_OPS`、`APPROVAL_LEVELS`/`DEFAULT_APPROVAL_LEVELS`
  （ui/theme=L0，tool/rule/knowledge/harness/event_type/environment=L1，
  artifact=L2）、`AUDIT_STATUSES`（六状态）、`GUARDED_COLLECTIONS`/
  `GUARDED_PREFIXES`（GuardedStorage 守卫面）。

## 依赖
- 上游：`core/errors`（GraphDefinitionError）、`core/json`（isRecord/
  typeName）、`core/schema`（SchemaSpec）。
- 下游：kernel 侧广泛消费——`kernel/runtime`（结点注册契约校验）、
  `kernel/multipath`（QualityGate + PathAssemblyFlags.multipath_enabled）、
  `kernel/self_application`（审批分级/守卫集合）、`kernel/self_proposal`
  （PATCH_KINDS）、`kernel/executor`（QualityGate）；core 侧
  `node_registry`/`link_validator`/`graph`/`perception`/`nodes`；生成物经
  `src/index.ts` 数据面契约组全仓导出（上层不再有独立契约包）。`kernel/path_assembler`
  与 `core/assembly` 下游已随组装链路退役删除（W7-B）。

## 门禁与测试
- 生成物漂移由 `node engine/scripts/verify_generated.mjs` 守护；一致性测试
  `test/core/contractsConsistency.test.ts`；形态校验测试
  `test/core/contracts/contracts.test.ts`。
