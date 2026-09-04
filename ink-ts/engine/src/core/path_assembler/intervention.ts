/**
 * 干预能力：候选选择 / 多径开关（path_assembler.py「干预能力」段移植）。
 *
 * assemble 后的运行期干预；状态经注入存储落库 + 审计（emit_audit 通道）。
 * storage 为 None 时仅返回状态不落库（与审计通道同语义：无存储 = 静默跳过）。
 * set_multipath 只翻转 PathAssemblyFlags 的 multipath_enabled 位（读写键名
 * 口径统一 ENG9a-4：from_boot 长键读取 / to_boot_dict 落库）。
 */

import { PATH_CANDIDATE_COLLECTION, PATH_FLAGS_COLLECTION } from './constants.js';
import { PathAssemblyFlags } from '../contracts/contracts.js';
import { emit_audit } from '../audit_log/audit_log.js';
import { EVENT_ASSEMBLY_CANDIDATE, EVENT_AUDIT_ASSEMBLY } from '../event_types/eventTypeSpecs.js';

/** 干预落库窄协议（只声明干预侧用到的两个原语；storage=None 早退）。 */
export interface CandidateStorage {
  get_record(collection: string, key: string): Promise<Record<string, unknown> | null>;
  put_record(collection: string, key: string, record: Record<string, unknown>): Promise<void>;
}

/** 记录候选路径人工选择（assemble 后挑选执行路径；选后状态落库 + 审计）。
 *  候选 id 为空 = fail-closed 拒绝；选中态按域覆盖写入，同一域同时只持有一条。 */
export async function choose_candidate(
  storage: CandidateStorage | null,
  candidate_id: string,
  opts: {
    domain?: string;
    chain?: readonly string[];
    fingerprint?: string;
    now?: number | null;
  } = {},
): Promise<Record<string, unknown>> {
  if (!candidate_id) {
    throw new Error('候选 id 不能为空（fail-closed）');
  }
  const domain = opts.domain ?? 'default';
  const chain = opts.chain ?? [];
  const fingerprint = opts.fingerprint ?? '';
  const ts = opts.now ?? 0;
  const selection: Record<string, unknown> = {
    domain,
    candidate_id: String(candidate_id),
    chain: [...chain],
    fingerprint,
    chosen_at: ts,
  };
  if (storage !== null) {
    await storage.put_record(PATH_CANDIDATE_COLLECTION, domain, selection);
    await emit_audit(storage, {
      type: EVENT_ASSEMBLY_CANDIDATE,
      ts,
      domain,
      fingerprint,
      candidate_id: String(candidate_id),
      chain: [...chain],
    });
  }
  return selection;
}

/** 反向操作：清除候选选择（恢复多候选观察态，不持有任何选中路径）。
 *  选中态以「标记位」覆写而非删除（candidate_id 置空 = 无选中）。 */
export async function clear_candidate_selection(
  storage: CandidateStorage | null,
  opts: { domain?: string; now?: number | null } = {},
): Promise<Record<string, unknown>> {
  const domain = opts.domain ?? 'default';
  const ts = opts.now ?? 0;
  const cleared: Record<string, unknown> = {
    domain,
    candidate_id: '',
    chosen_at: ts,
    cleared: true,
  };
  if (storage !== null) {
    await storage.put_record(PATH_CANDIDATE_COLLECTION, domain, cleared);
  }
  return cleared;
}

/** 多径开关（复用 PathAssemblyFlags 单块开关语义；状态落库 + 审计）。
 *  只翻转 multipath_enabled 位：先按域取已存 flag（缺省全关），更新后落库
 *  并回流给运行期消费。storage 为 None 时仅返回开关态不落库。 */
export async function set_multipath(
  storage: CandidateStorage | null,
  enabled: boolean,
  opts: { domain?: string; now?: number | null } = {},
): Promise<Record<string, unknown>> {
  const domain = opts.domain ?? 'default';
  const ts = opts.now ?? 0;
  let flags_out: PathAssemblyFlags;
  if (storage !== null) {
    const existing = await storage.get_record(PATH_FLAGS_COLLECTION, domain);
    const flags = PathAssemblyFlags.from_boot(existing ?? {});
    flags_out = new PathAssemblyFlags({
      contract_enabled: flags.contract_enabled,
      edge_evidence_enabled: flags.edge_evidence_enabled,
      settle_hooks_enabled: flags.settle_hooks_enabled,
      pool_governance_enabled: flags.pool_governance_enabled,
      assembler_enabled: flags.assembler_enabled,
      multipath_enabled: Boolean(enabled),
      fingerprint_cache_enabled: flags.fingerprint_cache_enabled,
    });
    await storage.put_record(
      PATH_FLAGS_COLLECTION,
      domain,
      { ...flags_out.to_boot_dict() },
    );
    await emit_audit(storage, {
      type: EVENT_AUDIT_ASSEMBLY,
      ts,
      domain,
      flag: 'multipath_enabled',
      enabled: Boolean(enabled),
    });
  } else {
    flags_out = new PathAssemblyFlags({ multipath_enabled: Boolean(enabled) });
  }
  return {
    multipath_enabled: Boolean(enabled),
    flags: { ...flags_out.to_boot_dict() },
  };
}
