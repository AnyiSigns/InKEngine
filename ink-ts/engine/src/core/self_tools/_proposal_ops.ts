/**
 * 自指元工具演化操作面（core/self_tools.py _propose/_propose_domain/
 * _apply/_revert/_build_proposal 移植）。
 *
 * 提案（propose）校验形态与基准版本但不落链；领域生成器
 * （propose_domain_manifest）从高层输入产出最小 harness 定义并提案
 * （仅生成 + 校验 + 提案，落链走 apply_patch）；应用（apply）走完整
 * 管线（可选收敛管制前置闸门 → 校验 → 审批分级 → 落链 → 活跃态生效）；
 * 回退（revert）仅允许链尾补丁、同须审批。非法输入一律产出自描述违规
 * 清单（结构化拒绝），不在执行期以裸异常击穿。
 */

import { DeclarativeToolSpec } from '../declarative_tools/index.js';
import { GraphDefinitionError } from '../errors.js';
import { build_minimal_harness } from '../harness/index.js';
import { isRecord } from '../json.js';
import { PatchKind, SelfProposal } from '../self_proposal/index.js';
import { _PATCH_KIND_VALUES } from '../self_proposal/self_proposal.js';
import type { PatchKind as PatchKindType } from '../self_proposal/index.js';

import { _AUDIT_SCAN_LIMIT } from './_constants.js';
import { _json, pyRepr } from './_json.js';
import type { SelfToolContext, SelfToolNodeContext } from './_types.js';

/**
 * Python int() 口径数值转换（数值截断 / 整数字符串解析；非法形态抛错，
 * 由调用方转结构化违规）。
 */
function pyInt(value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`int() 无法解析数值: ${value}`);
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const match = /^\s*[+-]?\d+\s*$/.exec(value);
    if (match !== null) return Number.parseInt(match[0], 10);
    throw new TypeError(`int() 无法解析字符串: ${pyRepr(value)}`);
  }
  throw new TypeError(`int() 需要数值/字符串，收到 ${typeof value}`);
}

/** 提案理由归一（str(args.get(k) or '') 口径：falsy → 空串）。 */
function rationaleOf(args: Record<string, unknown>, key: string): string {
  const raw = args[key];
  return raw ? String(raw) : '';
}

/** 从工具入参构造提案（类型/形态非法显式报错）。
 *
 * base_version_hint 由调用方解析：apply_patch 在省略时已取当前版本
 * （与 schema 声明一致）；propose_patch 不校验基准（仅形态校验，
 * 提案只是草案，基准留待 apply 时判定）。
 */
export function _build_proposal(
  ctx: SelfToolNodeContext,
  args: Record<string, unknown>,
  base_version_hint: unknown,
): SelfProposal {
  const rawKind: unknown = args['kind'];
  if (
    typeof rawKind !== 'string'
    || !(_PATCH_KIND_VALUES as readonly unknown[]).includes(rawKind)
  ) {
    throw new GraphDefinitionError(
      `补丁类型非法: ${pyRepr(rawKind)}（仅 ${pyRepr([..._PATCH_KIND_VALUES])}）`,
    );
  }
  const kind = rawKind as PatchKindType;
  const payload = args['payload'];
  if (!isRecord(payload)) {
    throw new GraphDefinitionError('payload 须为对象（dict）');
  }
  let base_version: number;
  if (base_version_hint === null || base_version_hint === undefined) {
    base_version = 1; // propose 侧不校验基准（仅形态校验）
  } else {
    try {
      base_version = pyInt(base_version_hint);
    } catch {
      throw new GraphDefinitionError('base_version 须为整数');
    }
  }
  return new SelfProposal({
    kind,
    payload,
    base_version,
    rationale: rationaleOf(args, 'rationale'),
    meta: { round_id: ctx.round_id ?? null },
  });
}

/** 提案校验：形态非法/未知类型显式报错，合法返回集版本供应用用。 */
export async function _propose(
  _ctx: SelfToolNodeContext,
  context: SelfToolContext,
  args: Record<string, unknown>,
): Promise<string> {
  let proposal: SelfProposal;
  try {
    proposal = _build_proposal(_ctx, args, null);
  } catch (exc) {
    if (exc instanceof GraphDefinitionError) {
      return _json({ ok: false, violations: [exc.message] });
    }
    throw exc;
  }
  const violations = context.self_pipeline.validator.validate(proposal);
  if (violations.length > 0) {
    return _json({ ok: false, violations });
  }
  return _json({
    ok: true,
    kind: proposal.kind,
    violations: [],
    current_version: await context.self_pipeline.chain.current_version(),
    hint: '调用 apply_patch 应用本提案（base_version = 上述 current_version）',
  });
}

/** 领域生成器提案：从高层输入产出最小 harness 定义并校验提案。
 *
 * 仅做「生成 + 校验 + 提案」，不落链（落链走 apply_patch）；回显生成的
 * harness 定义，便于调用方（AI/apply_patch）复用——开局第一回合即可
 * 据此长出领域清单。所有非法输入都产出自描述违规清单（结构化拒绝），
 * 不在执行期以裸异常击穿。
 */
export async function _propose_domain(
  ctx: SelfToolNodeContext,
  context: SelfToolContext,
  args: Record<string, unknown>,
): Promise<string> {
  const violations: string[] = [];
  const name = args['domain_name'];
  if (typeof name !== 'string' || !name.trim()) {
    violations.push('domain_name 须为非空字符串');
  }
  const descriptionRaw = args['description'];
  const description: unknown = descriptionRaw ? descriptionRaw : '';
  if (typeof description !== 'string') {
    violations.push('description 须为字符串');
  }
  const keywords = args['keywords'];
  if (
    !Array.isArray(keywords)
    || keywords.length === 0
    || !keywords.every((k) => typeof k === 'string' && Boolean(k.trim()))
  ) {
    violations.push('keywords 须为非空字符串清单');
  }
  const rawTools = args['tools'];
  const tools: unknown = rawTools === undefined || rawTools === null ? [] : rawTools;
  if (!Array.isArray(tools)) {
    violations.push('tools 须为声明式工具定义清单（数组）');
  }
  const graph = args['graph'];
  if (graph !== null && graph !== undefined && !isRecord(graph)) {
    violations.push('graph 须为图定义 dict');
  }
  if (violations.length > 0) {
    return _json({ ok: false, violations });
  }

  // 全局唯一承诺：与既有 harness 重名即拒绝（既有领域的修改走
  // propose_patch 的 harness 通道，生成器不承担改名覆盖职责）
  const domainName = (name as string).trim();
  if (context.harness_registry !== null && context.harness_registry.get(domainName) !== null) {
    return _json({
      ok: false,
      violations: [
        `领域名已存在（harness 名全局唯一）: ${domainName}；`
        + '修改既有领域请用 propose_patch（kind=harness）',
      ],
    });
  }
  const keywordList = keywords as unknown as string[];
  const toolList = tools as unknown as Record<string, unknown>[];
  const graphData = graph !== undefined && graph !== null ? (graph as Record<string, unknown>) : null;
  // 工具清单逐项做声明式定义形态预校验：非法项转化为结构化违规，
  // 生成器的产出保证可被 apply_patch 直接复用
  for (const tool of toolList) {
    try {
      DeclarativeToolSpec.from_dict(tool);
    } catch (exc) {
      return _json({
        ok: false,
        violations: [`工具定义非法: ${exc instanceof Error ? exc.message : String(exc)}`],
      });
    }
  }
  let definition: ReturnType<typeof build_minimal_harness>;
  try {
    definition = build_minimal_harness(
      domainName,
      description as string,
      keywordList,
      {
        tools: toolList,
        graph: graphData,
      },
    );
  } catch (exc) {
    if (exc instanceof GraphDefinitionError) {
      return _json({ ok: false, violations: [exc.message] });
    }
    throw exc;
  }
  const proposal = new SelfProposal({
    kind: PatchKind.HARNESS,
    payload: { definition: definition.to_dict() },
    base_version: 1,
    rationale: rationaleOf(args, 'rationale'),
    meta: { round_id: ctx.round_id ?? null, generator: 'domain_manifest' },
  });
  const proposalViolations = context.self_pipeline.validator.validate(proposal);
  if (proposalViolations.length > 0) {
    return _json({ ok: false, violations: proposalViolations });
  }
  // 孵化反馈：检索集内相关沉淀（复用优先于从头发明）——生成器把
  // 既有经验显式交给调用方参考，高质量版领域清单 = 孵化反馈的载体。
  // 查询只取描述 + 关键词（领域名是全新词，不可能命中既有条目）
  let relatedKnowledge: Record<string, unknown>[] = [];
  if (context.knowledge_set !== null) {
    const query = [description as string, ...keywordList].join(' ');
    const related = context.knowledge_set.search(query, { limit: 5 });
    relatedKnowledge = related.map((entry) => ({
      id: entry.id,
      title: entry.title,
      kind: entry.kind,
      source: entry.source,
      credibility: entry.credibility,
    }));
  }
  return _json({
    ok: true,
    kind: proposal.kind,
    violations: [],
    current_version: await context.self_pipeline.chain.current_version(),
    definition: definition.to_dict(),
    related_knowledge: relatedKnowledge,
    hint: '生成时参考 related_knowledge（孵化沉淀的相关经验），复用优先于'
      + '从头发明；调用 apply_patch（kind=harness, payload.definition=上述 definition）'
      + '应用本提案（base_version = 上述 current_version）',
  });
}

/** 应用提案：完整管线（校验 → 审批分级 → 落链 → 活跃态生效）。
 *
 * 前置收敛管制（可选钩子）：目标处于冷却/冻结期（同目标反复折腾 =
 * 演化不收敛）时显式拒绝并说明恢复时间——AI 据此换策略，而非反复
 * 撞闸。钩子未装配（convergence=null）时不做前置判定。
 */
export async function _apply(
  ctx: SelfToolNodeContext,
  context: SelfToolContext,
  args: Record<string, unknown>,
): Promise<string> {
  let proposal: SelfProposal;
  try {
    // 缺省基准 = 当前版本（与工具 schema 声明一致：省略 base_version
    // 即按最新集状态提案，避免非空链上被误判并发冲突）
    const rawBase = args['base_version'];
    const baseVersion =
      rawBase === undefined || rawBase === null
        ? await context.self_pipeline.chain.current_version()
        : rawBase;
    proposal = _build_proposal(ctx, args, baseVersion);
  } catch (exc) {
    if (exc instanceof GraphDefinitionError) {
      return _json({ ok: false, status: 'invalid', reason: exc.message });
    }
    throw exc;
  }
  if (context.convergence !== null) {
    const records = await context.self_pipeline.audit_log({ limit: _AUDIT_SCAN_LIMIT });
    const assessment = await context.convergence.assess(
      records,
      proposal.kind,
      proposal.payload,
    );
    if (!assessment.allowed) {
      return _json({
        ok: false,
        status: assessment.state,
        target: assessment.target,
        reason: assessment.reason,
        hint: '冷却/冻结是演化收敛管制（用户行为证据触发）：请换方向'
          + '或等恢复期后再试',
      });
    }
  }
  const outcome = await context.self_pipeline.apply(ctx, proposal);
  const response: Record<string, unknown> = {
    ok: outcome.applied,
    status: outcome.status,
    decision: outcome.decision,
    patch_id: outcome.patch_id,
    reason: outcome.reason,
  };
  if (outcome.applied && proposal.kind === PatchKind.TOOL) {
    // 工具补丁落地提示：新工具已进入工具表，经 request_tool 绑定后
    // 从下一回合起注入（当前回合 tools 参数在回合开始已固化，绑定
    // 不改变本回合已生成的 tool_call 面——同回合自写→自调用不在
    // 支持范围）
    const toolName = proposal.payload['name'];
    response['hint'] = toolName
      ? `工具 ${pyRepr(toolName)} 已注册；调用 request_tool（name=${pyRepr(toolName)}）`
        + '绑定到当前会话后，下一回合即可调用'
      : '工具已注册；调用 request_tool 绑定后下一回合即可调用';
  }
  return _json(response);
}

/** 回退链尾补丁（审批确认后落地，审计保留历史）。 */
export async function _revert(
  ctx: SelfToolNodeContext,
  context: SelfToolContext,
  args: Record<string, unknown>,
): Promise<string> {
  const rawPatchId = args['patch_id'];
  if (rawPatchId === undefined || rawPatchId === null) {
    return _json({ ok: false, status: 'invalid', reason: 'patch_id 须为整数' });
  }
  let patchId: number;
  try {
    patchId = pyInt(rawPatchId);
  } catch {
    return _json({ ok: false, status: 'invalid', reason: 'patch_id 须为整数' });
  }
  try {
    const outcome = await context.self_pipeline.revert(ctx, patchId, {
      reason: rationaleOf(args, 'reason'),
    });
    return _json({
      ok: outcome.status === 'reverted',
      status: outcome.status,
      decision: outcome.decision,
      patch_id: patchId,
      reason: outcome.reason,
    });
  } catch (exc) {
    if (exc instanceof GraphDefinitionError) {
      return _json({ ok: false, status: 'rejected', reason: exc.message });
    }
    throw exc;
  }
}
