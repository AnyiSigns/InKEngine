# schema/（core/schema — Schema 校验器）

声明式 schema 校验（L1 准入机制件）：`SchemaField`/`SchemaSpec` 声明数据
形态 + `SchemaValidator` 执行体。约束取「声明式够用」子集（必填/类型/枚举/
数值范围/正则），未知字段忽略（演进宽容），违规清单可读可审计。

## 文件
- `schemaValidator.ts` — FIELD_* 五类型常量 + `VALID_KINDS`（与数据面
  生成物 FieldKind 经 `satisfies` + 编译期集合相等绑定，单一真源）+
  `validate_tool_name`（长度 ≤24、禁 `_`）+ SchemaField/SchemaSpec
  （to_dict/from_dict 往返，from_dict 全量校验含正则可编译性与 min≤max）+
  SchemaValidator.validate/validate_ok（点路径解析 + 数组下标 + `_` 前缀
  段拒读）。

## 依赖
- 上游：`core/contracts/generated`（FieldKind 单一真源）、`core/errors`、
  `core/json`。
- 下游：`src/index.ts`（公共面 `export * from './core/schema/schemaValidator.js'`）、
  `core/contracts`（NodeContract schema 声明语言）、`core/nodes`、
  `core/perception`、`core/state`（StateSchema 同语言）、`core/graph` 等；
  `test/core/schema/schemaValidator.test.ts`。

## 备注
- typeNameOf 的 Python 口径（dict/list/str/int/NoneType）供违规消息可读；
  校验器只返回清单不抛错，定义期非法声明才抛 GraphDefinitionError。
- 正则约束校验时自动锚定 `^(?:pattern)$`（pattern 本身不需自带锚点）。
