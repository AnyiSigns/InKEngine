/**
 * evolution.evaluate 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/evolution.ts
 * 迁入，语义零改）。择优半环收口 + 参数固化：读 org.archive 快照 →
 * evaluate_and_adapt（apply_shortcut/downrank/retire_scope，keep 仅报告）→ 同一
 * 采纳闸 → ControlledEvolutionApplier（审批 + 补丁链落库）→ 回执。
 */

import { ControlledEvolutionApplier, OrgArchive, evaluate_and_adapt, effective_org_evaluate_thresholds, make_trial_runner, normalize_org_evaluate_thresholds } from '@ink-ts/engine';
import type { ExecutionRuntimeDeps, LoadedScope } from '@ink-ts/engine';
import { BridgeError } from '@ink-ts/host';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import {
  CARDLESS_CTX,
  ORG_ARCHIVE_COLLECTION,
  ORG_ARCHIVE_KEY,
  applyProposalSet,
  assertHeadlessApproval,
  evaluate_trial_probe,
  parseCommonParams,
  proposal_target,
  readOrgEvolutionThresholds,
  registeredScopeIds,
  requireRuntimeParts,
  trialBase,
} from '../../../_shared/evolution.js';

export default function createEvolutionEvaluate(deps: HostBridgeDeps): BridgeHandler {
  const evaluate: BridgeHandler = async (raw, ctx): Promise<unknown> => {
    const { pose: poseParam, dry_run: dryRun } = parseCommonParams(raw, 'evolution.evaluate');
    const { service, storage, registry, writer } = requireRuntimeParts(deps);
    // 读 org.archive 快照（flush 保证执行 settle 的内存 ingest 已落盘；损坏显式拒）
    await service.flushArchiveSnapshot();
    const snapshot = await storage.get_record(ORG_ARCHIVE_COLLECTION, ORG_ARCHIVE_KEY);
    let archive: OrgArchive;
    if (snapshot === null || snapshot === undefined) {
      archive = new OrgArchive();
    } else {
      try {
        archive = OrgArchive.from_dict(snapshot);
      } catch (error) {
        throw new BridgeError(
          `org.archive 快照不可读：${error instanceof Error ? error.message : String(error)}`,
          'invalid_archive',
        );
      }
    }
    const directory = registeredScopeIds(registry);
    const rawThresholds = readOrgEvolutionThresholds(deps);
    const normalization = rawThresholds === null
      ? { overrides: {}, ignored: [] }
      : normalize_org_evaluate_thresholds(rawThresholds);
    const adaptation = evaluate_and_adapt(archive, {
      thresholds: normalization.overrides,
      directory_scopes: directory,
    });
    const receipt: Record<string, unknown> = {
      ok: true,
      archive: {
        ingested: archive.ingested_count(), patterns: archive.pattern_entries().length,
        chains: archive.chain_entries().length, scopes: archive.scope_entries().length,
      },
      thresholds_effective: effective_org_evaluate_thresholds(normalization.overrides),
      thresholds_ignored: normalization.ignored,
      directory_scopes: directory,
      keeps: adaptation.keeps,
      proposals: adaptation.proposals.map((p) => p.to_dict()),
    };
    if (adaptation.proposals.length === 0) return { ...receipt, status: 'no_proposals', results: [] };
    const pose = poseParam ?? (ctx.autoApprove === true ? 'auto' : 'review');
    assertHeadlessApproval(deps.host.interrupt_policy(), 'evolution.evaluate', pose, dryRun, adaptation.proposals);
    // 择优目标均为既有目录资产（装载面直读宿主执行装配），单一隔离试跑执行器
    const base = await trialBase(service, pose);
    const runner = make_trial_runner({
      deps: {
        ...base, load_scope: (scopeId: string): LoadedScope | null => service.loadScope(scopeId),
      } as ExecutionRuntimeDeps,
      probe: evaluate_trial_probe,
    });
    const applier = new ControlledEvolutionApplier({
      entities: registry, channels: service.channels, writer,
      approvalPolicy: deps.host.interrupt_policy(), pose,
    });
    const { results, applied } = await applyProposalSet(applier, adaptation.proposals, {
      dryRun, targetOf: proposal_target, runnerFor: () => runner,
    });
    return {
      ...receipt,
      status: dryRun ? 'dry_run' : applied === adaptation.proposals.length ? 'applied' : 'partial',
      applied,
      results,
    };
  };

  return evaluate;
}
