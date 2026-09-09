/**
 * 孵化式演化雏形：架构资产被"使用数据"塑造（择优器驱动，非 agent 自修改）
 *
 * 区别澄清：
 *  - agent 自修改 = agent 在任务里有意图地改架构（不在此演示）；
 *  - 本文件演示【孵化】：架构文件（组织资产）每轮由择优器根据执行结果更新——
 *    形态选择先验、scope 健康度、域短路结晶、形态降权；agent 执行时只读文件，
 *    从不写文件。多次使用后观察架构资产变成什么样。
 *
 * 架构文件：live/experiment_river/state/architecture.json
 *   - forms:    direct(main 单scope) / delegate(main→planner→workers→main)
 *   - 每 form 统计: uses / success / fail / total_tokens / total_ms
 *   - prior:    epsilon-greedy 选择先验（按成功率×成本效用更新）
 *   - domains:  任务域结晶（连续成功 → domain_shortcut，减少探索）
 *   - scopes:   健康度（每 scope uses/success_rate，达阈值+低成功率 → deprecate 标记）
 *
 * 用法：
 *   npx tsx live/experiment_river/run_evolve.ts --bench 6 --task "<同域任务>"
 *   npx tsx live/experiment_river/run_evolve.ts --once --form direct --task "..."
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const CONFIG_PATH = path.join(ROOT, '.dev-data/kilo-cli/config.json');
const STATE_DIR = path.join(__dirname, 'state');
const ARCH_PATH = path.join(STATE_DIR, 'architecture.json');
const EVO_LOG = path.join(__dirname, 'report', 'evolution_log.jsonl');

interface Arch {
  version: number;
  forms: Record<
    string,
    { uses: number; success: number; fail: number; tokens: number; ms: number }
  >;
  prior: Record<string, number>;
  domains: Record<string, { uses: number; success: number; shortcut: boolean }>;
  scopes: Record<string, { uses: number; success: number; note?: string }>;
  decisions: string[];
}

function defaultArch(): Arch {
  return {
    version: 1,
    forms: {
      direct: { uses: 0, success: 0, fail: 0, tokens: 0, ms: 0 },
      delegate: { uses: 0, success: 0, fail: 0, tokens: 0, ms: 0 },
    },
    prior: { direct: 0.5, delegate: 0.5 },
    domains: {},
    scopes: { main: { uses: 0, success: 0 }, planner: { uses: 0, success: 0 }, worker: { uses: 0, success: 0 } },
    decisions: [],
  };
}

function loadArch(): Arch {
  if (!existsSync(ARCH_PATH)) return defaultArch();
  try {
    const raw = JSON.parse(readFileSync(ARCH_PATH, 'utf8')) as Arch;
    return { ...defaultArch(), ...raw };
  } catch {
    return defaultArch();
  }
}

function saveArch(a: Arch): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(ARCH_PATH, JSON.stringify(a, null, 2), 'utf8');
}

// ────────────────────────────────────────────────────────────────────────────
// 0. LLM 基座
// ────────────────────────────────────────────────────────────────────────────

const MODEL = (() => {
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as {
    model_config: { agent_config: { base_url: string; model_id: string } };
  };
  return raw.model_config.agent_config;
})();

async function chat(
  system: string,
  user: string,
  maxTokens = 1800,
): Promise<{ content: string; prompt: number; completion: number }> {
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

// ────────────────────────────────────────────────────────────────────────────
// 1. 作用域（身份固定；本雏形不演示自修改，scope 只被择优器评估健康度）
// ────────────────────────────────────────────────────────────────────────────

interface RunStat {
  prompt: number;
  completion: number;
  calls: number;
}

async function callScope(
  system: string,
  user: string,
  maxTokens: number,
  stat: RunStat,
): Promise<string> {
  const r = await chat(system, user, maxTokens);
  stat.prompt += r.prompt;
  stat.completion += r.completion;
  stat.calls += 1;
  return r.content;
}

async function runDirect(task: string, stat: RunStat): Promise<string> {
  return callScope(
    '你是主执行 agent（main）。直接完成用户任务并给出可交付的完整输出（如需代码，给出完整可运行代码与简要说明）。只输出正文。',
    `任务：${task}`,
    2600,
    stat,
  );
}

async function runDelegate(task: string, stat: RunStat): Promise<string> {
  // main 判定（自治）
  const judge = await callScope(
    '你是主执行 agent。输出 JSON {"answer":"","next":"ESTUARY|planner"}。需要拆解多步/并行/专门规划 → planner。只输出 JSON。',
    `任务：${task}`,
    1200,
    stat,
  );
  const judgeObj = extractJson(judge);
  if (String(judgeObj?.next ?? '').toUpperCase() !== 'PLANNER') {
    return callScope(
      '你是主执行 agent（main）。直接完成用户任务并给出可交付的完整输出。只输出正文。',
      `任务：${task}`,
      2600,
      stat,
    );
  }
  // planner
  const planRaw = await callScope(
    '你是规划师（不直接回答用户）。把任务拆成 2-3 个可独立执行的子任务。输出 JSON {"plan":{"steps":[{"title":"..","instruction":".."}]},"next":"main"}。只输出 JSON。',
    `任务：${task}`,
    1600,
    stat,
  );
  const planObj = extractJson(planRaw);
  const steps = (planObj?.plan as Record<string, unknown> | undefined)?.steps as
    | Array<{ title: string; instruction: string }>
    | undefined;
  if (!Array.isArray(steps) || steps.length < 1) {
    // 质量闸失败→降级直答
    return callScope(
      '你是主执行 agent（main）。直接完成用户任务并给出可交付的完整输出。只输出正文。',
      `任务：${task}`,
      2600,
      stat,
    );
  }
  // fan-out workers（并行）
  const workerResults = await Promise.all(
    steps.map(async (s, i) => {
      const r = await callScope(
        '你是执行者 worker。完成被分派的子任务，输出该子任务的可交付成果。只输出正文。',
        `子任务 ${i + 1}/${steps.length}：${s.title}\n指令：${s.instruction}`,
        1600,
        stat,
      );
      return `【子任务 ${i + 1}：${s.title}】\n${r}`;
    }),
  );
  // fan-in → main 合成
  return callScope(
    '你是主执行 agent（main）。把子任务成果合成对用户完整、连贯、可交付的最终输出（去重、补齐、形成完整交付物）。只输出正文。',
    `用户任务：${task}\n\n各子任务成果：\n${workerResults.join('\n\n')}`,
    2600,
    stat,
  );
}

/** 任务成功信号（交付质量粗判）：非空 + 足够长 + 无明确的失败/占位声明。 */
function judgedSuccess(final: string): boolean {
  const s = final.trim();
  if (s.length < 60) return false;
  if (/^(抱歉|无法完成|失败|error|报错)/i.test(s)) return false;
  if (s.toLowerCase().includes('sorry') && s.length < 120) return false;
  return true;
}

// ────────────────────────────────────────────────────────────────────────────
// 2. 择优器（孵化核心：无 agent 意图，只按统计改资产）
// ────────────────────────────────────────────────────────────────────────────

/** 形态效用：成功率 - 成本惩罚（token 归一）。 */
function formUtility(f: Arch['forms'][string]): number {
  if (f.uses < 1) return 0;
  const sr = f.success / f.uses;
  const avgCost = f.tokens / f.uses;
  const costPenalty = avgCost / 20000; // 2 万 token 罚满成功率权重的一半
  return sr - costPenalty;
}

/** epsilon-greedy 选形态：以 epsilon 探索，否则选效用更高者（域结晶会压低探索）。 */
function chooseForm(arch: Arch, domain: string, epsilon: number): 'direct' | 'delegate' {
  const d = arch.domains[domain];
  const shortcut = d?.shortcut === true && d.success / Math.max(1, d.uses) >= 0.7;
  const explore = Math.random() < (shortcut ? epsilon * 0.25 : epsilon);
  if (explore) return Math.random() < 0.5 ? 'direct' : 'delegate';
  const uDirect = formUtility(arch.forms.direct);
  const uDelegate = formUtility(arch.forms.delegate);
  // 无样本时默认 direct（短省优先）
  if (uDirect === 0 && uDelegate === 0) return 'direct';
  return uDelegate > uDirect ? 'delegate' : 'direct';
}

/** 每轮后择优器更新资产（统计 + 先验 + 健康 + 结晶 + 日志）。 */
function evolveAfter(arch: Arch, form: string, domain: string, ok: boolean, stat: RunStat): void {
  const f = arch.forms[form];
  f.uses += 1;
  if (ok) f.success += 1;
  else f.fail += 1;
  f.tokens += stat.prompt + stat.completion;
  f.ms += 0;

  arch.prior[form] = formUtility(f);

  // 任务域统计 + 结晶：连续成功 → shortcut（该域偏好直收/已证明形态）
  const d = arch.domains[domain] ?? { uses: 0, success: 0, shortcut: false };
  d.uses += 1;
  if (ok) d.success += 1;
  if (d.uses >= 3 && d.success / d.uses >= 0.8) d.shortcut = true;
  if (d.uses >= 5 && d.success / d.uses < 0.5) d.shortcut = false;
  arch.domains[domain] = d;

  // scope 健康度（按本轮涉及 scope 粗记：direct 涉及 main；delegate 涉及 main+planner+worker）
  const involved = form === 'direct' ? ['main'] : ['main', 'planner', 'worker'];
  for (const s of involved) {
    const sc = arch.scopes[s] ?? { uses: 0, success: 0 };
    sc.uses += 1;
    if (ok) sc.success += 1;
    arch.scopes[s] = sc;
  }

  // 待下架候选（孵化侧观察信号；样本足够且成功率过低 → 标记）
  for (const s of Object.keys(arch.scopes)) {
    const sc = arch.scopes[s]!;
    if (sc.uses >= 4 && sc.success / sc.uses < 0.4) {
      sc.note = 'deprecate-candidate';
    } else if (sc.uses < 4) {
      sc.note = 'sampling';
    }
  }

  arch.decisions.push(`${form}:${ok ? 'ok' : 'fail'}@${domain}`);
  appendFileSync(
    EVO_LOG,
    JSON.stringify({ ts: new Date().toISOString(), form, domain, ok, tokens: stat.prompt + stat.completion, calls: stat.calls }) + '\n',
  );
}

function summarize(arch: Arch): string {
  const rows = Object.keys(arch.forms).map((k) => {
    const f = arch.forms[k]!;
    return `${k}(u=${f.uses},s=${f.success},sr=${f.uses ? (f.success / f.uses).toFixed(2) : '-'},tok=${f.tokens})`;
  });
  const dom = Object.keys(arch.domains).map(
    (k) => `${k}(u=${arch.domains[k]!.uses},sr=${arch.domains[k]!.uses ? (arch.domains[k]!.success / arch.domains[k]!.uses).toFixed(2) : '-'},sc=${arch.domains[k]!.shortcut})`,
  );
  const scopes = Object.keys(arch.scopes).map(
    (k) => `${k}(sr=${arch.scopes[k]!.uses ? (arch.scopes[k]!.success / arch.scopes[k]!.uses).toFixed(2) : '-'},${arch.scopes[k]!.note ?? ''})`,
  );
  return `forms: ${rows.join(' | ')}\ndomains: ${dom.join(' | ')}\nscopes: ${scopes.join(' | ')}`;
}

// ────────────────────────────────────────────────────────────────────────────
// 3. CLI：单次 / 批量（bench）同一域任务，观察架构被孵化成什么样
// ────────────────────────────────────────────────────────────────────────────

async function runOnce(arch: Arch, form: 'direct' | 'delegate', task: string, domain: string): Promise<boolean> {
  const stat: RunStat = { prompt: 0, completion: 0, calls: 0 };
  process.stdout.write(`\n[轮] form=${form} domain=${domain}\n`);
  try {
    const t0 = Date.now();
    const final = form === 'direct' ? await runDirect(task, stat) : await runDelegate(task, stat);
    const ms = Date.now() - t0;
    const ok = judgedSuccess(final);
    arch.forms[form].ms += ms;
    evolveAfter(arch, form, domain, ok, stat);
    saveArch(arch);
    process.stdout.write(`  → ok=${ok} calls=${stat.calls} tokens=${stat.prompt}+${stat.completion} ms=${ms}\n`);
    if (!ok) process.stdout.write(`  finalLen=${final.length} finalHead=${final.slice(0, 80).replace(/\n/g, ' ')}\n`);
    return ok;
  } catch (err) {
    evolveAfter(arch, form, domain, false, stat);
    saveArch(arch);
    process.stdout.write(`  → exception: ${err instanceof Error ? err.message : String(err)}\n`);
    return false;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const benchN = Number(args.find((a) => a.startsWith('--bench'))?.split('=')[1] ?? 0) || 0;
  const explicitForm = args.includes('--direct') ? 'direct' : args.includes('--delegate') ? 'delegate' : null;
  const task = args.filter((a) => !a.startsWith('--')).join(' ').trim();

  mkdirSync(path.dirname(EVO_LOG), { recursive: true });
  const arch = loadArch();
  const domain = 'coding-cli-python';

  if (!task) {
    process.stderr.write('用法：npx tsx live/experiment_river/run_evolve.ts --bench 6 --task "<同域任务>"\n');
    process.exit(2);
  }

  if (benchN > 0) {
    for (let i = 0; i < benchN; i++) {
      const form = explicitForm ?? chooseForm(arch, domain, 0.35);
      await runOnce(arch, form, task, domain);
      process.stdout.write(`[架构@轮${i + 1}]\n${summarize(arch)}\n`);
    }
  } else {
    const form = explicitForm ?? chooseForm(arch, domain, 0.5);
    await runOnce(arch, form, task, domain);
  }
  process.stdout.write(`\n[架构文件] ${ARCH_PATH}\n[演化日志] ${EVO_LOG}\n最终架构：\n${summarize(arch)}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`失败：${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
