/**
 * evolution.crystallize 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/
 * evolution.ts 迁入，语义零改）。受控演化统计入口：org.temp_sightings 观测 →
 * 引擎评估器 → add_scope 提案（孵化同通道）。
 */

import { EntitySpec, ControlledEvolutionApplier, evaluate_temp_sightings, make_trial_runner } from '@ink-ts/engine';
import type { EvolutionProposal, ExecutionRuntimeDeps, LoadedScope, TrialRunner } from '@ink-ts/engine';
import { BridgeError } from '@ink-ts/host';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { TEMP_SIGHTINGS_COLLECTION } from '@ink-ts/host';
import {
  CARDLESS_CTX,
  applyProposalSet,
  assertHeadlessApproval,
  isObj,
  parseCommonParams,
  proposal_asset_id,
  requireRuntimeParts,
  trialBase,
} from '../../../_shared/evolution.js';

export default function createEvolutionCrystallize(deps: HostBridgeDeps): BridgeHandler {
  const crystallize: BridgeHandler = async (raw, ctx): Promise<unknown> => {
    const { pose: poseParam, dry_run: dryRun } = parseCommonParams(raw, 'evolution.crystallize');
    const params = isObj(raw) ? raw : {};
    const roleRaw = params['role'];
    if (roleRaw !== undefined && roleRaw !== null && (typeof roleRaw !== 'string' || roleRaw.trim() === '')) {
      throw new BridgeError('evolution.crystallize role 须为非空字符串（只结晶该模式）', 'invalid_params');
    }
    const role = typeof roleRaw === 'string' ? roleRaw.trim() : null;
    const { service, storage, registry, writer } = requireRuntimeParts(deps);
    const rows = await storage.list_records(TEMP_SIGHTINGS_COLLECTION);
    const sightings = role === null ? rows : rows.filter((row) => isObj(row) && row['role'] === role);
    const evaluation = evaluate_temp_sightings(sightings, { entity_ids: registry.names() });
    const receipt: Record<string, unknown> = {
      ok: true,
      sightings: sightings.length,
      patterns: evaluation.patterns,
      proposals: evaluation.proposals.map((p) => p.to_dict()),
    };
    if (evaluation.proposals.length === 0) return { ...receipt, status: 'no_proposals', results: [] };
    const pose = poseParam ?? (ctx.autoApprove === true ? 'auto' : 'review');
    assertHeadlessApproval(deps.host.interrupt_policy(), 'evolution.crystallize', pose, dryRun, evaluation.proposals);
    // 隔离试跑基座（每提案独立装载面：提案资产按 id 穿透 load_scope 叠加）
    const base = await trialBase(service, pose);
    const runnerFor = (proposal: EvolutionProposal): TrialRunner => {
      const asset = proposal.payload['asset'] as Record<string, unknown>;
      const assetId = typeof asset['id'] === 'string' ? asset['id'] : '';
      const overlay = (scopeId: string): LoadedScope | null => {
        if (scopeId === assetId && assetId !== '') {
          try {
            return EntitySpec.from_dict(asset);
          } catch {
            return null; // 资产非法 = 试跑装载失败（inconclusive，宁拒勿放）
          }
        }
        return service.loadScope(scopeId);
      };
      return make_trial_runner({ deps: { ...base, load_scope: overlay } as ExecutionRuntimeDeps });
    };
    const applier = new ControlledEvolutionApplier({
      entities: registry, channels: service.channels, writer,
      approvalPolicy: deps.host.interrupt_policy(), pose,
    });
    const { results, applied } = await applyProposalSet(applier, evaluation.proposals, {
      dryRun, targetOf: proposal_asset_id, runnerFor,
    });
    return {
      ...receipt,
      status: dryRun ? 'dry_run' : applied === evaluation.proposals.length ? 'applied' : 'partial',
      applied,
      results,
    };
  };

  return crystallize;
}
