/**
 * 成熟图实验：规划 → 编码(并行+执行+返工) → 审查 → 合成（Planner-Coders-Critic）
 *
 * 对应执行稿 agent_execution_design.md 的原语：
 *  - 作用域（节点）：main(主持人) / planner / coder(N 路并行) / critic / SINK(汇聚点)
 *  - 通道（边）：delegate / fan-out / fan-in(全量回传) / 回传 / 收敛
 *  - 契约：plan{steps[].acceptance} / coder{code} / critic{verdict} / main{answer,next}
 *  - 能力类工具 exec：把 coder 写的代码真实执行（venv python），拿 stdout/stderr/退出码
 *  - 验证闭环：exec 运行失败 → 错误回喂 coder 返工(≤2)；critic 对照 acceptance 审查
 *
 * 图：
 *   main ──delegate──▶ planner ──回传(plan)──▶ main
 *   main ──fan-out──▶ coder×N ──fan-in(代码+运行结果)──▶ main
 *   main ──delegate──▶ critic ──回传(verdict)──▶ main ──▶ SINK
 *
 * 用法：
 *   npx tsx live/experiment_river/run_graph.ts "<编码任务>"
 */

import { mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const CONFIG_PATH = path.join(ROOT, '.dev-data/kilo-cli/config.json');
const SANDBOX = path.join(__dirname, 'sandbox');
const ARCHIVE = path.join(__dirname, 'report', 'graph_archive.jsonl');

const VENV_PY = path.resolve(ROOT, '..', '.venv', 'Scripts', 'python.exe');
const PYTHON = existsSync(VENV_PY) ? VENV_PY : 'python';

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

interface ChatOut {
  content: string;
  prompt: number;
  completion: number;
}
async function chat(system: string, user: string, maxTokens = 1800): Promise<ChatOut> {
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
    choices?: Array<{ message: { content?: string | null } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const m = body.choices?.[0]?.message;
  return {
    content: m?.content ?? '',
    prompt: body.usage?.prompt_tokens ?? 0,
    completion: body.usage?.completion_tokens ?? 0,
  };
}

function extractJson(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 从 coder 输出里取代码：优先 JSON.code，否则 ```python/``` 代码块，否则原文。 */
function extractCode(text: string): string {
  const obj = extractJson(text);
  const code = obj?.['code'];
  if (typeof code === 'string' && code.trim() !== '') return code;
  const fence = text.match(/```(?:python|py)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  return text.trim();
}

// ────────────────────────────────────────────────────────────────────────────
// 作用域（节点）身份定义
// ────────────────────────────────────────────────────────────────────────────

const SCOPES = {
  mainJudge: {
    system:
      '你是主持人 main。判断任务：输出 JSON {"answer":"...","next":"ESTUARY|planner"}。' +
      '任务需要写代码/拆解多步 → next=planner（answer 可为空）；能直接回答 → answer 给答复、next=ESTUARY。只输出 JSON。',
  },
  planner: {
    system:
      '你是规划师。把编码任务拆成 2-3 个可独立编写的子任务，每个子任务带验收标准 acceptance（一句话：怎样算通过）。' +
      '输出 JSON：{"plan":{"steps":[{"title":"...","instruction":"...","acceptance":"..."}]}}。只输出 JSON。',
  },
  coder: {
    system:
      '你是编码者 coder。写一个完整、可独立运行的 Python 脚本完成给定子任务（只依赖标准库）。' +
      '输出 JSON：{"code":"...完整 Python 代码..."}（代码内的换行用 \\n 转义）。只输出 JSON。',
  },
  coderFix: {
    system:
      '你是编码者 coder。你上一版代码运行失败，请修复并重新输出完整 Python 脚本。' +
      '输出 JSON：{"code":"...完整 Python 代码..."}（换行用 \\n 转义）。只输出 JSON。',
  },
  critic: {
    system:
      '你是审查者 critic。对照验收标准，审查"代码 + 实际运行输出"，判断是否通过。' +
      '输出 JSON：{"verdict":"ok|fix","review":"审查意见"}。只输出 JSON。',
  },
  mainCompose: {
    system:
      '你是主持人 main。把各子任务的代码、实际运行结果、审查结论，合成为面向用户的最终交付：' +
      '先说明验证是否通过，再给出完整可用代码。只输出正文。',
  },
} as const;

// ────────────────────────────────────────────────────────────────────────────
// 能力类工具 exec：真实执行 Python 代码
// ────────────────────────────────────────────────────────────────────────────

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
function execCode(code: string): ExecResult {
  mkdirSync(SANDBOX, { recursive: true });
  const file = path.join(SANDBOX, `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.py`);
  writeFileSync(file, code, 'utf8');
  try {
    const r = spawnSync(PYTHON, [file], { encoding: 'utf8', timeout: 30000, cwd: SANDBOX });
    return {
      code: r.status ?? -1,
      stdout: (r.stdout ?? '').trim(),
      stderr: (r.stderr ?? '').trim(),
    };
  } catch (err) {
    return { code: -1, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 水流（执行）状态与运行
// ────────────────────────────────────────────────────────────────────────────

interface Flow {
  task: string;
  final: string;
  trace: string[];
  usage: { prompt: number; completion: number; calls: number };
  events: string[];
}

function makeFlow(task: string): Flow {
  return { task, final: '', trace: [], usage: { prompt: 0, completion: 0, calls: 0 }, events: [] };
}

async function call(flow: Flow, scope: string, system: string, user: string, maxTokens = 1800): Promise<string> {
  const r = await chat(system, user, maxTokens);
  flow.usage.prompt += r.prompt;
  flow.usage.completion += r.completion;
  flow.usage.calls += 1;
  flow.trace.push(scope);
  return r.content;
}

interface SubResult {
  title: string;
  acceptance: string;
  code: string;
  run: ExecResult;
  ok: boolean;
}

/** 单个 coder：写代码 → exec → 失败返工(≤2)。 */
async function runCoder(flow: Flow, sub: { title: string; instruction: string; acceptance: string }, i: number, total: number): Promise<SubResult> {
  const brief = `子任务 ${i + 1}/${total}：${sub.title}\n指令：${sub.instruction}\n验收标准：${sub.acceptance}`;
  let code = extractCode(await call(flow, 'coder', SCOPES.coder.system, brief, 2000));
  let run = execCode(code);
  let ok = run.code === 0 && run.stdout !== '';
  let attempts = 0;
  while (!ok && attempts < 2) {
    attempts += 1;
    flow.events.push(`coder-${i + 1}: exec 失败，返工 ${attempts}`);
    const errBrief = `${brief}\n\n上一版运行结果：退出码=${run.code}\nstderr=${run.stderr.slice(0, 1200)}\nstdout=${run.stdout.slice(0, 400)}`;
    code = extractCode(await call(flow, 'coder', SCOPES.coderFix.system, errBrief, 2000));
    run = execCode(code);
    ok = run.code === 0 && run.stdout !== '';
  }
  if (ok) flow.events.push(`coder-${i + 1}: exec ok`);
  else flow.events.push(`coder-${i + 1}: 返工 ${attempts} 次仍失败`);
  return { title: sub.title, acceptance: sub.acceptance, code, run, ok };
}

interface Plan {
  steps: Array<{ title: string; instruction: string; acceptance: string }>;
}

function parsePlan(text: string): Plan | null {
  const obj = extractJson(text);
  const steps = (obj?.plan as Record<string, unknown> | undefined)?.steps as
    | Array<{ title?: unknown; instruction?: unknown; acceptance?: unknown }>
    | undefined;
  if (!Array.isArray(steps) || steps.length < 1) return null;
  const clean: Plan['steps'] = [];
  for (const s of steps) {
    const title = str(s?.title);
    const instruction = str(s?.instruction);
    const acceptance = str(s?.acceptance);
    if (title === '' || instruction === '') return null;
    clean.push({ title, instruction, acceptance: acceptance === '' ? '无明确验收，代码能运行且输出合理结果即通过' : acceptance });
  }
  return { steps: clean };
}

async function runGraph(task: string, forceGraph: boolean): Promise<Flow> {
  const flow = makeFlow(task);

  // ① main 判定：直答 or 拆解（--graph 强制走图，跳过判定）
  if (!forceGraph) {
    const judge = await call(flow, 'main', SCOPES.mainJudge.system, `任务：${task}`, 1200);
    const next = str(extractJson(judge)?.['next']).toUpperCase();
    if (next !== 'PLANNER') {
      flow.events.push('main 判定：直答（未进图）');
      const direct = await call(flow, 'main', SCOPES.mainCompose.system, `任务：${task}\n请直接给出可交付答案。`, 2200);
      flow.final = direct;
      flow.events.push('estuary: direct');
      return flow;
    }
    flow.events.push('delegate: planner');
  } else {
    flow.events.push('delegate: planner (forced)');
  }

  // ② planner：拆子任务（带验收标准），质量闸返工一次
  let plan = parsePlan(await call(flow, 'planner', SCOPES.planner.system, `任务：${task}`, 1600));
  if (plan === null) {
    plan = parsePlan(await call(flow, 'planner', SCOPES.planner.system + ' 上次输出不是合法 JSON，请重新输出。', `任务：${task}`, 1600));
  }
  if (plan === null) {
    flow.events.push('quality-gate: plan 失败 → 降级直答');
    flow.final = await call(flow, 'main', SCOPES.mainCompose.system, `任务：${task}\n（计划生成失败，请直接完整回答。）`, 2200);
    flow.events.push('degraded: no-plan');
    return flow;
  }
  flow.events.push(`fan-out: ${plan.steps.length} coders`);

  // ③ fan-out：N 路 coder 并行（写代码 + exec + 返工）
  const jobs = plan.steps.map((s, i) => runCoder(flow, s, i, plan.steps.length));
  const subs = await Promise.all(jobs);
  flow.events.push(`fan-in: ${subs.length} results`);

  // ④ critic：对照验收标准审查
  const codeBlock = subs.map((s) => `### ${s.title}\n验收：${s.acceptance}\n运行状态：${s.ok ? '通过(退出码0)' : '失败'}\nstdout：${s.run.stdout.slice(0, 600)}\nstderr：${s.run.stderr.slice(0, 400)}\n\`\`\`python\n${s.code.slice(0, 1500)}\n\`\`\``).join('\n\n');
  const crit = await call(flow, 'critic', SCOPES.critic.system, `任务：${task}\n\n${codeBlock}`, 1400);
  const verdict = str(extractJson(crit)?.['verdict']).toLowerCase();
  const review = str(extractJson(crit)?.['review']) || crit;
  flow.events.push(`review-gate: critic → ${verdict === 'ok' ? 'ok' : 'fix'}`);

  // ⑤ main 合成最终交付
  const verdictText = verdict === 'ok' ? '验证通过' : '存在缺陷，需修正';
  const allCode = subs.map((s) => `# ${s.title}\n${s.code}`).join('\n\n');
  const final = await call(
    flow,
    'main',
    SCOPES.mainCompose.system,
    `任务：${task}\n\n审查结论：${verdictText}\n审查意见：${review}\n\n各子任务完整代码：\n${allCode}`,
    3000,
  );
  flow.final = final;
  flow.events.push('estuary: converge');
  return flow;
}

// ────────────────────────────────────────────────────────────────────────────
// 报告 + 组织档案
// ────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const forceGraph = args.includes('--graph');
  const task = args.filter((a) => a !== '--graph').join(' ').trim();
  if (!task) {
    process.stderr.write('用法：npx tsx live/experiment_river/run_graph.ts [--graph] "<编码任务>"\n');
    process.exit(2);
  }
  const t0 = Date.now();
  const flow = await runGraph(task, forceGraph);
  const ms = Date.now() - t0;

  const lines: string[] = [];
  lines.push('# 成熟图实验：规划-编码-审查报告');
  lines.push('');
  lines.push(`- 任务：${task}`);
  lines.push(`- 节点轨迹：${flow.trace.join(' → ') || '(空)'}`);
  lines.push(`- 事件：${flow.events.join('；')}`);
  lines.push(`- LLM 调用：${flow.usage.calls}；tokens：${flow.usage.prompt}+${flow.usage.completion}；耗时 ${ms}ms`);
  lines.push('');
  lines.push('## 最终交付');
  lines.push('');
  lines.push(flow.final);

  const dir = path.join(__dirname, 'report');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `graph_${Date.now()}.md`);
  writeFileSync(file, lines.join('\n'), 'utf8');

  mkdirSync(path.dirname(ARCHIVE), { recursive: true });
  appendFileSync(
    ARCHIVE,
    JSON.stringify({ ts: new Date().toISOString(), task: task.slice(0, 120), scopes: flow.trace, calls: flow.usage.calls, tokens: { prompt: flow.usage.prompt, completion: flow.usage.completion }, ms, events: flow.events, final_len: flow.final.length }) + '\n',
    'utf8',
  );

  process.stdout.write(lines.join('\n') + '\n');
  process.stdout.write(`\n[图实验] 报告：${file}\n[图实验] 档案：${ARCHIVE}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`图实验失败：${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
