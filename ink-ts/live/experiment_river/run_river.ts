/**
 * 河流水系实验：受限拓扑 + 流量分派 + 唯一海口 的执行形态最小验证。
 *
 * 实验目标（攻克的靶心）：
 *  1) 一条会话输入进入水系后，按"分叉闸（局部判定）"分流，而不是一次性
 *     组装一条确定性链；简单输入走干流短道，复杂输入走支流，最终汇入
 *     同一个海口（唯一收敛出口）。
 *  2) 支流节点各司其职：planner 只产计划、reviewer 只评审计划、main 消费
 *     plan+review 出最终答复——产物经"载荷"逐段传递，不互相污染、不各自
 *     直接入海。
 *  3) 质量门作为"返工回环"入口：计划不合法 → 泵回 planner 重做（受控回流），
 *     合法才放行到 reviewer。
 *
 * 形态说明：
 *  - 节点 = 河道处理段（内核固定 + 载荷进出）；边 = 河道（含汇流/回环）；
 *  - 海口（出口）唯一：面向用户的最终答复只从海口产出。
 *  - 全部走真实 LLM（kilo-cli gateway 免费模型配置），openai_compatible。
 *
 * 用法：
 *   npx tsx live/experiment_river/run_river.ts "你好"
 *   npx tsx live/experiment_river/run_river.ts "请给一周入门 Python 的分步计划"
 */

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const CONFIG_PATH = path.join(ROOT, '.dev-data/kilo-cli/config.json');

// ────────────────────────────────────────────────────────────────────────────
// 0. 模型配置（kilo-cli 免费模型装配）
// ────────────────────────────────────────────────────────────────────────────

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
  usage: { prompt: number; completion: number; total: number };
}

async function chat(
  model: AgentModelConfig,
  system: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  maxTokens = 900,
): Promise<ChatResult> {
  const url = model.base_url.replace(/\/$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: model.model_id,
      messages: [{ role: 'system', content: system }, ...messages],
      max_tokens: maxTokens,
      reasoning_effort: 'low',
    }),
  });
  if (!res.ok) {
    throw new Error(`LLM HTTP ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as {
    choices?: Array<{ message: { content?: string | null; reasoning?: string | null } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const choice = body.choices?.[0]?.message;
  return {
    content: choice?.content ?? '',
    reasoning: choice?.reasoning ?? null,
    usage: {
      prompt: body.usage?.prompt_tokens ?? 0,
      completion: body.usage?.completion_tokens ?? 0,
      total: body.usage?.total_tokens ?? 0,
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 1. 水系：节点(河道段) / 边(河道) / 分叉闸 / 质量门 / 海口
// ────────────────────────────────────────────────────────────────────────────

/** 流过河道段的"载荷"：上游汇入的产物 + 会话任务 + 分派上下文。 */
interface Payload {
  task: string;
  plan: string | null;
  review: string | null;
  reply: string | null;
  /** 最近一次质量门判定（返工回环用）。 */
  gate: string | null;
}

/** 分叉判定结果：流向哪个河道段。 */
type ForkDecision = { to: 'estuary_direct' | 'planner' };

/** 河道处理段 = 内核固定的一跳：入载荷 → LLM/判定 → 出新载荷。 */
interface RiverNode {
  kind: 'fork' | 'llm' | 'gate' | 'estuary';
  role: string;
  system: string;
}

/** 单次执行记账（成本/路径/事件）。 */
interface RunRecord {
  route: string[];
  llmCalls: number;
  tokens: { prompt: number; completion: number };
}

// ────────────────────────────────────────────────────────────────────────────
// 2. 节点实现（内核：入载荷 → 本职处理 → 出载荷；谁都能到但只有海口入海）
// ────────────────────────────────────────────────────────────────────────────

const MODEL = loadModelConfig();

/** 分叉闸：读任务文本，做局部轻判定（不入库/无记忆）。 */
async function forkByTask(payload: Payload, rec: RunRecord): Promise<ForkDecision> {
  const sys =
    '你是分叉判定。判断下面的用户输入属于哪一类，只输出一个词：\n' +
    '- 若只需"直接回答"（寒暄/闲聊/单句问答/明确无需帮助）：direct\n' +
    '- 若需要"先规划再执行/多步拆解/结构化计划产物"：plan\n' +
    '不要输出任何其它文字、不要解释。';
  const r = await chat(MODEL, sys, [{ role: 'user', content: payload.task }], 1000);
  rec.llmCalls += 1;
  rec.tokens.prompt += r.usage.prompt;
  rec.tokens.completion += r.usage.completion;
  const content = r.content.trim().toLowerCase();
  const word = content.split(/\s+/).find((w) => w === 'direct' || w === 'plan');
  return word === 'plan' ? { to: 'planner' } : { to: 'estuary_direct' };
}

/** planner：只产"计划"，不进对话、不面向用户。输出要求可被质量门解析的结构。 */
async function runPlanner(payload: Payload, rec: RunRecord): Promise<string> {
  const sys =
    '你是任务规划器，产出结构化计划。你只做规划这一步，不要回答用户、不要下结论。' +
    '把任务分解为 2-5 个有序步骤，每步一句话。' +
    '严格输出 JSON：{"steps":[{"step":1,"title":"...","detail":"..."}]}，不要输出 JSON 以外的任何文字。';
  const r = await chat(MODEL, sys, [{ role: 'user', content: payload.task }], 1800);
  rec.llmCalls += 1;
  rec.tokens.prompt += r.usage.prompt;
  rec.tokens.completion += r.usage.completion;
  return r.content;
}

/** 质量门：计划是否是可解析的合法 JSON 计划。不合法 → 返工回环（泵回 planner）。 */
function gatePlan(payload: Payload, _rec: RunRecord): 'pass' | 'rework' {
  try {
    const obj = JSON.parse(extractJson(payload.plan ?? ''));
    const steps = obj?.['steps'];
    if (!Array.isArray(steps) || steps.length < 1) return 'rework';
    for (const s of steps) {
      if (typeof s?.['title'] !== 'string' || s?.['title'] === '') return 'rework';
    }
    return 'pass';
  } catch {
    return 'rework';
  }
}

/** reviewer：只评审 plan，产出评审意见（JSON），不回答用户。 */
async function runReviewer(payload: Payload, rec: RunRecord): Promise<string> {
  const sys =
    '你是计划评审器。只评审给定的计划，不回答用户、不执行计划。' +
    '指出最可能失败的一步与原因，并给一句修正建议。' +
    '严格输出 JSON：{"risk":{"step":1,"reason":"...","fix":"..."}}，不要输出 JSON 以外的文字。';
  const r = await chat(
    MODEL,
    sys,
    [{ role: 'user', content: `待评审计划：\n${payload.plan ?? ''}` }],
    1400,
  );
  rec.llmCalls += 1;
  rec.tokens.prompt += r.usage.prompt;
  rec.tokens.completion += r.usage.completion;
  return r.content;
}

/** main：消费 plan + review + 任务，产出唯一面向用户的最终答复。 */
async function runMain(payload: Payload, rec: RunRecord): Promise<string> {
  const sys =
    '你是最终答复者。基于给定任务、计划与评审，给用户一个完整、直接、有用的最终答复。' +
    '不要引用 JSON，不要提"计划""评审"这些内部过程，只说结果。';
  const r = await chat(
    MODEL,
    sys,
    [
      {
        role: 'user',
        content:
          `任务：${payload.task}\n\n计划：\n${payload.plan ?? ''}\n\n评审与修正：\n${payload.review ?? ''}`,
      },
    ],
    2600,
  );
  rec.llmCalls += 1;
  rec.tokens.prompt += r.usage.prompt;
  rec.tokens.completion += r.usage.completion;
  return r.content;
}

/** 海口：唯一入海口（把载荷落成最终答复）。这里即 main 产物直接出。 */
function estuary(payload: Payload): string {
  return payload.reply ?? '';
}

function extractJson(text: string): string {
  const m = text.match(/\{[\s\S]*\}/);
  return m ? m[0] : text;
}

// ────────────────────────────────────────────────────────────────────────────
// 3. 执行：让"水"从源头流到海口（分叉 → 支流 → 汇流 → 入海）
// ────────────────────────────────────────────────────────────────────────────

async function runRiver(task: string): Promise<{ reply: string; rec: RunRecord; payload: Payload }> {
  const rec: RunRecord = { route: [], llmCalls: 0, tokens: { prompt: 0, completion: 0 } };
  const payload: Payload = { task, plan: null, review: null, reply: null, gate: null };

  rec.route.push('source');
  const fork = await forkByTask(payload, rec);
  rec.route.push(`fork->${fork.to}`);

  if (fork.to === 'estuary_direct') {
    // 干流短道：直接面向用户答复。
    payload.reply = await runMain(payload, rec);
    rec.route.push('estuary');
    return { reply: estuary(payload), rec, payload };
  }

  // 支流：planner → (质量门) → reviewer → main → 汇入海口
  payload.plan = await runPlanner(payload, rec);
  rec.route.push('planner');

  let reworks = 0;
  for (;;) {
    if (gatePlan(payload, rec) === 'pass') {
      rec.route.push('gate-pass');
      break;
    }
    // 返工回环（泵站）：质量门不过 → 带着门原因泵回 planner
    reworks += 1;
    if (reworks > 2) {
      rec.route.push('rework-exhausted');
      payload.plan = '{}';
      break;
    }
    rec.route.push('gate-rework');
    payload.gate = 'plan-not-valid-json';
    const sys =
      '你是任务规划器。上一次输出的计划不合法（不是可解析的 JSON 步骤数组）。' +
      '请重新严格输出 JSON：{"steps":[{"step":1,"title":"...","detail":"..."}]}，不要输出其它文字。';
    const r = await chat(MODEL, sys, [{ role: 'user', content: payload.task }], 1800);
    rec.llmCalls += 1;
    rec.tokens.prompt += r.usage.prompt;
    rec.tokens.completion += r.usage.completion;
    payload.plan = r.content;
  }

  payload.review = await runReviewer(payload, rec);
  rec.route.push('reviewer');
  payload.reply = await runMain(payload, rec);
  rec.route.push('main');
  rec.route.push('estuary');

  return { reply: estuary(payload), rec, payload };
}

// ────────────────────────────────────────────────────────────────────────────
// 4. 报告落盘 + 入口
// ────────────────────────────────────────────────────────────────────────────

function buildReport(task: string, out: Awaited<ReturnType<typeof runRiver>>, elapseMs: number): string {
  const lines: string[] = [];
  lines.push('# 河流水系实验报告');
  lines.push('');
  lines.push(`- 任务：${task}`);
  lines.push(`- 路径：${out.rec.route.join(' → ')}`);
  lines.push(`- LLM 调用：${out.rec.llmCalls}；tokens：prompt=${out.rec.tokens.prompt} / completion=${out.rec.tokens.completion}`);
  lines.push(`- 耗时：${elapseMs}ms`);
  lines.push('');
  if (out.payload.plan !== null) {
    lines.push('## plan（支流中间产物）');
    lines.push('```json');
    lines.push(out.payload.plan);
    lines.push('```');
  }
  if (out.payload.review !== null) {
    lines.push('## review（支流中间产物）');
    lines.push('```json');
    lines.push(out.payload.review);
    lines.push('```');
  }
  lines.push('## 最终答复（唯一海口）');
  lines.push('');
  lines.push(out.reply);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const task = process.argv[2]?.trim();
  if (!task) {
    process.stderr.write('用法：npx tsx live/experiment_river/run_river.ts "<任务文本>"\n');
    process.exit(2);
  }
  const t0 = Date.now();
  const out = await runRiver(task);
  const elapseMs = Date.now() - t0;
  const report = buildReport(task, out, elapseMs);
  const dir = path.join(__dirname, 'report');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `river_${Date.now()}.md`);
  writeFileSync(file, report, 'utf8');
  process.stdout.write(report + '\n');
  process.stdout.write(`\n[实验] 报告：${file}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`实验失败：${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
