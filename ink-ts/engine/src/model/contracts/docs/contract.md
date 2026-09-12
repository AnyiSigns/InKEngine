# core/contracts — 结点契约与装配开关（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` +
> `engine/AGENTS.md` · 生成物漂移守卫：`engine/scripts/verify_generated.mjs`

## 定位

两类契约的承载目录：`contracts.ts` 把「某类型结点做什么」与「哪些机制
参与运行」从代码提升为可序列化数据（纯声明 + 构造校验，零执行逻辑）；
`generated/` 为数据面契约 TS 生成物（真源 schemas+fixtures，禁手改）。

## 文件与职责

| 文件 | 职责 |
| ---- | ---- |
| `contracts.ts` | NodeContract / PathAssemblyFlags / BOOT_KEY_* / QualityGate（PathAssemblyConfig 类与 `as_path_assembly_config()` 已随组装链路退役删除，W7-B） |
| `generated/index.ts` | 生成物汇出口（endpointTypes + patchProtocol） |
| `generated/endpointTypes.ts` | 内置端点契约（七端点 spec + FieldKind） |
| `generated/patchProtocol.ts` | 补丁协议（PATCH_KINDS/OPS、审批分级、审计状态、守卫面） |

## 对外契约面

| 导出 | 形态 | 语义 |
| ---- | ---- | ---- |
| `NodeContract` | 类 | input/output_schema（SchemaSpec）+ safety_tier 0/1/2（0 最严，与审批档 L0-L2 同阶）+ version ≥1；to_dict/from_dict 随图定义落库；可缺省（无契约结点不受契约门约束，pool 结点类型登记与执行期契约校验共用） |
| `PathAssemblyFlags` | 类 | 七块独立 feature flag（contract/edge_evidence/settle_hooks/pool_governance/assembler/multipath/fingerprint_cache），缺省全关；from_boot 按 BOOT_KEY_* 长键按名读取；to_boot_dict 反向序列化。W7-B 注：pool_governance/assembler/fingerprint_cache 三位的机制消费面已随组装链路退役；类保留为 boot 透传协议形状（键名 = 装配协议一部分），生产侧现仅剩 `kernel/multipath` 的类型签名消费 |
| `BOOT_KEY_*`（7 个常量） | 值 | 装配透传键（`path_assembly_*_enabled`），对应壳侧 BootOptions 透传 JSON——键名是装配协议的一部分 |
| `SAFETY_TIER_MIN/MAX`、`CONTRACT_VERSION_MIN` | 值 | 安全档 0-2；契约版本下限 1 |
| `QualityGate` | 接口 | judge(domain, artifact) → bool \| Promise\<bool\>；实现归使用方，settle 只记录布尔结论；未注入闸门走 fail-closed 降级链 |

公共面导出（src/index.ts）：NodeContract/QualityGate 等类型值面（PathAssemblyConfig
值导出与 PathAssemblyConfigInit 类型已随类删除，W7-B）；**BOOT_KEY_* 与
PathAssemblyFlags 不随公共面外泄**（内部装配门，宿主经 AssemblyRecipe
机制开关显式装配）；generated 组导出 APPROVAL_LEVELS/AUDIT_STATUSES/
BUILTIN_ENDPOINT_NAMES/BUILTIN_ENDPOINTS/GUARDED_COLLECTIONS/
GUARDED_PREFIXES/PATCH_KINDS/PATCH_OPS 及配套类型。

## 数据形态（generated）

- `BUILTIN_ENDPOINTS`：http_fetch（connect）/process_exec（exec，需
  allowlist）/file_ops（read/write/delete/edit/search/search_paths，需
  root）/mcp（call，需 server_id）/web_search（search）/collab_request
  （request）/task_manager（manage）——各带 output_fields 与 sandbox_ops。
- `PATCH_KINDS` 十类；`DEFAULT_APPROVAL_LEVELS`：ui/theme=L0，
  tool/rule/knowledge/harness/event_type/environment=L1，artifact=L2
  （entity 无缺省分级）；`PATCH_OPS`：append/replace/delete；
  `AUDIT_STATUSES` 六状态（applied/rejected/conflict/invalid/reverted/
  reverted_with_notify_error）；`GUARDED_COLLECTIONS` 九集合 +
  `GUARDED_PREFIXES` 五前缀（GuardedStorage 守卫面）。

## 依赖与消费方

- 上游：`core/errors`（GraphDefinitionError）、`core/json`（isRecord/
  typeName）、`core/schema`（SchemaSpec）。
- 下游（机制面）：`kernel/runtime`（结点注册契约校验与图执行数据；组装路的
  boot flag from_boot 解析已随组装链路退役，W7-B）、
  `kernel/multipath`（QualityGate 判定注入 + PathAssemblyFlags.multipath_enabled）、
  `kernel/executor`（QualityGate）、`kernel/self_application`（审批分级/
  守卫集合/generated）、`kernel/self_proposal`（PATCH_KINDS）；core 侧
  `node_registry`/`link_validator`/`graph`/`perception`/`nodes`。

## Seam 与 IO 边界

纯函数数据形态，无 IO、无 seam；`QualityGate` 是唯一「实现外置」的窄协议
（判定逻辑归使用方，可同步/异步 thenable）。

## 不变式与门禁

- 生成物禁手改：`contracts:verify` 守漂移；一致性测试
  `test/core/contractsConsistency.test.ts` 对账 schemas/fixtures。
- 契约即数据：随图定义（checkpoint/harness）持久化，旧版本契约快照服务
  审计复现与回退；行为变更 = 契约升版。

## 测试

`test/core/contracts/contracts.test.ts`（形态校验/序列化往返/from_boot）；
消费方测试覆盖（multipath/runtime/node_registry 等；path_assembler 消费随 W7-B 退役）。
