# generated/（数据面契约生成物）

由 `engine/scripts/generate.mjs` 依据 `engine/schemas/` 与
`engine/fixtures/` 生成的 TS 常量/类型，**勿手改**——数据面契约以 JSON 真
源为准，漂移由 `contracts:verify`（`node engine/scripts/verify_generated.mjs`）
强制；全仓经 `@ink-ts/engine` 公共面取用，禁止第二套语义枚举。

## 文件
- `index.ts` — 汇出口（endpointTypes + patchProtocol）。
- `endpointTypes.ts` — 内置端点契约：`BUILTIN_ENDPOINT_NAMES` 七个端点名
  （http_fetch/process_exec/file_ops/mcp/web_search/collab_request/
  task_manager）、`BUILTIN_ENDPOINTS`（actions/config_requirements/
  output_fields/sandbox_ops 逐端点 spec）、`FieldKind`（string/number/
  object/array/boolean，与 schema 校验器同源）。
- `patchProtocol.ts` — 补丁协议：`PATCH_KINDS` 十类（ui/theme/tool/rule/
  knowledge/harness/event_type/environment/artifact/entity）、
  `DEFAULT_APPROVAL_LEVELS`（按 kind 的缺省审批分级 L0/L1/L2）、
  `PATCH_OPS`（append/replace/delete）、`AUDIT_STATUSES` 六状态
  （applied/rejected/conflict/invalid/reverted/reverted_with_notify_error）、
  `GUARDED_COLLECTIONS`/`GUARDED_PREFIXES`（GuardedStorage 守卫面：九个
  集合 + 五个前缀）。

## 依赖
- 上游（真源）：`engine/schemas/` + `engine/fixtures/` + 生成器脚本——本
  目录是生成产物，无 import。
- 下游：`src/index.ts` 数据面契约组（全仓公共面导出）；kernel 消费方
  `self_application`（审批分级/守卫集合）、`self_proposal`（PATCH_KINDS）；
  core 声明式工具端点注册表（BUILTIN_ENDPOINTS）；一致性测试
  `test/core/contractsConsistency.test.ts` 与端点注册表测试对账。
