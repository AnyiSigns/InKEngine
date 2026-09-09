/**
 * 河流水系实验 v2：自治导航（加工即判定 + 跳海/跳路程）。
 *
 * 攻克的靶心：
 *   - 入口 = main 主 agent（能力网上的默认起点）；模型每步决定
 *     "继续加工（调能力节点）" 还是 "收（ESTUARY 跳海）"，或跨步跳转。
 *   - 节点结构化输出带 __next：去哪个能力节点 / ESTUARY（唯一海口）。
 *     加工即判定：路由决策并入节点产出，零额外判定调用。
 *   - 成本靠"自治收"而非护栏；护栏仅作最后防线（步数上限）。
 *
 * 用法：
 *   npx tsx live/experiment_river/run_river_v2.ts "<任务文本>"
 */

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const CONFIG_PATH = path.join(ROOT, '.dev-data/kilo-cli/config.json');

interface AgentModelConfig {
  protocol: string;
  base_url: string;
  model_id: string;
}

function loadModelConfig(): AgentModelConfig {
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as {
    model_config: { agent_config: AgentModelConfig };
  };
  return raw.model_config.agent_config;
}

interface ChatResult {
  content: string;
  reasoning: string | null;
  usage: { prompt: number; completion: number };
}

async function chat(
  model: AgentModelConfig,
  system: string,
  user: string,
  maxTokens = 1600,
): Promise<ChatResult> {
  const url = model.base_url.replace(/\/$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: model.model_id,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
      reasoning_effort: 'low',
    }),
  });
  if (!res.ok) {
    throw new Error(`LLM HTTP ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as {
    choices?: Array<{ message: { content?: string | null; reasoning?: string | null } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = body.choices?.[0]?.message;
  return {
    content: choice?.content ?? '',
    reasoning: choice?.reasoning ?? null,
    usage: { prompt: body.usage?.prompt_tokens ?? 0, completion: body.usage?.completion_tokens ?? 0 },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 能力网：main / planner / reviewer 三个能力节点 + 唯一海口 ESTUARY
// ────────────────────────────────────────────────────────────────────────────

const MODEL = loadModelConfig();

/** 每步的上下文：任务 + 已汇聚的中间产物。 */
interface FlowState {
  task: string;
  plan: string | null;
  review: string | null;
  next: 'main' | 'planner' | 'reviewer' | 'ESTUARY';
}

/** 调用结果 = { 该节点本职产物字段, next(自治跳转/跳海) } */
interface StepOut {
  plan?: string;
  review?: string;
  final?: string;
  next: 'main' | 'planner' | 'reviewer' | 'ESTUARY';
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]) as Record<string, unknown>;
    return obj;
  } catch {
    return null;
  }
}

function readField(obj: Record<string, unknown> | null, key: string): string | null {
  const v = obj?.[key];
  if (typeof v === 'string') return v;
  return null;
}

function stepSummary(out: StepOut): string {
  const parts: string[] = [];
  if (out.plan !== undefined) parts.push(`plan(${out.plan.length}字符)`);
  if (out.review !== undefined) parts.push(`review(${out.review.length}字符)`);
  if (out.final !== undefined) parts.push(`final(${out.final.length}字符)`);
  return `next=${out.next} ${parts.join(' ')}`.trim();
}

/** main：主 agent。无 plan 时判定"直答 or 需规划"；有 plan 时必须合成完整最终答复。 */
async function stepMain(st: FlowState): Promise<StepOut> {
  const hasPlan = st.plan !== null;
  const sys = hasPlan
    ? '你是主执行 agent，现在已有分步计划。你的职责是把它合成为给用户的完整最终答复。' +
      '输出 JSON：{"answer":"...","next":"ESTUARY"}。' +
      'answer 必须是可直接交付的正文：按计划给用户完整、有用、展开的最终答复（不要提"计划"“JSON”等内部词）。' +
      '若任务明确要求"指出风险/最容易失败/评审意见"且你尚未给出风险分析，可把 next 填 "reviewer" 先取评审；否则 next 填 ESTUARY。' +
      '只输出 JSON。'
    : '你是主执行 agent。输出 JSON 对象：' +
      '{"answer":"...","next":"ESTUARY|planner"}。' +
      '判断：能直接回答的（寒暄/简单问答/有把握），answer 给最终答复，next 填 ESTUARY；' +
      '任务需要分步规划/多步拆解/结构化产出时，next 填 planner（answer 可为空字符串）。' +
      '只输出 JSON，不要输出其它文字。';
  const ctx = [
    `任务：${st.task}`,
    st.plan !== null ? `\n分步计划：\n${st.plan}` : '',
    st.review !== null ? `\n评审意见：\n${st.review}` : '',
  ].join('');
  const r = await chat(MODEL, sys, ctx, 2600);
  const obj = extractJsonObject(r.content);
  const nextRaw = String(obj?.next ?? '').trim().toUpperCase();
  return {
    final: readField(obj, 'answer') ?? undefined,
    next: nextRaw === 'PLANNER' ? 'planner' : nextRaw === 'REVIEWER' ? 'reviewer' : 'ESTUARY',
  };
}

/** planner：能力节点。产出 JSON 计划，不面向用户；干完可跳 main 或 ESTUARY。 */
async function stepPlanner(st: FlowState): Promise<StepOut> {
  const sys =
    '你是任务规划器（能力节点，不直接回答用户）。把任务分解为 2-5 个有序步骤。' +
    '输出 JSON 对象：{"plan":{"steps":[{"step":1,"title":"...","detail":"..."}]},"next":"main"}。' +
    '"next" 只能填 "main"（把计划交回主 agent）。只输出 JSON。';
  const r = await chat(MODEL, sys, `任务：${st.task}`, 1800);
  const obj = extractJsonObject(r.content);
  const planRaw = readField(obj, 'plan');
  return {
    plan: planRaw ?? r.content,
    next: 'main',
  };
}

/** reviewer：能力节点。评审计划；干完回 main。 */
async function stepReviewer(st: FlowState): Promise<StepOut> {
  const sys =
    '你是计划评审器（能力节点，不直接回答用户）。评审给定计划，指出最可能失败的一步与修正建议。' +
    '输出 JSON 对象：{"review":{"risk":{"step":1,"reason":"...","fix":"..."}},"next":"main"}。' +
    '"next" 只能填 "main"。只输出 JSON。';
  const r = await chat(MODEL, sys, `待评审计划：\n${st.plan ?? ''}`, 1400);
  const obj = extractJsonObject(r.content);
  const reviewRaw = readField(obj, 'review');
  return {
    review: reviewRaw ?? r.content,
    next: 'main',
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 主循环：从 main 出发自治导航；任何节点可跳海；护栏仅步数上限
// ────────────────────────────────────────────────────────────────────────────

interface RunOut {
  trace: Array<{ step: string; summary: string; prompt: number; completion: number }>;
  final: string;
  tokens: { prompt: number; completion: number };
  state: FlowState;
}

async function runRiver(task: string): Promise<RunOut> {
  const state: FlowState = { task, plan: null, review: null, next: 'main' };
  const trace: RunOut['trace'] = [];
  const tokens = { prompt: 0, completion: 0 };

  let hops = 0;
  const MAX_HOPS = 6;
  while (hops < MAX_HOPS) {
    hops += 1;
    let out: StepOut;
    if (state.next === 'planner') {
      out = await stepPlanner(state);
      state.plan = out.plan ?? null;
    } else if (state.next === 'reviewer') {
      out = await stepReviewer(state);
      state.review = out.review ?? null;
    } else {
      out = await stepMain(state);
      state.final = out.final ?? state.final;
    }
    trace.push({
      step: state.next === 'planner' ? 'planner' : state.next === 'reviewer' ? 'reviewer' : 'main',
      summary: stepSummary(out),
      prompt: 0,
      completion: 0,
    });
    // 简化：chat 不向外暴露 usage，此处用记录粗粒度；改为累计估算在下一步迭代补全。
    if (out.next === 'ESTUARY') break;
    state.next = out.next === 'planner' || out.next === 'reviewer' ? out.next : 'main';
  }
  if (state.final === null || state.final === '') {
    // 兜底：没给出 final 时以 main 直接答一次（跳海兜底，护栏语义）
    const r = await chat(
      MODEL,
      '你是主执行 agent，直接给用户最终答复，只输出正文。',
      `任务：${state.task}${state.plan !== null ? `\n\n可参考计划：${state.plan}` : ''}`,
      2000,
    );
    tokens.prompt += r.usage.prompt;
    tokens.completion += r.usage.completion;
    state.final = r.content;
    trace.push({ step: 'main-fallback', summary: 'final fallback', prompt: r.usage.prompt, completion: r.usage.completion });
  }
  return { trace, final: state.final ?? '', tokens, state };
}

async function main(): Promise<void> {
  const task = process.argv[2]?.trim();
  if (!task) {
    process.stderr.write('用法：npx tsx live/experiment_river/run_river_v2.ts "<任务文本>"\n');
    process.exit(2);
  }
  const t0 = Date.now();
  const out = await runRiver(task);
  const lines: string[] = [];
  lines.push('# 河流水系实验 v2：自治导航报告');
  lines.push('');
  lines.push(`- 任务：${task}`);
  lines.push(`- 耗时：${Date.now() - t0}ms`);
  lines.push('');
  lines.push('## 轨迹');
  for (const t of out.trace) lines.push(`- ${t.step}：${t.summary}`);
  lines.push('');
  if (out.state.plan !== null) {
    lines.push('## 中间产物：plan');
    lines.push('```');
    lines.push(out.state.plan);
    lines.push('```');
  }
  if (out.state.review !== null) {
    lines.push('## 中间产物：review');
    lines.push('```');
    lines.push(out.state.review);
    lines.push('```');
  }
  lines.push('## 最终答复（唯一海口）');
  lines.push('');
  lines.push(out.final);
  const dir = path.join(__dirname, 'report');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `river_v2_${Date.now()}.md`);
  writeFileSync(file, lines.join('\n'), 'utf8');
  process.stdout.write(lines.join('\n') + '\n');
  process.stdout.write(`\n[实验] 报告：${file}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`实验失败：${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
