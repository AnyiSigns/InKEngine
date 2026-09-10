# kernel/permissions — 声明式权限门禁（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` + `engine/AGENTS.md`

## 定位

声明式权限门禁判定原语（`ink_engine.core.permissions` 移植）：工具权限 =
声明式字符串集合（`ToolSpec.permissions`，`domain:action:pattern`），判定
三路 allow/review/deny（`PermissionGate.check → GateResult`）——未声明权限
默认拒绝（fail-closed）。review 只返回「需审批」标记、自身不挂起（委托
宿主/门禁桥）；含 NetworkPolicy/NetworkPolicySandbox 网络守卫接线。

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `permissions.ts` | `ALLOW`/`REVIEW`/`DENY` 常量；`parse_permission`（三段式解析，形态非法抛 Error）/`PermissionRule`；`rule_matches`（分域语义：filesystem 反斜杠归一 + posixParts 含 `..` 段一律不命中、network `*.domain` 后缀匹配、其余/自定义域 fnmatch 兜底）+ `network_matches`；`GateResult`/`PermissionGate`（check：权限命中 × `review_tier` 分级 → allow/review/deny，未声明权限按 `default_policy` 兜底）；`ToolGateConfig`（default_policy 白名单校验 + review_tools → `to_gate()` 谓词）；fnmatch 同语义正则翻译（`*`/`?` 跨路径分隔符、`[seq]`/`[!seq]`、大小写敏感、全文锚定；模块级编译缓存 512 上限最旧即弃） |
| `networkPolicy.ts` | `NetworkPolicy`（`allows(host)` 白名单后缀匹配，缺省空 = 禁网）；`NetworkPolicySandbox extends NetworkPolicy`：`guards_operation` 仅 connect、`validate` 非 connect 操作抛 `SandboxViolation`、白名单外域名按 `unlisted_policy` 处置（deny=抛错，审批也不能放行；review=返回放行，由门禁桥强制转审批——审批即网关）、`requires_review` |
| `contract.ts` | `permissions_contract: MechanismContract`：id `'permissions'`、effects `[]`（纯判定原语）、depends `[]`（网络策略与门禁同目录互引属机制内部面） |

## 对外契约面

公共面「权限与沙箱安全类型」组：`src/index.ts` `export * from
'./kernel/permissions/permissions.js'`——12 名全部上公共面（逐名核对）：
`ALLOW` `DENY` `REVIEW` `PermissionRule` `parse_permission` `network_matches`
`rule_matches` `GateResult` `PermissionGate` `ToolGateConfig` `NetworkPolicy`
`NetworkPolicySandbox`（后二经 `permissions.ts` 尾部转出，`networkPolicy.ts`
无独立公共面入口）。机制契约 `permissions_contract` 经
`kernel/registry/contracts.ts` 入全量注册表（34 机制）。

## 数据形态

- 权限声明：`domain:action:pattern` 三段式（action 可省略 = `*`；pattern 内
  `|` 分隔多模式任一命中）；域动作表：filesystem read/write/delete/edit、
  process exec、network connect/search（search = web_search 独立动作，查询串
  不做域名匹配）；未知域不拒绝（fnmatch 兜底，非收紧型）。
- `GateResult`（decision/tool/operation/target/reason）；`PermissionGate`
  构造参数 `default_policy`（缺省 DENY）+ `review_tier` 谓词。
- `ToolGateConfig`：`default_policy`（deny/review/allow 之外抛 Error）+
  `review_tools`（等价 review_tier 的数据化声明）→ `to_gate()` 装配运行时
  门禁（空工具集 = 与缺省门禁判定一致）。
- `NetworkPolicySandbox`：`unlisted_policy` 'deny'（缺省，fail-closed）/
  'review'（白名单外转审批，accept 后放行）。

## Seam 与 IO 边界

机制契约 effects 空、depends 空——判定全部纯函数，无时间/随机 seam、零
日志。模块级 fnmatch 编译缓存有界（512、最旧即弃，防不可信高基数 pattern
撑爆）。`SandboxViolation`（core/errors）由 `NetworkPolicySandbox` 抛出，
供 `ToolPipeline` 沙箱环节 catch 收口为拒绝结果；review 档只标记、挂起
委托宿主/门禁桥（`core/declarative_tools/_gates.ts`）。

## 装配与消费

- 引擎级门禁：`kernel/runtime/_runtime_assemble`（`recipe.tool_gate.
  to_gate()`，未配置 = 缺省 `new PermissionGate()`）——与 hosts/lib
  `recipe.ts` 的 `tool_gate` 配置字段（`ToolGateConfig` 经公共面构造）对齐。
- 端点级：`core/declarative_tools/pipeline.ts`（`options.gate ?? new
  PermissionGate()`）+ `_gates.ts` 把端点 `network_policy` 装配为
  `NetworkPolicySandbox`（review 档桥接审批）。
- 判定原语消费：`kernel/tool_pipeline`（ALLOW/DENY/REVIEW/GateResult）、
  `kernel/tool_vetting`（`parse_permission` 校验清单权限声明）、
  `core/declarative_tools/declarative_spec.ts`（声明解析）。

## 不变式与门禁

- fail-closed 缺省：未声明权限 = deny；`default_policy` 放宽为 review/allow
  须宿主明示；未知 gate decision 由调用方（tool_pipeline）拒绝。
- 路径边界：filesystem 判定前反斜杠归一，含 `..` 段的路径一律不命中
  （fnmatch 的 `*` 跨分隔符放行 `/book/../../etc/passwd` 的越界由权限层先
  守住）；未声明权限拒绝时附「须以工作区根绝对前缀开头」引导文案。
- 网络默认禁网：白名单外域名 deny 档抛 `SandboxViolation`（审批也不能
  放行——收紧面）；review 档审批即网关（白名单 = 免审批快速路径）。
- legacy 兼容：`network:connect:*` 规则对 search 操作命中（`rule_matches`
  显式分支）；机制不给宿主自定义域额外语义（拼写错误静默不命中 = 默认
  拒绝，不误放行）。
- 沙箱是机制、非安全边界承诺——默认拒绝兜底 + 纵深防御，宿主可叠加 OS 级
  隔离。

## 测试

镜像测试 `test/kernel/permissions/permissions.test.ts`（4 组）：权限解析
（`parse_permission`）、分域匹配（filesystem/network/自定义域）、三路判定
（allow/review/deny × default_policy/review_tier）、网络白名单
（`*.domain` 后缀语义）。

## 疑点与不一致

1. 主文件头注释称「SandboxViolation 暂无 TS 类映射，按既有移植口径以
   `new Error` 表达（待 core.exceptions 其余领域异常移植后收敛）」——同目录
   `networkPolicy.ts` 已 import 并抛 core/errors 的 `SandboxViolation`，注释
   与同目录现实不符（陈旧）；且 `parse_permission`/`ToolGateConfig` 的校验
   错误实际为裸 `new Error`（Python ValueError 映射），未接 EngineError 族。
2. 模块头注释列举 filesystem 动作「read|write|delete」，域动作表
   `DOMAIN_ACTIONS` 另含 `edit`（与 `tool_pipeline` 的 edit 决议对齐）——
   注释列举不全。
3. 本文件自带私有 `pyRepr`（字符串版）；pyRepr/pyTruthy 家族在
   core/py_repr.ts（自认单源）与 builder/self_tools/self_proposal/
   tool_vetting/approval/audit_log 多处拷贝并存，迁移未落地。
4. `NetworkPolicySandbox.validate` 在 review 档白名单未命中时直接返回
   target 放行——依赖门禁桥「已强制转审批」的前置协作（`_gates.ts`），
   单独使用该沙箱时 review 档即放行，协作约束无类型级强制（注释声明）。
