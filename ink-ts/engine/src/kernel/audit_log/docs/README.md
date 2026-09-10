# audit_log（kernel/audit_log）

干预能力审计落库统一出口（append-only，复用 `set_audit` 集合）：候选选择/
多径开关/缓存失效/边档降级四类干预 op 与运行期审计同集合可追溯——存储 seam
注入、失败不阻断干预动作。

## 文件
- `audit_log.ts` — `AUDIT_COLLECTION`（'set_audit'）、`AuditRecord`/`AuditStorage`/`MechanismExemptionScope`/`GuardedAuditStorage`/`EmitAuditOptions` 形态、`emit_audit`（ts/kind 增补 + 豁免通道 + 失败跳过）。
- `contract.ts` — 机制契约：id `audit_log`、effects `[storage_seam]`、depends 空。

## 依赖
- 上游（本目录实际 import）：`kernel/registry/ports`（`PORT_STORAGE_SEAM`）、`kernel/registry/contract_types`。
- 下游（实际 import 本目录）：`kernel/evolution_writer`（`emit_audit` + `AuditStorage`/`MechanismExemptionScope` 类型）、`kernel/runtime`（`_runtime_mechanisms`/`_runtime_engine`）、`kernel/path_assembler/intervention`、`core/edge_evidence/intervention`、`core/fingerprint_cache/invalidate`、`kernel/registry/contracts`；公共面零导出（grep `src/index.ts` 无本目录任何名）；测试 `test/kernel/audit_log`。
