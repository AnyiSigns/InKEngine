# ui_schema/（core/ui_schema — 界面描述数据原语）

产品即数据：界面描述 = JSON 布局树 + 绑定协议 + 主题 token，渲染器 =
机制实现（产品侧装配）。AI 经自指层提案 ui 补丁落地布局，渲染器消费最新
描述即时重渲。安全边界：组件/绑定通道/主题 token 三层白名单——JSON 只能
描述、不能执行。

## 文件
- `uiSchema.ts` — `UIBind`（channel/path，from_dict fail-closed）、`UINode`
  （container/component 两 kind、children 递归、to_dict/from_dict）、
  `UISpec`（布局树 + theme + version，随补丁链版本化）、`UISchemaValidator`
  （结构 + 三层白名单递归校验，违规清单带节点路径）、`UIRenderer` 渲染器
  接口（机制契约，实现归产品）。
- `uiSchemaSupport.ts` — 常量（NODE_KIND_*/BIND_*/DEFAULT_BIND_CHANNELS=
  ['state']/RESERVED_BIND_PREFIXES=['_']）+ Python 口径工具（pyRepr/
  pyTupleRepr/pyTruthy/pyInt/typeNameOf/tupleHas；注释自述收敛迁移点 =
  core/py_repr.ts 单源）。

## 依赖
- 上游：`core/errors`、`core/json`。
- 下游：`src/index.ts`（公共面 `export * from './core/ui_schema/uiSchema.js'`；
  uiSchemaSupport 不上公共面但 kernel/runtime 直连 import）、
  `kernel/runtime`（_types DEFAULT_BIND_CHANNELS/_runtime_engine/
  _runtime_boot UISchemaValidator）、`kernel/self_proposal`
  （proposal_validator 校验 ui 提案）、`core/py_repr.ts`（收敛目标自述）；
  `test/core/ui_schema/uiSchema.test.ts`。

## 备注
- 绑定双防线：通道白名单（默认仅 state，宿主经
  AssemblyRecipe.ui_allowed_channels 放行扩展）+ 路径保留前缀（`_` 开头
  段 = 内部数据拒绝绑定，防补丁链/审批/审计信息泄漏）。
- 主题键迭代镜像 Python dict 键口径（theme 为 dict 时校验键名）。
