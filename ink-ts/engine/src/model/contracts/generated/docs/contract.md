# contracts/generated — 数据面契约生成物（契约文档）

> 真源：`engine/schemas/` + `engine/fixtures/` + 生成器
> `engine/scripts/generate.mjs` · 漂移守卫：`contracts:verify`
> （`node engine/scripts/verify_generated.mjs`）· **勿手改**

## 定位

引擎内置数据面契约的 TS 生成物：枚举/谓词/补丁类型/端点规格以 JSON 真源
为准，生成 TS 常量/类型随 engine tsc/gate 守门；全仓经
`@ink-ts/engine` 公共面取用，禁止第二套语义枚举（engine/AGENTS.md）。

## 文件与职责

| 文件 | 职责 |
| ---- | ---- |
| `index.ts` | 汇出口（`export * from './endpointTypes.js'` + `'./patchProtocol.js'`） |
| `endpointTypes.ts` | 内置端点契约 |
| `patchProtocol.ts` | 补丁协议 |

## 对外契约面

endpointTypes.ts：
- `BUILTIN_ENDPOINT_NAMES`：http_fetch / process_exec / file_ops / mcp /
  web_search / collab_request / task_manager（七端点）。
- `BUILTIN_ENDPOINTS`：逐端点 spec——actions（http_fetch=[connect]、
  process_exec=[exec]、file_ops=[read,write,delete,edit,search,
  search_paths]、mcp=[call]、web_search=[search]、collab_request=
  [request]、task_manager=[manage]）、config_requirements（process_exec 需
  allowlist、file_ops 需 root、mcp 需 server_id）、output_fields（含
  required/kind）、sandbox_ops。
- `FieldKind`：string/number/object/array/boolean（与 schema 校验器同源）。

patchProtocol.ts：
- `PATCH_KINDS` 十类（ui/theme/tool/rule/knowledge/harness/event_type/
  environment/artifact/entity）；`KnownDefaultPatchKind` = entity 之外九类。
- `DEFAULT_APPROVAL_LEVELS`：ui/theme=L0；tool/rule/knowledge/harness/
  event_type/environment=L1；artifact=L2（entity 无缺省分级）。
- `PATCH_OPS`：append/replace/delete。
- `AUDIT_STATUSES` 六状态：applied/rejected/conflict/invalid/reverted/
  reverted_with_notify_error。
- `GUARDED_COLLECTIONS` 九集合（set_patch_chain/set_audit/ui/tool_defs/
  event_types/environments/artifacts/harness/entities）+ `GUARDED_PREFIXES`
  五前缀（knowledge:/harness:/event_types:/entities:/node_registry:）——
  GuardedStorage 守卫面（演化资产受控通道的数据判据）。

公共面：`src/index.ts`「数据面契约」组按名再导出（生成物不整组
export *，防面无序膨胀）。

## 依赖与消费方

- 上游：无 import（生成产物）。
- 下游：`kernel/self_application`（constants.ts/approval_level.ts：审批
  分级 + 守卫集合）、`kernel/self_proposal`（PATCH_KINDS）、core 声明式
  工具端点注册表（BUILTIN_ENDPOINTS 对账）；一致性测试
  `test/core/contractsConsistency.test.ts` 与
  `test/core/declarative_tools/registry.test.ts`。

## 不变式与门禁

- 生成文件头自带「勿手改」标注；`contracts:verify` 全仓 CI 链强制。
- 改契约的唯一路径：改 schemas/fixtures JSON 真源 → 重跑 generate.mjs。

## 测试

`test/core/contractsConsistency.test.ts`（生成物 ↔ JSON 真源一致）；
端点注册表测试（`test/core/declarative_tools/registry.test.ts`）以
BUILTIN_ENDPOINTS 为权威对账。
