# core/schema — Schema 校验器（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` +
> `engine/AGENTS.md`

## 定位

声明式 schema 的声明语言与执行校验（L1 准入机制件）：结点契约输入/输出
声明（core/contracts）、状态通道 schema（core/state）、工具参数等共用
同一声明语言与校验执行体——「schema 即数据」的准入闸门。

## 文件与职责

| 文件 | 职责 |
| ---- | ---- |
| `schemaValidator.ts` | FIELD_STRING/NUMBER/BOOL/OBJECT/ARRAY 常量 + VALID_KINDS（satisfies 绑定 ContractFieldKind + `_StringSetEqual` 编译期集合相等断言——任一方向漂移即类型错误）；validate_tool_name（≤24 字符、禁 `_`，返回违规清单）；SchemaField（required/kind/enum/min/max/pattern；from_dict 校验含正则可编译、min≤max）；SchemaSpec（字段名重复拒绝）；SchemaValidator.validate（点路径 + 数组下标解析、`_` 前缀段拒读、enum/pattern/范围校验、违规清单可读）/validate_ok |

## 对外契约面

- 公共面：`src/index.ts`「Schema 校验」组 `export * from
  './core/schema/schemaValidator.js'`（全量直通）。
- 校验器语义：只返回违规清单不抛错（validate/validate_ok）；定义期非法
  声明抛 GraphDefinitionError（fail-fast）。
- `validate_tool_name` 返回清单而非抛错（与 SchemaValidator.validate 同
  「清单口径」；命名规范要求短词自然语言）。

## 数据形态

- FieldKind 单一真源 = `core/contracts/generated/endpointTypes.ts`（数据面
  schema 的 output_field.kind 枚举，schemas+fixtures 生成）——本目录 type
  直接引用，不维护第二套语义枚举（engine/AGENTS.md 约束的样板实现）。
- 字段声明合法形态示例常量（FIELD_DECL_EXAMPLE/SCHEMA_DECL_EXAMPLE）内嵌
  错误消息，可读可审计。
- 数值边界经 toFloatLike 宽容转换（数字/有限数字字符串），布尔显式拒绝。

## Seam 与 IO 边界

纯函数目录无 IO、无 seam；校验无状态（SchemaValidator 可作模块级复用）。

## 装配与消费

- 消费面广：`core/contracts`（NodeContract input/output_schema）、
  `core/state`（StateSchema/Channel 声明）、`core/nodes`（实例契约派生）、
  `core/perception`（视觉结点契约）、`core/graph`（SchemaSerializable）等；
  宿主经公共面直接取用（SchemaField/SchemaSpec/SchemaValidator）。
- `validate_tool_name` 消费方：声明式工具定义校验链（grep
  src/core/declarative_tools 与 kernel/tool_vetting 命名规范入口）。

## 不变式与门禁

- 未知字段忽略（schema 演进宽容）；必填缺失 = 违规；`_` 前缀路径段视为
  内部数据拒读（与 ui_schema 绑定保留前缀同哲学）。
- 正则：声明期校验可编译；校验期自动锚定整串匹配（`^(?:p)$`）——pattern
  无需自带锚点，锚定行为头注未述（实现事实）。

## 疑点与不一致

1. **typeNameOf 数值口径**：非整数 number 一律显示 'int'（typeof 分支
   `if (typeof value === 'number') return 'int'`）——浮点在违规消息中报
   int 类型（镜像 Python int/float 混口径的简化，消息可读性轻微失真；
   未见显式说明）。
2. **`validate_tool_name` 的 TOOL_NAME_FORBIDDEN_CHARS 仅含 `'_'`**：
   头注与常量命名暗示清单可扩展，当前单元素；与「短词自然语言」规范的
   完整字符集口径未见显式说明。
3. **pattern 校验期异常静默转违规**：校验期正则编译失败（声明期已拦，
   理论不可达）落入 catch 返回违规清单——防御分支与「声明期 fail-fast」
   的双保险口径未见说明。
4. **目录单文件**：309 行单文件承载声明+校验+工具名规范三块（≤350 合规；
   无 index.ts barrel，公共面直连文件——与 core 多数目录的 barrel 形态
   不一致）。

## 测试

`test/core/schema/schemaValidator.test.ts`（声明往返/校验清单/工具名
规范/边界与正则）。
