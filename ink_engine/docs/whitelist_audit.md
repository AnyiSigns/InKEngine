# 机制层硬编码白名单审计（装配数据化 / 机制固有 二分定界）

审计范围：引擎机制层（`ink_engine/ink_engine/core/`）全部「硬编码清单」——
权限动作集合、工具端点类型、事件渲染器名、界面绑定通道、审批决议集合、
审核卡类型、补丁类型、沙箱守卫操作域、内置谓词、系统事件信号。

二分口径：
- **装配数据化**：引擎只提供默认值与配方覆盖位，清单内容归装配数据
  （宿主/种子声明），引擎不持有产品级清单；
- **机制固有**：清单与机制语义绑定（分发/守卫/协议/语法），内容由
  引擎定义、不可经装配数据扩展；若产品必须扩展而引擎硬编码 = 缺口，
  记入文末遗留决策。

## 逐项审计结果

| 模块 | 清单 | 二分 | 说明 |
|---|---|---|---|
| `permissions.py` | `_DOMAIN_ACTIONS`（filesystem/read\|write\|delete、process/exec、network/connect） | 机制固有 | 域语义绑定（network 后缀匹配、filesystem 路径边界 + `..` 拒绝）；实际判定对未知域 fnmatch 兜底（`rule_matches` 自定义域分支），**非收紧型**——清单仅作校验与文档，宿主自定义域不拒绝 |
| `declarative_tools.py` | `EndpointType` + 端点类型注册表 | 机制固有（内置默认）+ 数据化扩展位 | 端点类型决定分发（执行体注册表 key）、守卫接线（沙箱/配置要求）、操作推导语义；**内置 7 种** = 引擎默认（机制语义），**端点类型注册表**（`EndpointTypeRegistry`，谓词注册表同哲学）为宿主扩展位——自定义端点经注册表条目（判定动作域/配置必填键/契约输出形态/提取与失败原因钩子/沙箱守卫接线）登记，与内置端点同等走全流水线；执行体注册为另一数据化扩展位（宿主 `register` 注入） |
| `event_types.py` | 事件渲染器名（`EventTypeSpec.renderer`） | 装配数据化 | renderer = 数据字段（前端组件引用），引擎无渲染器名清单、无白名单校验；事件类型经注册表数据化演化（补丁链） |
| `ui_schema.py` | `DEFAULT_BIND_CHANNELS` | 装配数据化 | 引擎默认仅 `state`；`AssemblyRecipe.ui_allowed_channels` 配方覆盖位放行产品扩展通道，校验器与渲染器同源 |
| `ui_schema.py` | `_VALID_NODE_KINDS`（container/component） | 机制固有 | 布局树语法（JSON 描述语法本身），非可扩展清单 |
| `ui_schema.py` | `RESERVED_BIND_PREFIXES`（`_`） | 机制固有 | 内部数据保护语义（补丁链/审批/审计等内部通道默认不放行的路径级防线） |
| `approval.py` | `VALID_DECISIONS`（accept/edit/reject/terminate/auto） | 机制固有 | 审批协议决议集合（注入值校验 + fail-closed 兜底语义） |
| `review_card.py` | `REVIEW_TYPES`（gate/body/audit/candidate） | 机制固有 | 审批卡协议（模块 docstring 已注明「新增卡类型必须在此登记」） |
| `self_proposal.py` | `PatchKind`（9 补丁类型） | 机制固有（类型集合）+ 装配数据化（分级表） | 类型集合绑定校验分派（`_validate_{kind}`）——机制固有；审批分级表 `approval_levels` 经配方数据注入——装配数据化 |
| `sandbox.py` | `FS_OPERATIONS`（read/write/delete） | 机制固有 | FileSandbox 守卫操作域（与权限域 filesystem 动作同源） |
| `rules.py` | `_BUILTIN_PREDICATES`（13 内置谓词） | 机制固有（内置默认）+ 数据化扩展位 | 内置谓词 = 引擎默认实现（机制语义）；`RuleTypeRegistry.register` 允许宿主注册新谓词——谓词集可数据化扩展，非封闭白名单 |
| `executor.py` | `RunOptions.system_events` | 装配数据化 | 系统信号集合由装配合成注入（`EventTypeRegistry.system_events()`），模块级常量默认空——注册表是动态化的正式载体 |

## 结论

- 已装配数据化：事件渲染器名、绑定通道、审批分级表、系统事件信号、
  谓词集（内置默认 + 注册扩展位）、**端点类型（注册表 + 引擎默认内置）**、
  执行体注册。
- 机制固有（不可数据化、理由成立）：权限域动作、布局树语法、
  保留前缀、审批决议集合、审核卡类型、补丁类型集合、
  沙箱守卫操作域。
- 无收紧型误伤：权限域动作对自定义域 fnmatch 兜底，不拒绝宿主扩展域。

## 遗留决策

- ~~L1 端点类型封闭缺口~~ **已关闭（2026-09-01）**：端点类型 =
  `EndpointTypeRegistry` 声明式注册表 + 引擎默认内置 7 种。自定义端点
  经注册表条目连带声明判定动作域/配置必填键/契约输出形态/提取与失败
  原因钩子/沙箱守卫接线（`sandbox_ops` 非空而 `sandbox_builder` 缺失 =
  注册即拒绝），未注册端点 = 定义期拒绝 + 分发处 fail-closed。注册 =
  宿主装配期代码动作（非 agent 可写数据），与谓词注册同等级；壳侧
  Rust 对自定义端点宽容载入（`Endpoint::Unknown` 透传，守卫语义由引擎
  侧注册表承担）。
