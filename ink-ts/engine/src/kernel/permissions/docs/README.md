# permissions（kernel/permissions）

声明式权限门禁判定原语（默认拒绝 fail-closed）：`domain:action:pattern`
权限串解析 + fnmatch 同语义匹配 + 分域判定（filesystem 路径边界 / network
域名白名单 / 宿主自定义域兜底）+ 门禁分级 + 网络策略沙箱接线。

## 文件
- `permissions.ts` — `ALLOW`/`REVIEW`/`DENY`、`parse_permission`/`PermissionRule`、`rule_matches`/`network_matches`、`GateResult`/`PermissionGate`（三路判定 + 门控分级）、`ToolGateConfig`（装配数据 + `to_gate()`）、fnmatch 同语义正则翻译（编译缓存 512 上限最旧即弃）。
- `networkPolicy.ts` — `NetworkPolicy`（白名单域名后缀匹配）/`NetworkPolicySandbox`（http_fetch connect 操作域守卫 + `unlisted_policy` deny/review 处置，违规抛 `SandboxViolation`）。
- `contract.ts` — 机制契约：id `permissions`、effects 空（纯判定）、depends 空。

## 依赖
- 上游（本目录实际 import）：`core/errors`（`SandboxViolation`，仅 networkPolicy.ts）、`kernel/registry/contract_types`。
- 下游（实际 import 本目录）：`src/index.ts` 公共面（`export *`，12 名）；`kernel/tool_pipeline`（ALLOW/DENY/REVIEW/GateResult）、`kernel/tool_vetting`（`parse_permission`）、`kernel/runtime`（`ToolGateConfig`/`PermissionGate` 装配）、`kernel/registry/contracts`；`core/declarative_tools`（`pipeline.ts` 端点 gate、`_gates.ts` NetworkPolicySandbox 桥、`declarative_spec.ts` parse_permission）；hosts/lib `recipe.ts` 经公共面构造 `ToolGateConfig`；测试 `test/kernel/permissions`。
