# core/ui_schema — 界面描述数据原语（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` +
> `engine/AGENTS.md`

## 定位

产品即数据的界面面：布局树/绑定协议/主题 token 全部为可序列化数据（随
补丁链版本化），AI 经自指层提案 ui 补丁落地；引擎只做声明式校验（三层
白名单），渲染实现归产品侧（UIRenderer 接口 seam）。

## 文件与职责

| 文件 | 职责 |
| ---- | ---- |
| `uiSchema.ts` | UIBind/UINode/UISpec 数据往返（from_dict fail-closed：kind 白名单/type 必填/props dict/children 清单递归）；UISchemaValidator.validate（root 必备 + 递归节点校验 + theme token 白名单；component 带 children 违规；违规带 `path.children[i]` 节点路径）/validate_ok；UIRenderer 接口 |
| `uiSchemaSupport.ts` | 布局节点类型/绑定协议键/保留前缀常量 + Python 口径工具族（pyRepr/pyTupleRepr 单元素尾逗号/pyTruthy NaN 判假/pyInt 截断解析/typeNameOf/tupleHas）；注释自述统一迁移点 = core/py_repr.ts（已就绪，本文件暂不改实现） |

## 对外契约面

- 公共面：`src/index.ts`「UI schema」组 `export * from
  './core/ui_schema/uiSchema.js'`（全量直通——含 UIBind/UINode/UISpec/
  UISchemaValidator/UIRenderer 与从 Support 再导出的七常量；uiSchemaSupport
  本体不经公共面）。
- 校验器语义：只返回违规清单不抛错（与 SchemaValidator 同构）；定义期
  from_dict 非法形态抛 GraphDefinitionError。
- `DEFAULT_BIND_CHANNELS = ['state']`：机制层基线（引擎默认仅放行回合
  状态通道）；宿主经 AssemblyRecipe.ui_allowed_channels 装配扩展——
  装配数据化，非常量改动。

## 数据形态

- 布局节点两 kind：container（组织层级，children 递归）/component（引用
  白名单组件，禁 children）。
- 绑定协议：`{"bind": {"channel": "state", "path": "count"}}`；路径按 `.`
  分段，任一段以保留前缀 `_` 开头 = 违规（通道白名单之外的第二道路径级
  防线——防补丁链/审批/审计等机制内部态被布局读取）。
- 主题键迭代：dict 取键名 / list 取元素 / str 取字符（镜像 Python
  `for token in theme` 三态口径）。

## Seam 与 IO 边界

纯函数无 IO；`UIRenderer.render(spec) → unknown` 为机制契约（实现归
产品/渲染器包）；白名单三参（allowed_components/allowed_channels/
allowed_theme_tokens）为校验注入面。

## 装配与消费

- `kernel/runtime`：_runtime_boot/_runtime_engine（boot UISpec 与补丁
  应用点的 UISchemaValidator 校验）、_types（DEFAULT_BIND_CHANNELS 装配
  面类型）。
- `kernel/self_proposal/proposal_validator`：ui 提案 payload 的
  UISchemaValidator 校验 + DEFAULT_BIND_CHANNELS 基线。
- 渲染端（@ink-ts/renderer）运行时经 cli serve 通道消费 ui_spec 数据树，
  不静态 import 本目录。

## 不变式与门禁

- 三层白名单缺省 fail-closed：未注册组件不渲染、未放行通道不可绑、未
  声明主题键违规——杜绝「布局 JSON 执行任意代码」与信息泄漏路径。
- 未知字段忽略（schema 演进宽容）；必填缺失 = 违规。

## 疑点与不一致

1. **Support 工具族未迁移**：uiSchemaSupport.ts 注释自述「统一迁移点 =
   core/py_repr.ts 单源（已就绪，本文件暂不改实现）」——pyRepr/pyTruthy/
   typeNameOf 私拷贝仍存活（与 tool_vetting/_types、builder/_types、
   rules/_py、environments/_repr 等多处置并存；core/py_repr.ts 头注列
   名为收敛清单）；pyTruthy 的 NaN 判假差异自述为「本实现差异」。
2. **`pyInt`/`pyRepr` 等抛裸 Error**：Support 工具族异常为裸 Error（非
   GraphDefinitionError），from_dict 校验链中若触发会以非 EngineError
   形态穿透（与 uiSchema.ts 主体 GraphDefinitionError 口径不一致）。
3. **container 无 children 不违规**：validateNode 对 container 的
   children 仅在 Array 时递归、缺失/非数组静默通过——空 container 合法
   语义未见显式说明（component 带 children 显式违规，两 kind 不对称）。
4. **UINode 构造不校验 kind**：构造器直接接受任意 kind 字符串（校验在
   from_dict）；直接构造 UINode 可绕过 kind 白名单（实例化路径与序列化
   路径校验不对称）。

## 测试

`test/core/ui_schema/uiSchema.test.ts`（数据往返/三层白名单/保留前缀/
违规路径可读性）。
