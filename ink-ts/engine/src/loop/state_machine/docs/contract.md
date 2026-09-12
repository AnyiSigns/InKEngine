# core/state_machine — 状态机原语与转换日志（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` + `engine/AGENTS.md`

## 定位

状态机通用底座（state_machine.py 移植），与补丁链心智模型一致：转换 = 补丁（append-only），当前状态 = 最后应用结果。状态机不持有可变状态字段，而是持有一条不可回写的转换日志——天然支持回溯（这个状态何时变成这样）、回滚（截断日志重推）与分支（复制日志前缀）。三个组件各司其职：`StateMachine` 声明式规则（纯判定、无状态）、`StateTransition` 一条转换记录（不可变、可序列化落库）、`TransitionLog` append-only 日志容器。领域中立：状态名、终态、触发方（actor）取值均由使用方声明，引擎不内置任何业务状态语义。

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `state_machine.ts` | `StateMachine` 规则判定、`StateTransition` 记录与 `to_dict`/`from_dict`、`TransitionLog` 追加/回滚/历史、`TimeSource`/`INITIAL_STATE`/`AllowedMap` 及各构造选项接口（`StateMachineOptions`/`StateTransitionInit`/`FromDictOptions`/`TransitionLogOptions`/`AppendOptions`）。 |

## 对外契约面

- 目录导出：`StateMachine`、`StateTransition`、`TransitionLog`、`TimeSource`、`INITIAL_STATE`、`AllowedMap`、`StateMachineOptions`、`StateTransitionInit`、`FromDictOptions`、`TransitionLogOptions`、`AppendOptions`。
- 公共面：`src/index.ts` 无本目录导出（grep 核对无 state_machine/StateMachine/TransitionLog 字样）——当前为 core 内部机制件，仅 `core/rules/predicates.ts` 消费。

## 数据形态

- 转换记录：`StateTransition{to_state, from_state(null = 初始写入), actor(缺省 'system'), note, at(epoch 秒，缺省时间源取值或 0), meta(JsonRecord，防御性拷贝)}`；构造即 `Object.freeze`（镜像 Python frozen dataclass 的赋值即抛错）。
- 规则声明：`StateMachineOptions{terminal_states?, allowed?: 前态 → 允许后态清单, name?}`；判定顺序：目标不在状态集 → 前态属终态 → 白名单外。
- 未声明 allowed 时除终态约束外任意转换合法（多数领域只需终态单向，避免声明爆炸）；白名单缺前态来源 = 全部拦截；`states`/`terminal_states` 以只读视图暴露。

## Seam 与 IO 边界

- 时间 seam：`TimeSource = () => number`（等价 Python `time.time()`），构造/`from_dict`/`append` 逐点注入；宿主不注入时按确定性默认 0 落盘，保证纯函数可复现。
- 纯函数，无 IO 声明；Python 侧拒绝写入时的 warning 留痕属观察面副作用，纯核心省略（logging 不影响判定语义）。

## 装配与消费

- 当前唯一消费点：`core/rules/predicates.ts` 以 `StateMachine` 表达规则判定（具体状态定义由使用方领域包声明）。
- 错误语义：构造期终态/白名单引用 `states` 之外的状态即抛 `Error`（配置错误尽早暴露，防运行期静默误判）；`TransitionLog.append` 对无变化、目标状态非法、非法转换（终态复活/白名单外）三类写入返回 null 且不落日志，终态单向与白名单约束内置强制，调用方无需自行预检；`StateTransition.from_dict` 非 dict 抛 `TypeError`、缺 `to_state` 抛 `Error`、`at` 数值格式非法抛 `Error`，其余字段缺失走默认值（兼容 schema 增量演进）。
- `rollback(steps)`：steps ≤ 0 空操作，超过日志长度回到初始状态；`history()` 返回正序副本。

## 不变式与门禁

- append-only：日志条目只增不改，当前状态永远由日志推导（空日志 = 初始状态）。
- 不可变与防御性拷贝：`StateTransition` 冻结实例；meta 构造与读取均拷贝，调用方事后改动不影响已落条目。
- core 纯函数纪律：零框架/零 `node:*`/零宿主词/JSON 进 JSON 出。
- 架构门禁（`vitest run --root engine` 随跑）：core 目录 import 白名单与宿主词扫描。

## 测试

`test/core/state_machine/state_machine.test.ts` 镜像一件：规则判定（合法状态与 None 占位、初始写入放行、非法目标、终态单向、白名单约束与缺源全拦、声明期终态/白名单越界报错）、TransitionLog（日志推导当前状态、三类拦截不落、历史正序副本、actor/note/meta/at 完整落条目、meta 防御拷贝、回滚截断重推与非正步数空操作、从条目重建日志、日志持机）、StateTransition 序列化（往返、缺字段容错、冻结实例赋值即抛错）。

## 疑点与不一致

- 定位与消费面落差：文件头自称「状态机通用底座」，src 内消费仅 `core/rules/predicates.ts` 一处（且只 import `StateMachine`）；`StateTransition`/`TransitionLog`/`TimeSource`/`INITIAL_STATE`/各选项接口在 src 内无任何外部 import（grep 核对），也未上公共面——除镜像测试外无消费方。
- 错误类型不统一：本模块抛裸 `Error`/`TypeError`（构造期越界、`from_dict` 校验），未接入 `core/errors.ts` 的 `EngineError` 族；同类定义非法场景在 graph/state 目录用 `GraphDefinitionError`，本模块的选择依据未见显式说明。
- `from_dict` 与构造器空值语义不对称：构造器 `actor: init.actor ?? 'system'` 保留空串 `''`，`from_dict` 走 `actorRaw ? String(actorRaw) : 'system'`（空串 actor 回落 `'system'`）；`meta` 非 dict 记录在 `from_dict` 被静默丢弃为缺省 `{}`（`isRecord(metaRaw) ? metaRaw : undefined`），无报错。
- `resolveAt` 以 `!raw` 判缺失（注释自述对齐 Python `or`）：显式 `at: 0` 与缺失不可区分——注入时间源时显式 `at: 0` 会取 `now()` 返回值。
- 「天然支持回溯、回滚与分支（复制日志前缀）」为头注释表述：类上仅见回溯（`history`）与回滚（`rollback`）API，「分支」无对应方法或消费方；`rollback` 截断的日志不可恢复（无快照/分支 API），与「append-only」表述的关系仅注释自述。
