/**
 * 水流 × 作用域 × 通道 —— 最小雏形（MVP）
 *
 * 对应执行稿 `agent_execution_design.md`：
 *  - 作用域目录：main / planner / worker / critic（候选资产，按需委托，无常驻链）；
 *  - 水流：一次任务 = 一股水，携带 task + 产物 + 作用域 + 轨迹；
 *  - 通道：ESTUARY(收敛) / delegate(委托子水流) / fan-out(并行 workers) /
 *    fan-in(汇流) / critic(按需审查闸)；
 *  - 自治：main 加工即判定（产物 __next）；
 *  - 质量闸：plan 结构校验（返工限次）；critic 审查（fix → main 修订）；
 *  - 组织档案雏形：每次执行追加 report/organization_archive.jsonl（轨迹/成本/结果）。
 *
 * 初始形态：main → ESTUARY 直河为默认；planner/worker/critic 不预置于路径，
 * 由 main 按任务判定是否委托。
 *
 * 用法：
 *   npx tsx live/experiment_river/run_mvp.ts "简单任务或寒暄"
 *   npx tsx live/experiment_river/run_mvp.ts --complex "需要规划+执行的复杂任务"
 */

import { mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const CONFIG_PATH = path.join(ROOT, '.dev-data/kilo-cli/config.json');
const ARCHIVE_PATH = path.join(__dirname, 'report', 'organization_archive.jsonl');

// ────────────────────────────────────────────────────────────────────────────
// 0. 模型与调用基座
// ────────────────────────────────────────────────────────────────────────────

interface ModelCfg {
  protocol: string;
  base_url: string;
  model_id: string;
}

function loadModel(): ModelCfg {
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as {
    model_config: { agent_config: ModelCfg };
  };
  return raw.model_config.agent_config;
}

const MODEL = loadModel();

async function chat(
  system: string,
  user: string,
  maxTokens = 1800,
): Promise<{ content: string; reasoning: string | null; usage: { prompt: number; completion: number } }> {
  const url = MODEL.base_url.replace(/\/$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL.model_id,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
      reasoning_effort: 'low',
    }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as {
    choices?: Array<{ message: { content?: string | null; reasoning?: string | null } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const m = body.choices?.[0]?.message;
  return {
    content: m?.content ?? '',
    reasoning: m?.reasoning ?? null,
    usage: { prompt: body.usage?.prompt_tokens ?? 0, completion: body.usage?.completion_tokens ?? 0 },
  };
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 1. 作用域目录（身份定义；初始仅 main 常驻，其余为候选）
// ────────────────────────────────────────────────────────────────────────────

/** 一步执行记录（组织档案用）。 */
interface TraceStep {
  scope: string;
  note: string;
  ms: number;
  prompt: number;
  completion: number;
}

/** 水流状态。 */
interface Flow {
  task: string;
  final: string | null;
  trace: TraceStep[];
  usage: { prompt: number; completion: number; calls: number };
  events: string[];
}

function makeFlow(task: string): Flow {
  return { task, final: null, trace: [], usage: { prompt: 0, completion: 0, calls: 0 }, events: [] };
}

async function runScope(
  flow: Flow,
  scope: string,
  system: string,
  user: string,
  maxTokens = 1800,
): Promise<{ content: string; obj: Record<string, unknown> | null }> {
  const t0 = Date.now();
  const r = await chat(system, user, maxTokens);
  flow.usage.prompt += r.usage.prompt;
  flow.usage.completion += r.usage.completion;
  flow.usage.calls += 1;
  flow.trace.push({
    scope,
    note: `tokens=${r.usage.prompt}+${r.usage.completion}`,
    ms: Date.now() - t0,
    prompt: r.usage.prompt,
    completion: r.usage.completion,
  });
  return { content: r.content, obj: extractJsonObject(r.content) };
}

const SCOPES = {
  mainFirst: {
    system:
      '你是主执行 agent（main）。输出 JSON：{"answer":"...","next":"ESTUARY|planner"}。' +
      '能直接回答（寒暄/简单/有把握）→ answer 给最终答复，next=ESTUARY；' +
      '任务需要拆解成多步执行/需要专门能力 → next=planner（answer 可为空）。只输出 JSON。',
  },
  planner: {
    system:
      '你是规划师作用域（被委托，不直接回答用户）。把任务拆成 2-3 个可独立执行的子任务。' +
      '输出 JSON：{"plan":{"steps":[{"title":"...","instruction":"给执行者的具体指令"}]},"next":"main"}。' +
      '只输出 JSON。',
  },
  worker: {
    system:
      '你是执行者作用域（worker，被分派单个子任务）。按指令完成任务，输出该子任务的结果正文。' +
      '输出 JSON：{"result":"...","next":"ESTUARY"}。只输出 JSON。',
  },
  critic: {
    system:
      '你是审查者作用域（按需审查，不常驻）。审查草稿答复是否完整回答了用户任务、是否遗漏计划要点。' +
      '输出 JSON：{"verdict":"ok|fix","review":"审查意见（如 fix 给出具体修改建议）","next":"main"}。' +
      '只输出 JSON。',
  },
  mainCompose: {
    system:
      '你是主执行 agent（main），已有子任务执行结果，需合成最终答复。' +
      '输出 JSON：{"answer":"面向用户的完整最终答复","next":"ESTUARY|critic"}。' +
      '若产物质量存疑或任务关键，可 next=critic 先审查；否则 ESTUARY。只输出 JSON。',
  },
  mainRevise: {
    system:
      '你是主执行 agent（main），审查者给了修改意见。修订后输出最终答复。' +
      '输出 JSON：{"answer":"修订后的完整最终答复","next":"ESTUARY"}。只输出 JSON。',
  },
} as const;

// ────────────────────────────────────────────────────────────────────────────
// 2. 执行通道：委托 planner（子水流）→ 计划校验 → fan-out workers → fan-in
//    → main 合成 → critic 审查闸（按需）→ 修订 → ESTUARY
// ────────────────────────────────────────────────────────────────────────────

function validatePlan(planText: string): { steps: Array<{ title: string; instruction: string }> } | null {
  const obj = extractJsonObject(planText);
  const steps = obj?.['plan']?.['steps'] as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(steps) || steps.length < 1) return null;
  const clean: Array<{ title: string; instruction: string }> = [];
  for (const s of steps) {
    const title = typeof s?.['title'] === 'string' ? s.title : '';
    const instruction = typeof s?.['instruction'] === 'string' ? s.instruction : '';
    if (title === '' || instruction === '') return null;
    clean.push({ title, instruction });
  }
  return { steps: clean };
}

/** 复杂路径：delegate planner → fan-out workers → fan-in → 合成 → 审查 → 修订 → 收。 */
async function runComplexPath(flow: Flow, reviewRequired: boolean): Promise<string> {
  // ① delegate 委托规划师（子水流）
  const planRes = await runScope(
    flow,
    'planner',
    SCOPES.planner.system,
    `任务：${flow.task}\n请输出 2-3 个可独立并行执行的子任务计划。`,
  );
  let plan = validatePlan(planRes.content);
  if (plan === null && planRes.obj !== null) {
    // 宽容解析：直接读 obj.plan.steps（已内嵌 JSON）
    const raw = planRes.content;
    plan = validatePlan(raw);
  }
  if (plan === null) {
    // 质量闸：返工一次（泵回 planner）
    const retry = await runScope(
      flow,
      'planner',
      SCOPES.planner.system + '上一次输出不是合法 JSON 计划（需 {"plan":{"steps":[...]}}）。请重新输出。',
      `任务：${flow.task}`,
    );
    plan = validatePlan(retry.content);
  }
  flow.events.push(`quality-gate: plan ${plan !== null ? 'ok' : 'rework-failed'}`);
  if (plan === null) {
    // 降级：不拆解，main 直接合成
    const direct = await runScope(
      flow,
      'main',
      SCOPES.mainCompose.system,
      `任务：${flow.task}\n（计划生成失败，请直接完整回答。）`,
    );
    flow.events.push('degraded: no-plan');
    return typeof direct.obj?.['answer'] === 'string' ? (direct.obj['answer'] as string) : direct.content;
  }

  // ② fan-out：并行分派 workers（同一 worker 作用域多实例）
  flow.events.push(`fan-out: ${plan.steps.length} workers`);
  const workerJobs = plan.steps.map(async (step, i) => {
    const r = await runScope(
      flow,
      'worker',
      SCOPES.worker.system,
      `子任务 ${i + 1}/${plan.steps.length}：${step.title}\n指令：${step.instruction}`,
      1200,
    );
    const result = typeof r.obj?.['result'] === 'string' ? (r.obj['result'] as string) : r.content;
    return `【子任务 ${i + 1}：${step.title}】\n${result}`;
  });
  const results = await Promise.all(workerJobs);
  // fan-in 汇流
  flow.events.push(`fan-in: ${results.length} results`);
  const joined = results.join('\n\n');

  // ③ main 合成
  const compose = await runScope(
    flow,
    'main',
    SCOPES.mainCompose.system,
    `用户任务：${flow.task}\n\n分步计划：${plan.steps.map((s, i) => `${i + 1}. ${s.title}`).join('\n')}\n\n子任务执行结果：\n${joined}`,
  );
  const draft = typeof compose.obj?.['answer'] === 'string' ? (compose.obj['answer'] as string) : compose.content;

  // ④ 审查闸（按需；复杂任务默认过一次 critic）
  if (reviewRequired) {
    flow.events.push('review-gate: critic');
    const crit = await runScope(
      flow,
      'critic',
      SCOPES.critic.system,
      `用户任务：${flow.task}\n\n草稿答复：\n${draft}\n\n子任务结果：\n${joined.slice(0, 4000)}`,
      900,
    );
    const verdict = crit.obj?.['verdict'];
    if (verdict === 'fix') {
      flow.events.push('review-fix: main-revise');
      const revise = await runScope(
        flow,
        'main',
        SCOPES.mainRevise.system,
        `用户任务：${flow.task}\n\n原草稿：\n${draft}\n\n审查意见：\n${typeof crit.obj?.['review'] === 'string' ? (crit.obj['review'] as string) : crit.content}`,
        1600,
      );
      const final = typeof revise.obj?.['answer'] === 'string' ? (revise.obj['answer'] as string) : revise.content;
      flow.final = final;
      return final;
    }
    flow.events.push('review-ok');
  }
  flow.final = draft;
  return draft;
}

/** 主入口：水流自治。简单任务 main 直收；复杂任务 main 判定后走委托支流。 */
async function runTask(task: string, complex: boolean): Promise<Flow> {
  const flow = makeFlow(task);

  if (complex) {
    // 演示复杂路径：先让 main 判定（保留自治语义），再走 planner 支流
    const judge = await runScope(
      flow,
      'main',
      SCOPES.mainFirst.system,
      `任务：${task}`,
      1200,
    );
    const next = String(judge.obj?.['next'] ?? '').toUpperCase();
    if (next === 'PLANNER') {
      flow.events.push('delegate: planner (main 判定)');
    } else {
      flow.events.push('main 判定：直收（未触发 planner）');
    }
    flow.final = await runComplexPath(flow, true);
    return flow;
  }

  // 简单路径：main 一步直收（跳海）
  const r = await runScope(flow, 'main', SCOPES.mainFirst.system, `任务：${task}`, 2200);
  const next = String(r.obj?.['next'] ?? '').toUpperCase();
  const answer = typeof r.obj?.['answer'] === 'string' ? (r.obj['answer'] as string) : r.content;
  flow.final = next === 'ESTUARY' ? answer : answer; // 简单任务一律收；由 main 自己决定质量
  flow.events.push('estuary: direct');
  return flow;
}

// ────────────────────────────────────────────────────────────────────────────
// 3. 报告 + 组织档案（轨迹/成本/结果追加 JSONL）
// ────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const complex = args.includes('--complex');
  const task = args.filter((a) => a !== '--complex').join(' ').trim();
  if (!task) {
    process.stderr.write('用法：npx tsx live/experiment_river/run_mvp.ts [--complex] "<任务>"\n');
    process.exit(2);
  }

  const t0 = Date.now();
  const flow = await runTask(task, complex);
  const elapseMs = Date.now() - t0;

  const lines: string[] = [];
  lines.push('# 水流 × 作用域 × 通道：最小雏形报告');
  lines.push('');
  lines.push(`- 任务：${task}`);
  lines.push(`- 路径（scope 序列）：${flow.trace.map((t) => t.scope).join(' → ') || '(空)'}`);
  lines.push(`- 事件：${flow.events.join('；')}`);
  lines.push(`- LLM 调用：${flow.usage.calls}；tokens：${flow.usage.prompt}+${flow.usage.completion}`);
  lines.push(`- 耗时：${elapseMs}ms`);
  lines.push('');
  lines.push('## 轨迹明细');
  for (const t of flow.trace) {
    lines.push(`- ${t.scope}：${t.note}（${t.ms}ms）`);
  }
  lines.push('');
  lines.push('## 最终答复（唯一海口）');
  lines.push('');
  lines.push(flow.final ?? '');

  const dir = path.join(__dirname, 'report');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `mvp_${Date.now()}.md`);
  import('node:fs').then(({ writeFileSync }) => writeFileSync(file, lines.join('\n'), 'utf8'));

  // 组织档案雏形（JSONL：轨迹/成本/结果，择优的输入）
  const archiveRecord = {
    ts: new Date().toISOString(),
    task: task.slice(0, 120),
    complex,
    scopes: flow.trace.map((t) => t.scope),
    calls: flow.usage.calls,
    tokens: { prompt: flow.usage.prompt, completion: flow.usage.completion },
    ms: elapseMs,
    events: flow.events,
    final_len: (flow.final ?? '').length,
  };
  mkdirSync(path.dirname(ARCHIVE_PATH), { recursive: true });
  appendFileSync(ARCHIVE_PATH, JSON.stringify(archiveRecord) + '\n', 'utf8');

  process.stdout.write(lines.join('\n') + '\n');
  process.stdout.write(`\n[雏形] 报告：${file}\n[雏形] 组织档案：${ARCHIVE_PATH}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`雏形失败：${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
