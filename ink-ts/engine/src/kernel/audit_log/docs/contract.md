# kernel/audit_log — 干预审计落库（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` + `engine/AGENTS.md`

## 定位

干预能力审计落库的 append-only 统一出口：四类干预 op（候选选择/多径开关/
缓存失效/边档降级）经 `emit_audit` 写入引擎存储的 `set_audit` 集合——与
沉淀侧审计 sink（宿主装配处）同一落库通道，干预动作与运行期审计在同一
集合可追溯。记录 `type` 复用事件注册表既有审计类型（禁新增事件类型），
`kind` 取 `type` 作渲染归并键。

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `audit_log.ts` | `AUDIT_COLLECTION`='set_audit'；`AuditRecord`（宽松 dict，原值原形状透传只增补 ts/kind，不原地修改）；`AuditStorage`（最小契约：`put_record`——ENG5-12 显式接口替代鸭子类型）；`GuardedAuditStorage`（额外 `allow_mechanism(collection?) → MechanismExemptionScope` 豁免入口，set_audit 属受守卫集合）；`emit_audit(storage, record, {now, keyGen})`：ts 缺省取注入 now（缺省确定值 0）、键 `op-<keyGen 12 位>`（缺省固定 '000000000000'）、kind = record.type（pyTruthy 缺省 'op'）；受守卫存储走 enter → put → finally exit 豁免通道，裸存储直写；缺 `put_record`/写失败/豁免失败一律跳过不抛 |
| `contract.ts` | `audit_log_contract: MechanismContract`：id `'audit_log'`、effects `[PORT_STORAGE_SEAM]`（注入 AuditStorage 落库属 storage_seam 端口面）、depends `[]`（存储以参数注入；inputs/outputs 声明期不固化——审计记录宽松 dict） |

## 对外契约面

公共面零导出：`src/index.ts` 逐名 grep 无本目录任何名（`emit_audit`/
`AUDIT_COLLECTION`/`AuditStorage` 等仅引擎内部消费，宿主不可达）。

目录导出面（`audit_log.ts`）：值 `AUDIT_COLLECTION` `emit_audit`；类型
`AuditRecord` `AuditStorage` `MechanismExemptionScope` `GuardedAuditStorage`
`EmitAuditOptions`。机制契约 `audit_log_contract` 经
`kernel/registry/contracts.ts` 入全量注册表（34 机制）。

## 数据形态

- 集合名：`'set_audit'`（与沉淀侧 `_audit_sink` 同名——审计可追溯统一）。
- 记录：宽松 dict + 增补 `ts`（记录已有则原样保留）/`kind`（= record.type，
  空值回落 'op'）；键 = `op-` + keyGen() 12 位片段。
- 豁免作用域：`MechanismExemptionScope.enter/exit`（镜像 Python
  AbstractContextManager 的 with 语义，put 夹在两者之间）。

## Seam 与 IO 边界

机制契约 effects=`[storage_seam]`：落库经注入的 `AuditStorage` seam（最小
put_record 契约），真实存储实现由宿主注入（受守卫存储实现
`allow_mechanism` 豁免入口）；`now`/`keyGen` 为注入时间/键源（缺省确定值
0 / '000000000000'——core 零时钟零随机可复现）；Python logging.warning
留痕不移植，对应行为 = 缺 put_record / 写失败一律跳过不抛（审计失败不得
污染干预动作结果）。

## 装配与消费

- 干预面：`core/edge_evidence/intervention`、`kernel/evolution_writer`（演化写
  路径的审计留痕 + 豁免类型消费）；`kernel/path_assembler/intervention`
  （候选选择/多径开关）与 `core/fingerprint_cache/invalidate`（缓存失效）
  已随组装链路退役（W7-B）。
- 运行期面：`kernel/runtime/_runtime_mechanisms`/`_runtime_engine`
  （emit_audit 接线）。
- 机制契约经 `kernel/registry/contracts.ts` 汇总；`runtime_contract`
  depends 含 audit_log。hosts 经审计事件/记录行消费落库结果（bridge/path.ts
  按 kind 归并），不经公共面 import 本机制。

## 不变式与门禁

- append-only 统一出口：干预与运行期审计同一集合，type 禁新增事件类型
  （复用事件注册表既有审计类型）。
- 双存储兼容：受守卫存储（`allow_mechanism`）自动走豁免通道，裸存储直写；
  豁免 enter/exit 成对（finally exit）。
- 审计不阻断：无存储 = 静默跳过；契约漂移（缺 put_record）/落库失败/豁免
  失败一律跳过不抛。
- 记录不原地修改（spread 增补 ts/kind）；ts/keyGen 注入缺省确定值（纯函数
  可复现，测试可注入确定性值）。

## 测试

镜像测试 `test/kernel/audit_log/audit_log.test.ts`（3 组）：emit_audit 落库
（裸存储直接写）、emit_audit 豁免通道（受守卫存储）、emit_audit 无存储与
无副作用（跳过不抛）。

## 疑点与不一致

1. 私有 `pyTruthy` 与 `core/py_repr.ts` 导出的 `pyTruthy` 重复实现（单源
   已就绪未引用）——与 pyRepr 家族同类的拷贝并存。
2. 缺省 `keyGen` 固定 `'000000000000'` → 键恒为 `op-000000000000`：确定性
   缺省下同集合多次落库共用同键，同键写入的覆盖/共存行为取决于存储实现，
   机制层未见去重或追加语义说明（生产唯一性依赖宿主注入真实 keyGen）。
3. `contract.ts` 头注释自述「样板：最小机制」——措辞指向该文件生成自机制
   契约样板，effects 取值与正文描述一致，无功能影响（口径记录）。
