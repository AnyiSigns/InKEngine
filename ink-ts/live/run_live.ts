/**
 * live 端到端真实链路冒烟 + 受控自进化场景（web 协议层直连，无需浏览器）。
 *
 * 测试内容（README 标注：本脚本测什么）：
 *  - 覆盖链路：web 前端 → cli serve（http /rpc + ws /ws）→ engine 回合（组装）→
 *    真实 LLM（.dev-data/kilo-cli/config.json 装配）→ 事件回流。这是 web 前端
 *    真正走的通道（前端 transport.ts 同款），非自写假数据链路。
 *  - 复用的传输实现：@ink-ts/renderer 的 createServeChannel（fetch JSON-RPC +
 *    WebSocket 订阅）——与 hosts/web 前端完全同一套代码，验证 web 协议层不脱节。
 *  - 发回合：rounds.send（rpc 方法，与 cli run --round 同命令面）。
 *  - 多状态观测：thinking 推理流 / reply 正文 / tool 工具卡 / 错误 / 审批卡 /
 *    LLM usage / 事件时序 / 进程状态。
 *
 * 形态一：单回合冒烟（原行为，5/5 断言基线）
 *  - 断言目标：thinking_start→thinking_end 发射、reply_token 发射、tool_start/
 *    tool_end 成对、无错误、exit 0（工具调用类 prompt 会触发工具卡，验证引擎侧
 *    事件发射在真实链路生效）。
 *
 * 形态二：--scenario auto 受控自进化场景（本任务新增，live 扩展遗留 #5）
 *  测什么：
 *  - 同线程多轮：同一 thread_id 连续 rounds.send（回合链续聊，消息链随
 *    checkpoint 追加，rounds.send 返回后按同 thread 再发下一条）；
 *  - 工具审批卡自动 resolve：serve 非 autoApprove 时，回合挂审批卡
 *    （review_card / reason=interrupted）→ 脚本调 approval.resolve(accept)
 *    重入续跑，不把回合晾在挂起态；
 *  - auto 直过配置：serve 以 --approve 启动（autoApprove=true，宿主
 *    interrupt_policy 全量直过）——本地回环（127.0.0.1）测试专用安全面，
 *    生产保持 fail-closed 缺省（live 脚本不打开产品侧开关）；
 *  - 真实 auto 续轮：prompt 引导 agent 用 apply_patch 落地一条低风险
 *    knowledge 知识条目（不改工具权限/网络/端点/审批/UI 等危险面）→ 断言
 *    apply_patch 落地（tool_end success + ok:true）后出现 auto 轮（事件
 *    round_id 带 auto: 前缀）→ 会话收尾 stop。auto 轮由引擎 assemble_round
 *    同一 RPC 内自续（护栏 = 配方 auto_continue_limit=3），因此单次
 *    rounds.send 的事件流内即可观测到 apply 轮 + auto 轮两个 round_id。
 *
 * 用法：
 *   形态一：npx tsx live/run_live.ts [--case <id>] <prompt> [--tool] [--force-spawn] [--approve]
 *   形态二：npx tsx live/run_live.ts --scenario auto [--case <id>] [--force-spawn] [--approve]
 *   形态三：npx tsx live/run_live.ts --scenario observe [--case <id>] [--force-spawn] [--approve]
 *     图架构多样观察（只读观察；产品代码零改动）：跑 ≥3 个不同目标会话 +
 *     一个含 apply_patch→auto 续轮的会话，逐用户回合记录组装图组成（事件流
 *     逐 round 执行实例集 + graph.instance 节点/边快照），报告落到
 *     live/report/<case>.md（配合 --case graph_observe 即产出验收文件）。
 * 公共 flag：
 *   --case <id>     报告名缺省 live（反复运行覆盖 live/report/<id>.md）
 *   --force-spawn   强制 spawn 新 serve（改模型配置后重装配用）
 *   --approve       拉起 serve 时带 --approve（auto 直过；见上安全面说明）
 *   --thread <id>   指定场景会话 thread_id（缺省自动生成；同 id 反复跑会续既有链）
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { createServeChannel, ROUND_EVENT_TOPIC, type ServeChannel } from '../renderer/src/shared/backend/transport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(ROOT, '.dev-data/kilo-cli');
const REPORT_DIR = path.join(__dirname, 'report');
const SERVE_ENTRY = path.join(ROOT, 'bootstrap', 'main.ts');

/** live 固定 serve 端口/token（避免与 dev 的 18731 冲突；同配置复用防重装配）。 */
const LIVE_PORT = 18740;
const LIVE_TOKEN = 'ink-ts-live-loopback';

/** web transport 事件装载（envelope.payload = event.to_dict()）。 */
interface Envelope {
  event: string;
  id: number;
  payload: RawEvent;
}
interface RawEvent {
  type: string;
  version?: number;
  payload: Record<string, unknown>;
  step_id: string | null;
  round_id: string | null;
  node: string | null;
  seq: number;
  trace_id: string;
  thread_id: string;
  [k: string]: unknown;
}

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function esc(text: string): string {
  return String(text).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '\\|');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 探测固定端口是否已有 live serve：/health 可达 + /rpc host.ping 鉴权通过。 */
async function tryProbe(url: string, token: string): Promise<boolean> {
  try {
    const health = await fetch(`${url}/health`);
    if (!health.ok) return false;
    const rpc = await fetch(`${url}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'host.ping' }),
    });
    if (!rpc.ok) return false;
    const body = (await rpc.json()) as { result?: unknown };
    return body.result === 'pong';
  } catch {
    return false;
  }
}

/** 终止占用 LIVE_PORT 的监听进程（scenario 强制 spawn 前清场；loopback 测试面）。
 *  与 stop_live.ts 同口径：netstat 找 LISTENING pid → SIGTERM/taskkill。 */
function killPortListeners(port: number): void {
  try {
    const out = execSync(`netstat -ano -p tcp`, { encoding: 'utf8' });
    const pids = [
      ...new Set(
        out
          .split('\n')
          .filter((l) => l.includes(`:${port}`) && /LISTENING/i.test(l))
          .map((l) => l.trim().split(/\s+/).pop() ?? '')
          .filter((s) => /^\d+$/.test(s)),
      ),
    ];
    for (const pid of pids) {
      try {
        process.kill(Number(pid), 'SIGTERM');
      } catch {
        try {
          execFileSync('taskkill', ['/PID', pid, '/F', '/T']);
        } catch {
          // 已退出或无权限
        }
      }
      process.stdout.write(`[live] 清场：已终止占用 :${port} 的旧 serve pid=${pid}\n`);
    }
  } catch {
    // netstat 不可用 = 无清场动作（spawn 将自行报端口占用）
  }
}

/** 连接 live serve：默认仅探测复用（需已启动常驻 serve，见 live/serve_live.ts）。
 *  --force-spawn 时 spawn 一次（用完关停；不常驻）。--approve 时 spawn 带
 *  --approve（autoApprove=true；回环测试专用，见文件头安全面说明）。 */
async function connectServe(forceSpawn: boolean, approve: boolean): Promise<{ url: string; ws: string; token: string; stop: () => Promise<void> }> {
  const url = `http://127.0.0.1:${LIVE_PORT}`;
  const existing = !forceSpawn ? await tryProbe(url, LIVE_TOKEN) : false;
  if (existing) {
    process.stdout.write(`serve 复用 ${url}（现有常驻进程，未重装配）\n`);
    return {
      url,
      ws: url.replace(/^http/, 'ws') + '/ws',
      token: LIVE_TOKEN,
      stop: async () => undefined, // 复用的 serve 不归本脚本关停
    };
  }
  if (!forceSpawn) {
    throw new Error(
      `127.0.0.1:${LIVE_PORT} 无 live serve。请先启动常驻进程：` +
        `npx tsx live/serve_live.ts` + `；或加 --force-spawn 由本脚本临时拉起（用完自停）`,
    );
  }
  // --force-spawn：先清场旧监听（防复用常驻进程残留占端口），再临时拉起，
  // 本脚本结束关停（不进常驻/不复用）
  killPortListeners(LIVE_PORT);
  const serveArgv = ['--import', 'tsx', SERVE_ENTRY, 'serve', '--port', String(LIVE_PORT), '--token', LIVE_TOKEN, '--data-dir', CONFIG_DIR];
  if (approve) serveArgv.push('--approve');
  const child: ChildProcess = spawn(process.execPath, serveArgv, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  const listen = new Promise<{ url: string; ws: string; token: string }>((resolve, reject) => {
    let acc = '';
    const onData = (chunk: Buffer): void => {
      acc += String(chunk);
      const line = acc.split('\n').find((l) => l.includes('"event":"listen"'));
      if (line !== undefined) {
        try {
          const parsed = JSON.parse(line.slice(line.indexOf('{')).trim());
          child.stdout!.off('data', onData);
          resolve({ url: parsed.url, ws: parsed.ws, token: parsed.token });
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', (c) => { stderr += String(c); });
    child.on('error', (err) => reject(err));
    child.on('exit', (code) => reject(new Error(`serve 提前退出(${code})：${stderr}`)));
  });
  const info = await listen;
  const stop = async (): Promise<void> => {
    stdioGc(child);
    child.kill('SIGTERM');
    await new Promise<void>((r) => child.on('exit', () => r()));
  };
  return { ...info, stop };
}

/** 丢弃子进程管道句柄，防父进程等待（force-spawn 用）。 */
function stdioGc(child: ChildProcess): void {
  child.stdout?.removeAllListeners('data');
  child.stderr?.removeAllListeners('data');
}

/** rounds.send 的 RPC 返回面（与本脚本消费字段对齐）。 */
interface SendResult {
  thread_id?: unknown;
  round_id?: unknown;
  trace_id?: unknown;
  reason?: unknown;
  checkpoint_id?: unknown;
  reply?: unknown;
  warnings?: unknown;
  [k: string]: unknown;
}

/** 多状态观测统计（web 事件流 → 状态观测指标）。 */
function observe(events: RawEvent[], result: Record<string, unknown> | null) {
  const thinkingStarts = events.filter((e) => e.type === 'thinking_start');
  const thinkingEnds = events.filter((e) => e.type === 'thinking_end');
  const replyTokens = events.filter((e) => e.type === 'reply_token');
  const toolStarts = events.filter((e) => e.type === 'tool_start');
  const toolEnds = events.filter((e) => e.type === 'tool_end');
  const errors = events.filter((e) => e.type === 'error');
  const reviewCards = events.filter((e) => e.type === 'review_card');
  const usageEvents = events.filter((e) => e.type === 'llm_usage');

  const thinkingText = thinkingStarts.map((e) => String(e.payload['content'] ?? '')).join('');
  const replyText = replyTokens.map((e) => String(e.payload['token'] ?? '')).join('');
  const usage = usageEvents.length > 0 ? usageEvents[usageEvents.length - 1]!.payload : null;
  const seqs = events.map((e) => e.seq ?? 0);
  const first = events[0];
  const types = events.map((e) => e.type);
  const stageOrder = types.filter((t, i, a) => a.indexOf(t) === i);

  const replyFromResult = result?.['reply'] ?? result?.['reason'];
  return {
    ids: { thread_id: String(first?.thread_id ?? ''), round_id: String(first?.round_id ?? ''), trace_id: String(first?.trace_id ?? '') },
    total: events.length,
    seqSpan: seqs.length > 0 ? seqs[seqs.length - 1]! - seqs[0]! : 0,
    thinking: { frames: thinkingStarts.length, chars: thinkingText.length, ends: thinkingEnds.length, text: thinkingText },
    reply: { frames: replyTokens.length, chars: replyText.length, text: replyText },
    tool: { starts: toolStarts.length, ends: toolEnds.length },
    errors,
    reviewCards: reviewCards.length,
    usage,
    stageOrder,
    typeCounts: Object.entries(events.reduce<Record<string, number>>((a, e) => { a[e.type] = (a[e.type] ?? 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]),
    resultReplies: replyFromResult,
  };
}

/** 断言项（测试内容标注 + 通过/失败）。 */
function checks(obs: ReturnType<typeof observe>, forceTool: boolean): Array<{ name: string; ok: boolean; detail: string }> {
  const items: Array<{ name: string; ok: boolean; detail: string }> = [];
  items.push({ name: 'web transport 直连 serve 可用', ok: true, detail: 'createServeChannel 连接真实 serve' });
  items.push({ name: 'thinking 推理流发射', ok: obs.thinking.frames > 0, detail: `${obs.thinking.frames} 帧 / ${obs.thinking.chars} 字` });
  items.push({ name: 'thinking_end 收尾', ok: obs.thinking.ends > 0, detail: `${obs.thinking.ends} 条` });
  items.push({ name: '正文 reply_token 流式', ok: obs.reply.frames > 0, detail: `${obs.reply.frames} 帧 / ${obs.reply.chars} 字` });
  if (forceTool) {
    items.push({ name: '工具卡 tool_start 发射', ok: obs.tool.starts > 0, detail: `${obs.tool.starts} 条` });
    items.push({ name: '工具卡 tool_end 收尾', ok: obs.tool.ends > 0, detail: `${obs.tool.ends} 条` });
    items.push({ name: 'tool_start/end 配对', ok: obs.tool.starts > 0 && obs.tool.starts === obs.tool.ends, detail: `${obs.tool.starts}/${obs.tool.ends}` });
  }
  items.push({ name: '回合无错误', ok: obs.errors.length === 0, detail: obs.errors.length === 0 ? '无' : `${obs.errors.length} 条` });
  return items;
}

function buildReport(caseId: string, prompt: string, obs: ReturnType<typeof observe>, checksList: Array<{ name: string; ok: boolean; detail: string }>): string {
  const pass = checksList.filter((c) => c.ok).length;
  const checkLine = checksList.map((c) => `- ${c.ok ? '✅' : '❌'} **${c.name}**：${c.detail}`).join('\n');
  return `# Live 端到端报告：${caseId}

> 本报告自动生成（\`live/run_live.ts\`），多轮运行覆盖重写。

## 测试内容标注（本用例验证什么）
- **链路**：web transport（\`createServeChannel\`，与 hosts/web 前端同款）→ cli serve（\`/rpc\`+\`/ws\`）→ engine 组装回合 → 真实 LLM（\`.dev-data/kilo-cli/config.json\`）→ 事件回流。
- **不依赖浏览器**：直连 serve 的 http/ws 通道，验证的是 web 前端真正走的协议层，从 web 端不脱节。
- **输入**：\`${esc(prompt)}\`
- **观测**：thinking 推理流 / reply 正文 / tool 工具卡 / 错误 / 审批卡 / LLM usage / 事件时序 / 回合结果。

## 断言结果（${pass}/${checksList.length}）
${checkLine}

## 多状态观测
| 观测项 | 值 |
|---|---|
| 事件总数 | ${obs.total} |
| 事件 seq 跨度 | ${obs.seqSpan} |
| thinking 分片 | ${obs.thinking.frames} 帧 / ${obs.thinking.chars} 字 |
| thinking_end | ${obs.thinking.ends} 条 |
| reply 正文 | ${obs.reply.frames} 帧 / ${obs.reply.chars} 字 |
| tool_start / tool_end | ${obs.tool.starts} / ${obs.tool.ends} |
| 审批卡 | ${obs.reviewCards} |
| LLM usage | ${obs.usage ? esc(JSON.stringify(obs.usage)) : '无'} |
| 错误 | ${obs.errors.length} 条 ${obs.errors.length > 0 ? `（${esc(JSON.stringify(obs.errors.map((e) => e.payload)))}）` : ''} |
| 回合结果（reply） | ${esc(JSON.stringify(obs.resultReplies ?? null))} |

## 事件类型分布
${obs.typeCounts.map(([t, n]) => `${t}（${n}）`).join('、')}

## 关键阶段序
${obs.stageOrder.join(' → ')}

## 思考全文（thinking_start 分片拼接）
\`\`\`
${obs.thinking.text.slice(0, 2000) || '（无）'}
\`\`\`

## 回复全文（reply_token 拼接）
\`\`\`
${obs.reply.text.slice(0, 2000) || '（无）'}
\`\`\`
`;
}

// ────────────────────────────────────────────────────────────────────────────
// 形态二：同线程多轮受控场景（live 扩展遗留 #5）
// ────────────────────────────────────────────────────────────────────────────

/** 审计记录里 payload.entry.id 读取（knowledge 补丁审计；缺形态 = ''）。 */
function auditEntryId(rec: Record<string, unknown>): string {
  const payload = rec['payload'];
  if (typeof payload !== 'object' || payload === null) return '';
  const entry = (payload as Record<string, unknown>)['entry'];
  if (typeof entry !== 'object' || entry === null) return '';
  const id = (entry as Record<string, unknown>)['id'];
  return typeof id === 'string' ? id : '';
}

/** 场景回合记录（一次 rounds.send = 一个用户回合；apply 轮 + auto 轮都落在
 *  同一次 rounds.send 的事件流里，故回合内 round_id 会多于 1 个）。 */
interface RoundTurn {
  /** 用户消息（第 n 条同线程消息）。 */
  prompt: string;
  /** rounds.send RPC 返回（reason/checkpoint_id/reply）。 */
  result: SendResult | null;
  /** 本回合新增事件（会话订阅自上个回合切点起增量）。 */
  added: RawEvent[];
  /** 审批卡自动 resolve 次数（非 autoApprove serve 的兜底；auto 轮断言
   *  要求 autoApprove 直过，resolve 模式只保证回合不悬空）。 */
  approvalsResolved: number;
}

/** 场景观测统计（多回合聚合 + auto 轮证据面）。 */
interface ScenarioObs {
  userRounds: number;
  checkpoints: number;
  /** 全会话（含 auto 轮）事件。 */
  events: RawEvent[];
  llmUsageSum: { prompt_tokens: number; completion_tokens: number; calls: number };
  /** 按用户回合切分统计。 */
  turns: Array<{
    index: number;
    prompt: string;
    eventCount: number;
    roundIds: string[];
    autoRoundIds: string[];
    applyStarts: number;
    applyEnds: number;
    applyOk: boolean;
    replyPreview: string;
    reviewCards: number;
    approvalsResolved: number;
    usage: { prompt_tokens: number; completion_tokens: number } | null;
  }>;
}

function isApplyToolEvent(e: RawEvent, type: 'tool_start' | 'tool_end'): boolean {
  return e.type === type && e.payload['tool'] === 'apply_patch';
}

/** 事件流里 distinct round_id（按出现序去重；null 跳过）。 */
function distinctRoundIds(events: RawEvent[]): string[] {
  const seen: string[] = [];
  for (const e of events) {
    const rid = e.round_id;
    if (rid !== null && rid !== undefined && !seen.includes(rid)) seen.push(rid);
  }
  return seen;
}

/** auto 轮 round_id（引擎 assemble_round 自续链：round_id = `auto:<audit-key>`）。 */
function autoRoundIdsOf(events: RawEvent[]): string[] {
  return distinctRoundIds(events).filter((rid) => rid.startsWith('auto:'));
}

/** apply_patch 落地判定：tool_end success=true 且输出摘要含 ok:true（与产品
 *  self_tools.ts 的响应面一致：落地信号 = 内核 JSON 响应 ok=true）。 */
function applyPatchOk(events: RawEvent[]): boolean {
  return events.some((e) => {
    if (!isApplyToolEvent(e, 'tool_end')) return false;
    if (e.payload['success'] !== true) return false;
    const summary = String(e.payload['summary'] ?? '');
    return summary.includes('"ok":true');
  });
}

/** llm_usage 事件 token 求和（近似：每次 LLM 调用的 usage 事件累加；引擎同一
 *  模型调用可能发多条 usage，作量级近似，精确结算以模型网关账单为准）。 */
function sumLlmUsage(events: RawEvent[]): { prompt_tokens: number; completion_tokens: number; calls: number } {
  let promptTokens = 0;
  let completionTokens = 0;
  let calls = 0;
  for (const e of events) {
    if (e.type !== 'llm_usage') continue;
    const payload = e.payload;
    calls += 1;
    const p = typeof payload['prompt_tokens'] === 'number' ? payload['prompt_tokens'] : 0;
    const c = typeof payload['completion_tokens'] === 'number' ? payload['completion_tokens'] : 0;
    promptTokens += p;
    completionTokens += c;
  }
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens, calls };
}

/** 单一回合 LLM usage（llm_usage 事件最后一帧；无 = null）。 */
function roundUsage(events: RawEvent[]): { prompt_tokens: number; completion_tokens: number } | null {
  const usages = events.filter((e) => e.type === 'llm_usage').map((e) => e.payload);
  if (usages.length === 0) return null;
  const last = usages[usages.length - 1]!;
  return {
    prompt_tokens: typeof last['prompt_tokens'] === 'number' ? last['prompt_tokens'] : 0,
    completion_tokens: typeof last['completion_tokens'] === 'number' ? last['completion_tokens'] : 0,
  };
}

/** 长订阅会话：一次 subscribe 贯穿多用户回合（同线程多轮），按事件数组
 *  切点取每回合增量。 */
class LiveSession {
  readonly thread_id: string;
  private readonly _events: RawEvent[] = [];
  private _unsub: (() => void) | null = null;

  constructor(thread_id: string) {
    this.thread_id = thread_id;
  }

  /** 打开 ws 订阅并等订阅建立（ws 异步 onopen → send subscribe；等 400ms
   *  避免回合事件在订阅建立前漏收——回合内 LLM 耗时远大于该窗口）。 */
  async open(channel: ServeChannel): Promise<void> {
    this._unsub = await channel.subscribe(ROUND_EVENT_TOPIC, (raw) => {
      const envelope = raw as unknown as Envelope;
      const event = envelope?.payload;
      if (typeof event === 'object' && event !== null && typeof event['type'] === 'string') {
        this._events.push(event as RawEvent);
      }
    });
    await sleep(400);
  }

  /** 收口订阅（场景结束调用；幂等）。 */
  close(): void {
    if (this._unsub !== null) {
      const fn = this._unsub;
      this._unsub = null;
      fn();
    }
  }

  /** 已收集事件总量（回合增量切点）。 */
  get size(): number {
    return this._events.length;
  }

  /** 全量事件（报告聚合用）。 */
  allEvents(): RawEvent[] {
    return [...this._events];
  }

  /** 发起一个用户回合（同线程；rounds.send）。若回合挂审批卡（review_card /
   *  reason=interrupted），自动 approval.resolve(accept) 重入续跑——保证
   *  回合不悬空。返回回合增量事件。 */
  async round(channel: ServeChannel, prompt: string): Promise<RoundTurn> {
    const start = this._events.length;
    const trace_id = `live-${Date.now().toString(36)}`;
    const round_id = `live-r-${trace_id}`;
    let approvalsResolved = 0;
    let result: SendResult | null = null;
    try {
      result = (await channel.request('rounds.send', {
        input: prompt,
        thread_id: this.thread_id,
        round_id,
        trace_id,
      })) as SendResult;
    } finally {
      await sleep(300); // 让订阅缓冲 flush（与单回合形态同款等待）
    }
    // 审批卡自动 resolve 兜底：仅当本轮出现 review_card 或 reason 带 interrupted
    // 才 resolve（无卡 resolve 会抛 no_pending_approval，故不盲调）
    let guard = 0;
    const reason = String(result?.reason ?? '');
    while (guard < 3 && (reason.includes('interrupt') || this._hasReviewCardSince(start))) {
      guard += 1;
      try {
        await channel.request('approval.resolve', { thread_id: this.thread_id, decision: 'accept' });
        approvalsResolved += 1;
        await sleep(300);
      } catch {
        break; // 卡已失效/已被外部裁决：停止 resolve，保留已采事件
      }
      if (approvalsResolved > 0 && !this._hasReviewCardSince(start)) break;
    }
    const added = this._events.slice(start);
    return { prompt, result, added, approvalsResolved };
  }

  private _hasReviewCardSince(start: number): boolean {
    return this._events.slice(start).some((e) => e.type === 'review_card');
  }
}

/** 场景统计聚合（turns + 全量证据面）。 */
function aggregateScenario(
  turns: RoundTurn[],
  allEvents: RawEvent[],
  checkpointCount: number,
): ScenarioObs {
  const usage = sumLlmUsage(allEvents);
  const turnViews = turns.map((turn, index) => {
    const added = turn.added.filter((e) => e.thread_id !== undefined && e.thread_id !== '');
    const ids = distinctRoundIds(added);
    const applyEndsOk = applyPatchOk(added);
    const replyPreview = added
      .filter((e) => e.type === 'reply_token')
      .map((e) => String(e.payload['token'] ?? ''))
      .join('');
    return {
      index: index + 1,
      prompt: turn.prompt,
      eventCount: added.length,
      roundIds: ids,
      autoRoundIds: ids.filter((rid) => rid.startsWith('auto:')),
      applyStarts: added.filter((e) => isApplyToolEvent(e, 'tool_start')).length,
      applyEnds: added.filter((e) => isApplyToolEvent(e, 'tool_end')).length,
      applyOk: applyEndsOk,
      replyPreview: replyPreview.slice(0, 120),
      reviewCards: added.filter((e) => e.type === 'review_card').length,
      approvalsResolved: turn.approvalsResolved,
      usage: roundUsage(added),
    };
  });
  return {
    userRounds: turns.length,
    checkpoints: checkpointCount,
    events: allEvents,
    llmUsageSum: usage,
    turns: turnViews,
  };
}

/** auto 场景断言项（测试内容标注：每项测什么）。 */
function autoChecks(obs: ScenarioObs, approveMode: boolean): Array<{ name: string; ok: boolean; detail: string }> {
  const items: Array<{ name: string; ok: boolean; detail: string }> = [];
  items.push({ name: 'web transport 直连 serve 可用', ok: true, detail: 'createServeChannel 连接真实 serve' });
  items.push({ name: '同线程多轮（同一 thread 连续发消息）', ok: obs.userRounds >= 2, detail: `${obs.userRounds} 个用户回合 / ${obs.checkpoints} 个 checkpoint（链续聊）` });
  const last = obs.turns.length > 0 ? obs.turns[obs.turns.length - 1]! : null;
  const anyApply = obs.turns.some((t) => t.applyStarts > 0);
  const anyApplyOk = obs.turns.some((t) => t.applyOk);
  items.push({ name: 'agent 调用 apply_patch（工具卡 tool_start）', ok: anyApply, detail: last !== null ? `回合#${last.index} apply_patch tool_start=${last.applyStarts}` : '无回合' });
  items.push({ name: 'apply_patch 落地（tool_end success + ok:true）', ok: anyApplyOk, detail: anyApplyOk ? '落地成功（受控写 ok:true）' : '未观测到落地信号' });
  const anyAuto = obs.turns.some((t) => t.autoRoundIds.length > 0);
  const autoIds = obs.turns.flatMap((t) => t.autoRoundIds);
  items.push({
    name: 'auto 轮出现（round_id 带 auto: 前缀）',
    ok: anyAuto,
    detail: anyAuto ? `auto 轮 round_id：${autoIds.join('、')}` : '无 auto 轮（未触发续跑）',
  });
  items.push({ name: '回合链无 error 事件', ok: !obs.events.some((e) => e.type === 'error'), detail: obs.events.filter((e) => e.type === 'error').length === 0 ? '无' : `${obs.events.filter((e) => e.type === 'error').length} 条` });
  if (approveMode) {
    items.push({ name: 'serve autoApprove 直过生效（无审批卡挂起）', ok: !obs.events.some((e) => e.type === 'review_card'), detail: approveMode ? 'serve 以 --approve 启动（回环测试专用安全面，见报告说明）' : '未用 --approve' });
  }
  return items;
}

/** auto 场景 prompt 构造：让 agent 做一次低风险受控 apply_patch（知识集加一条
 *  template 型条目）。危险面显式排除：不改工具权限/网络/端点/审批/UI 等。
 *  entry.id 带 run token 保证唯一（重复跑不撞既有链条目）。 */
function buildApplyPrompt(entryId: string): string {
  return `【受控 live 自进化验收，测试脚本专用】请对本系统做一次最小受控自进化：
请调用一次 apply_patch 工具向知识集添加一条 template 型知识条目，参数如下（不要省略，不要改动）：
- kind: "knowledge"
- payload: {"entry": {"id": "${entryId}", "level": "work", "kind": "template", "title": "live auto-continue smoke", "data": {"message": "受控 live 验收：auto 续轮测试条目，可安全忽略"}, "credibility": 0.5}}
- rationale: "受控 live 验收（本地回环测试）：最小 knowledge 补丁触发 apply_patch 落地后的 auto 续轮验证"
- base_version 省略（工具会自动取当前集版本）

约束：
1. 只调用 apply_patch 这一次工具；不要调用 propose_patch / inspect_* / revert_patch / 其它任何工具；
2. 禁止改任何权限 / 网络 / 端点 / 审批配置 / UI / theme / tool / rule / environment / entity；
3. apply_patch 返回落地确认后，简短说明已落地即可，不要长篇。`;
}

/** auto 场景重定向 prompt（第一轮 agent 未落地时同线程再发；仍是真实 LLM
 *  路由，只是把参数形态给的更死，降低模型自由发挥空间）。 */
function buildRetryPrompt(entryId: string): string {
  return `上一轮没有观测到 apply_patch 落地。请现在立即只做一件事：把下面这行 JSON 原样作为 apply_patch 的参数调用一次（kind/payload/rationale 逐字段照抄，不要增减）：
{"kind":"knowledge","payload":{"entry":{"id":"${entryId}","level":"work","kind":"template","title":"live auto-continue smoke","data":{"message":"受控 live 验收 auto 续轮"},"credibility":0.5}},"rationale":"受控 live 验收 auto 续轮测试"}
调用后如返回落地（ok:true）就只回复「已落地」三个字，不要再调用任何其它工具。`;
}

/** 受控注入 prompt（兜底）：真实 LLM 连续两轮都不主动调 apply_patch 时使用。
 *  仍走真实 serve + 真实引擎回合（模型只是执行体的回声），把 entry payload
 *  显式内联在用户消息中并要求逐字转成一次 apply_patch 工具调用——验证
 *  apply_patch 落地 → auto 续跑链路在真实 serve 环境成立。 */
function buildInjectPrompt(entryId: string): string {
  return `【受控注入，测试脚本】请把我下面的工具参数逐字转成一次 apply_patch 工具调用（不要增删改字段、不要用其它工具、不要先 propose）：
参数：kind="knowledge"；
payload={"entry":{"id":"${entryId}","level":"work","kind":"template","title":"live auto-continue smoke","data":{"message":"live injection"}}}
rationale="受控注入验收"
调用完成后只回复「ok」。`;
}

/** 真实 auto 场景驱动器：同线程多轮（开场 + 引导 apply + 失败重定向），
 *  断言 apply_patch 落地后出现 auto 轮；报告输出 prompt/轮序/事件数与
 *  auto 轮证据/LLM token 量。 */
async function runAutoScenario(opts: {
  caseId: string;
  approve: boolean;
  forceSpawn: boolean;
  thread: string | null;
}): Promise<void> {
  const url = `http://127.0.0.1:${LIVE_PORT}`;
  process.stdout.write(`[live:auto] 连接 serve（approve=${opts.approve} forceSpawn=${opts.forceSpawn}）\n`);
  const serve = await connectServe(opts.forceSpawn, opts.approve);
  const channel = createServeChannel({ baseUrl: serve.url, token: serve.token }, {
    WebSocketImpl: WebSocket as unknown as new (url: string) => import('../renderer/src/shared/backend/transport.js').ServeWsLike,
  });

  const runToken = Date.now().toString(36);
  const entryId = `live.evo.smoke.${runToken}`;
  const thread_id = opts.thread ?? `live-auto-${runToken}`;
  process.stdout.write(`[live:auto] thread=${thread_id} entry=${entryId}\n`);

  // 落地前 evidence：审计链（kind=knowledge）不含该 entry id（证明 auto 轮的
  // 落地是本轮会话内发生，非历史残留；审计 = 补丁链真源，append-only）
  let kbBefore = '查询失败';
  try {
    const view = (await channel.request('audit.list', { kind: 'knowledge', limit: 50 })) as { records?: Array<Record<string, unknown>> };
    const records = Array.isArray(view?.records) ? view.records : [];
    kbBefore = records.some((rec) => auditEntryId(rec) === entryId) ? '已存在（历史残留）' : '不存在（fresh）';
  } catch {
    kbBefore = '查询失败';
  }

  const session = new LiveSession(thread_id);
  try {
    await session.open(channel);

    const turns: RoundTurn[] = [];

    // 回合 1：同线程开场（建立会话链 + 骨架；无工具）
    process.stdout.write(`[live:auto] 回合1（开场）…\n`);
    turns.push(await session.round(channel, '受控 live 验收（测试脚本）。不需要调用任何工具。请只回复 READY。'));

    // 回合 2：真实引导 apply_patch（主路径）
    process.stdout.write(`[live:auto] 回合2（引导 apply_patch）…\n`);
    const turn2 = await session.round(channel, buildApplyPrompt(entryId));
    turns.push(turn2);

    // 回合 3（条件）：回合2 未见 apply_patch 落地 → 同线程重定向（真实 LLM
    // 再试一次，参数更死）。仍失败 → 回合4 受控注入兜底。
    const landed2 = applyPatchOk(turn2.added) || turn2.added.some((e) => isApplyToolEvent(e, 'tool_end'));
    if (!landed2) {
      process.stdout.write(`[live:auto] 回合2 未观测到 apply_patch 落地，回合3 同线程重定向…\n`);
      const turn3 = await session.round(channel, buildRetryPrompt(entryId));
      turns.push(turn3);
      if (!applyPatchOk(turn3.added)) {
        process.stdout.write(`[live:auto] 回合3 仍未落地，回合4 受控注入兜底…\n`);
        turns.push(await session.round(channel, buildInjectPrompt(entryId)));
      }
    }

    // 会话链 checkpoint 数（含 auto 轮落点）
    let checkpointCount = 0;
    try {
      const view = (await channel.request('records.chain', { thread_id })) as { checkpoints?: unknown };
      checkpointCount = Array.isArray(view?.checkpoints) ? view.checkpoints.length : 0;
    } catch {
      checkpointCount = 0;
    }

    // 落地后 evidence：审计链（kind=knowledge）应含该 entry id 且带已落地 patch
    let kbAfter = '查询失败';
    try {
      const view = (await channel.request('audit.list', { kind: 'knowledge', limit: 50 })) as { records?: Array<Record<string, unknown>> };
      const records = Array.isArray(view?.records) ? view.records : [];
      kbAfter = records.some((rec) => auditEntryId(rec) === entryId)
        ? '已落地（审计链命中）'
        : '不存在';
    } catch {
      kbAfter = '查询失败';
    }

    const allEvents = session.allEvents();
    const obs = aggregateScenario(turns, allEvents, checkpointCount);
    const checksList = autoChecks(obs, opts.approve);
    mkdirSync(REPORT_DIR, { recursive: true });
    const report = buildAutoReport(opts, entryId, kbBefore, kbAfter, obs, checksList);
    const reportFile = path.join(REPORT_DIR, `${opts.caseId}.md`);
    writeFileSync(reportFile, report, 'utf8');
    process.stdout.write(`[live:auto] 报告：${reportFile}\n`);
    process.stdout.write(
      `[live:auto] 事件 ${allEvents.length} 条 / auto 轮 ${obs.turns.some((t) => t.autoRoundIds.length > 0) ? '有' : '无'} / ` +
        `断言 ${checksList.filter((c) => c.ok).length}/${checksList.length} 通过\n`,
    );
    if (checksList.some((c) => !c.ok)) process.exitCode = 1;
  } finally {
    session.close();
    await serve.stop();
  }
}

function buildAutoReport(
  opts: { caseId: string; approve: boolean },
  entryId: string,
  kbBefore: string,
  kbAfter: string,
  obs: ScenarioObs,
  checksList: Array<{ name: string; ok: boolean; detail: string }>,
): string {
  const pass = checksList.filter((c) => c.ok).length;
  const checkLine = checksList.map((c) => `- ${c.ok ? '✅' : '❌'} **${c.name}**：${c.detail}`).join('\n');
  const turnLines = obs.turns
    .map((t) => {
      return `| #${t.index} | ${esc(t.prompt.slice(0, 60))}${t.prompt.length > 60 ? '…' : ''} | ${t.eventCount} | ${t.roundIds.join('<br>')} | ${t.autoRoundIds.length > 0 ? t.autoRoundIds.join('<br>') : '（无）'} | ${t.applyStarts} / ${t.applyEnds} | ${t.applyOk ? '✅' : '—'} | ${t.reviewCards} | ${t.approvalsResolved} | ${t.usage === null ? '无' : `${t.usage.prompt_tokens}+${t.usage.completion_tokens}`} | ${t.replyPreview || '（无 reply_token）'} |`;
    })
    .join('\n');
  const autoRounds = obs.turns.filter((t) => t.autoRoundIds.length > 0);
  return `# Live auto 续轮报告：${opts.caseId}

> 本报告自动生成（\`live/run_live.ts --scenario auto\`），多轮运行覆盖重写。

## 测试内容标注（本用例验证什么）
- **同线程多轮**：同一 \`thread_id\` 连续 \`rounds.send\`（本报告 ${obs.userRounds} 个用户回合 / ${obs.checkpoints} 个 checkpoint，消息链随 checkpoint 续聊）。
- **审批卡自动 resolve**：serve 非 autoApprove 时回合挂卡（review_card）→ 脚本 \`approval.resolve(accept)\` 重入续跑（本报告 resolve 次数见逐回合列）。
- **auto 直过配置**：serve 以 \`--approve\` 启动 = \`autoApprove=true\`（宿主 interrupt_policy 全量直过）。安全面：\`--approve\` 仅用于 **127.0.0.1 本地回环 live 测试**，生产保持 fail-closed 缺省；本用例 prompt 只做低风险 knowledge 知识补丁，禁止触碰权限/网络/端点/审批/UI 等危险面。
- **真实 auto 续轮**：prompt 引导 agent 用 \`apply_patch\` 落地一条低风险 \`knowledge\`（template 型）条目 → 断言落地（tool_end success + ok:true）后出现 auto 轮（事件 \`round_id\` 带 \`auto:\` 前缀）。auto 轮由引擎 \`assemble_round\` 同一 RPC 内自续（护栏 = 配方 \`auto_continue_limit=3\`），因此单个 \`rounds.send\` 的事件流内即可观测 apply 轮 + auto 轮多个 round_id。
- **注入条目**：\`${entryId}\`（run token 保证唯一）
- **落地前 / 落地后** 审计链（kind=knowledge payload.entry.id 匹配）：\`${kbBefore}\` / \`${kbAfter}\`

## 断言结果（${pass}/${checksList.length}）
${checkLine}

## 逐回合观测（apply 轮 + auto 轮都落在对应 rounds.send 事件流内）
| 回合 | prompt（截断） | 事件数 | round_id（按序） | auto 轮 round_id | apply tool_start/end | apply 落地(ok:true) | 审批卡 | resolve 次数 | LLM usage(p+c) | reply 预览 |
|---|---|---|---|---|---|---|---|---|---|---|
${turnLines}

## 全会话聚合
| 观测项 | 值 |
|---|---|
| 用户回合数 | ${obs.userRounds} |
| 会话链 checkpoint 数 | ${obs.checkpoints} |
| 事件总数 | ${obs.events.length} |
| auto 轮出现 | ${autoRounds.length > 0 ? '✅ ' + autoRounds.map((t) => t.autoRoundIds.join('、')).join('；') : '❌ 无'} |
| LLM usage（事件近似累计） | prompt=${obs.llmUsageSum.prompt_tokens} / completion=${obs.llmUsageSum.completion_tokens} / llm_usage 事件 ${obs.llmUsageSum.calls} 条 |
| 错误 | ${obs.events.filter((e) => e.type === 'error').length} 条 |

## 事件类型分布（全会话）
${Object.entries(obs.events.reduce<Record<string, number>>((a, e) => { a[e.type] = (a[e.type] ?? 0) + 1; return a; }, {})).sort((x, y) => y[1] - x[1]).map(([t, n]) => `${t}（${n}）`).join('、')}

## 安全面说明
- 本场景 serve 以 \`--approve\`（autoApprove=true）启动：仅限 127.0.0.1 回环 live 测试（\`live/serve_live.ts\` / \`run_live.ts --force-spawn --approve\`）。
- 产品侧审批缺省 fail-closed（\`host.interrupt_policy\`：autoApprove 仅显式 true 才直过）；本报告不代表产品审批策略变更。
- 注入/落地数据限 \`.dev-data/kilo-cli\` 本地测试知识集（template 条目，可随时经审计链回退）。
`;
}
// ────────────────────────────────────────────────────────────────────────────
// 形态三：live 图架构多样观察（--scenario observe）
// 只读观察（产品代码零改动；本文件 = 脚本扩展面）：复用同线程 rounds.send
// 链路，逐用户回合记录——事件流逐 round 执行实例集/组装候选链（assembly_candidate
// 只出现在真组装轮）+ graph.instance 最近回合组装图节点/边快照。验证 P4.2a-3
// 落地后「组装图是否随目标变化、由哪些可区分实例/边组成」。
// ────────────────────────────────────────────────────────────────────────────

/** 观察会话计划（一个不同目标 = 一个独立 thread 会话）。 */
interface ObserveSessionPlanItem {
  name: string;
  goal: string;
  prompts: string[];
  /** prompts 中 apply_patch 引导轮下标（无 = -1）；落地失败自动追加重定向/注入兜底。 */
  applyPromptIndex: number;
}

/** 单个 round（用户轮内可能含多个子轮：apply 轮 + auto 轮）的执行观测。 */
interface RoundExec {
  round_id: string;
  auto: boolean;
  assembly: boolean;
  chains: string[][];
  executed: string[];
  tools: string[];
  llm_calls: number;
  prompt_tokens: number;
  completion_tokens: number;
}

/** graph.instance 快照（最近回合组装图投影 + 最近一回合节点执行态）。 */
interface ObserveGraphView {
  thread_id: string;
  round_id: string | null;
  nodes: Array<{ id: string; type: string }>;
  edges: Array<{ from: string; to: string; condition?: string }>;
  node_status: Record<string, string>;
  auto_round: boolean;
  continuation_reason: string | null;
  degraded: boolean;
  degraded_reason: string | null;
}

/** 一个用户回合（一次 rounds.send）的完整观测。 */
interface ObserveTurn {
  turnIndex: number;
  prompt: string;
  reason: string;
  replyPreview: string;
  approvalsResolved: number;
  rounds: RoundExec[];
  view: ObserveGraphView | null;
  checkpointCount: number;
  applyLanded: boolean;
}

interface ObserveSessionResult {
  plan: ObserveSessionPlanItem;
  thread_id: string;
  turns: ObserveTurn[];
  allEvents: RawEvent[];
  applyLanded: boolean;
  sawAuto: boolean;
  autoRoundIds: string[];
  fallbackUsed: string | null;
  usage: { prompt_tokens: number; completion_tokens: number; calls: number };
}

/** 观察会话矩阵（3 个不同目标：简单问答 / 需计划再答复 / 工具型 apply_patch
 *  → auto 续轮；prompt 最小成本可判读）。 */
function buildObservePlan(entryId: string): ObserveSessionPlanItem[] {
  const applyPrompt = buildApplyPrompt(entryId);
  return [
    {
      name: 's1-simple-qa',
      goal: '简单问答（单轮直接答复，无工具）',
      prompts: ['1+1 等于几？请用一句话回答，不要调用任何工具。'],
      applyPromptIndex: -1,
    },
    {
      name: 's2-plan-then-answer',
      goal: '需先计划再答复的任务（同线程 2 轮）',
      prompts: [
        '请先制定一个简短的分步计划（3 行以内），再按计划给出最终答复。问题：编程零基础者如何在一周内入门 Python？不要调用工具。',
        '按你刚才给出的计划：哪一步最容易失败？请用一句话指出，并给一句替代建议。不要调用工具。',
      ],
      applyPromptIndex: -1,
    },
    {
      name: 's3-tool-evo',
      goal: '工具型任务（apply_patch 落地 → auto 续轮 → 会话内后续回合）',
      prompts: [
        '受控 live 观察开场。不需要调用任何工具，请只回复 READY。',
        applyPrompt,
        '请用一两句话总结你刚才向知识集落地了什么。不要调用工具。',
      ],
      applyPromptIndex: 1,
    },
  ];
}

/** 读取 graph.instance（最近回合组装图投影）；失败 = null（不击穿观察）。 */
async function readGraphView(
  channel: ServeChannel,
  thread_id: string,
): Promise<ObserveGraphView | null> {
  try {
    const raw = (await channel.request('graph.instance', { thread_id })) as Record<string, unknown>;
    if (typeof raw !== 'object' || raw === null) return null;
    const graph = (raw['graph'] ?? {}) as Record<string, unknown>;
    const nodeRows = Array.isArray(graph['nodes']) ? (graph['nodes'] as Array<Record<string, unknown>>) : [];
    const edgeRows = Array.isArray(graph['edges']) ? (graph['edges'] as Array<Record<string, unknown>>) : [];
    const nodes = nodeRows
      .map((r) => ({ id: String(r['id'] ?? ''), type: String(r['type'] ?? 'unknown') }))
      .filter((n) => n.id !== '');
    const edges = edgeRows
      .map((r) => {
        const edge: { from: string; to: string; condition?: string } = {
          from: String(r['from'] ?? ''),
          to: String(r['to'] ?? ''),
        };
        if (r['condition'] !== undefined && r['condition'] !== null && String(r['condition']) !== '') {
          edge.condition = String(r['condition']);
        }
        return edge;
      })
      .filter((e) => e.from !== '' && e.to !== '');
    return {
      thread_id: String(raw['thread_id'] ?? thread_id),
      round_id: raw['round_id'] === null || raw['round_id'] === undefined ? null : String(raw['round_id']),
      nodes,
      edges,
      node_status: (raw['node_status'] ?? {}) as Record<string, string>,
      auto_round: raw['auto_round'] === true,
      continuation_reason:
        raw['continuation_reason'] === null || raw['continuation_reason'] === undefined
          ? null
          : String(raw['continuation_reason']),
      degraded: raw['degraded'] === true,
      degraded_reason:
        raw['degraded_reason'] === null || raw['degraded_reason'] === undefined
          ? null
          : String(raw['degraded_reason']),
    };
  } catch {
    return null;
  }
}

/** records.chain checkpoint 数（链长观测；失败 = 0）。 */
async function readChainCount(channel: ServeChannel, thread_id: string): Promise<number> {
  try {
    const raw = (await channel.request('records.chain', { thread_id })) as { checkpoints?: unknown } | null;
    return Array.isArray(raw?.checkpoints) ? raw.checkpoints.length : 0;
  } catch {
    return 0;
  }
}

/** 事件流 → 逐 round 执行观测（llm_usage 事件数 = LLM 调用次数近似）。 */
function roundExecs(events: RawEvent[]): RoundExec[] {
  const ids = distinctRoundIds(events);
  const rows: RoundExec[] = [];
  for (const round_id of ids) {
    const es = events.filter((e) => e.round_id === round_id);
    const executed = [
      ...new Set(es.map((e) => e.node).filter((n): n is string => typeof n === 'string' && n !== '')),
    ];
    const tools = [
      ...new Set(
        es
          .filter((e) => e.type === 'tool_start')
          .map((e) => String(e.payload['tool'] ?? ''))
          .filter((t) => t !== ''),
      ),
    ];
    const chains: string[][] = es
      .filter((e) => e.type === 'assembly_candidate')
      .map((e) => {
        const c = e.payload['chain'];
        return Array.isArray(c) ? c.map((v) => String(v)).filter((v) => v !== '') : [];
      })
      .filter((c) => c.length > 0);
    let llmCalls = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    for (const e of es) {
      if (e.type !== 'llm_usage') continue;
      llmCalls += 1;
      const p = e.payload;
      promptTokens += typeof p['prompt_tokens'] === 'number' ? p['prompt_tokens'] : 0;
      completionTokens += typeof p['completion_tokens'] === 'number' ? p['completion_tokens'] : 0;
    }
    rows.push({
      round_id,
      auto: round_id.startsWith('auto:'),
      assembly: es.some((e) => e.type === 'assembly_started'),
      chains,
      executed,
      tools,
      llm_calls: llmCalls,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
    });
  }
  return rows;
}

/** 一次用户回合快照（round + graph.instance + 链 checkpoint 数）。 */
async function snapObserveTurn(
  channel: ServeChannel,
  session: LiveSession,
  prompt: string,
  turnIndex: number,
): Promise<ObserveTurn> {
  const ran = await session.round(channel, prompt);
  const added = ran.added;
  const view = await readGraphView(channel, session.thread_id);
  const checkpointCount = await readChainCount(channel, session.thread_id);
  const rounds = roundExecs(added);
  const replyPreview = added
    .filter((e) => e.type === 'reply_token')
    .map((e) => String(e.payload['token'] ?? ''))
    .join('');
  const applyLanded = applyPatchOk(added) || added.some((e) => isApplyToolEvent(e, 'tool_end'));
  return {
    turnIndex,
    prompt,
    reason: String(ran.result?.['reason'] ?? ''),
    replyPreview,
    approvalsResolved: ran.approvalsResolved,
    rounds,
    view,
    checkpointCount,
    applyLanded,
  };
}

/** 组装图快照的规范组成键（节点实例 + 边；用于跨轮/跨会话同构比较）。 */
function viewCompKey(view: ObserveGraphView | null): string {
  if (view === null) return '（无快照）';
  const nodes = [...view.nodes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((n) => (n.id === n.type ? n.id : `${n.id}(${n.type})`))
    .join(',');
  const edges = [...view.edges]
    .sort((a, b) => `${a.from}>${a.to}`.localeCompare(`${b.from}>${b.to}`))
    .map((e) => `${e.from}→${e.to}`)
    .join(',');
  return `${nodes} || ${edges}`;
}

/** 观察驱动器：逐会话逐轮运行 + 快照；报告落到 report/<case>.md。 */
async function runObserveScenario(opts: {
  caseId: string;
  approve: boolean;
  forceSpawn: boolean;
  thread: string | null;
}): Promise<void> {
  process.stdout.write(`[live:observe] 连接 serve（approve=${opts.approve} forceSpawn=${opts.forceSpawn}）\n`);
  const serve = await connectServe(opts.forceSpawn, opts.approve);
  const channel = createServeChannel({ baseUrl: serve.url, token: serve.token }, {
    WebSocketImpl: WebSocket as unknown as new (url: string) => import('../renderer/src/shared/backend/transport.js').ServeWsLike,
  });
  const runToken = Date.now().toString(36);
  const entryId = `live.observe.evo.${runToken}`;
  const plan = buildObservePlan(entryId);
  const results: ObserveSessionResult[] = [];
  const totalUsage = { prompt_tokens: 0, completion_tokens: 0, calls: 0 };
  try {
    for (const item of plan) {
      const thread_id = opts.thread ?? `live-obs-${item.name}-${runToken}`;
      process.stdout.write(`[live:observe] 会话 ${item.name} thread=${thread_id}\n`);
      const session = new LiveSession(thread_id);
      const turns: ObserveTurn[] = [];
      let fallbackUsed: string | null = null;
      try {
        await session.open(channel);
        for (let i = 0; i < item.prompts.length; i += 1) {
          const prompt = item.prompts[i]!;
          process.stdout.write(`[live:observe] 会话 ${item.name} 用户轮 ${turns.length + 1}…\n`);
          const turn = await snapObserveTurn(channel, session, prompt, turns.length + 1);
          turns.push(turn);
          if (i === item.applyPromptIndex && !turn.applyLanded) {
            fallbackUsed = 'retry';
            process.stdout.write(`[live:observe] 会话 ${item.name} apply 未落地，追加同线程重定向轮…\n`);
            turns.push(await snapObserveTurn(channel, session, buildRetryPrompt(entryId), turns.length + 1));
          }
        }
        if (item.applyPromptIndex >= 0 && !turns.some((t) => t.applyLanded)) {
          fallbackUsed = fallbackUsed === null ? 'inject' : `${fallbackUsed}+inject`;
          process.stdout.write(`[live:observe] 会话 ${item.name} 仍未落地，受控注入兜底…\n`);
          turns.push(await snapObserveTurn(channel, session, buildInjectPrompt(entryId), turns.length + 1));
        }
      } finally {
        session.close();
      }
      const allEvents = session.allEvents();
      const usage = sumLlmUsage(allEvents);
      const autoIds = autoRoundIdsOf(allEvents);
      const applyLanded = allEvents.some((e) => isApplyToolEvent(e, 'tool_end') && e.payload['success'] === true);
      totalUsage.prompt_tokens += usage.prompt_tokens;
      totalUsage.completion_tokens += usage.completion_tokens;
      totalUsage.calls += usage.calls;
      results.push({
        plan: item,
        thread_id,
        turns,
        allEvents,
        applyLanded,
        sawAuto: autoIds.length > 0,
        autoRoundIds: autoIds,
        fallbackUsed,
        usage,
      });
      process.stdout.write(
        `[live:observe] 会话 ${item.name} 完成：用户轮 ${turns.length}，事件 ${allEvents.length}，` +
          `llm_usage ${usage.calls} 条\n`,
      );
    }
  } finally {
    await serve.stop();
  }
  const report = buildObserveReport(opts, entryId, results, totalUsage);
  mkdirSync(REPORT_DIR, { recursive: true });
  const reportFile = path.join(REPORT_DIR, `${opts.caseId}.md`);
  writeFileSync(reportFile, report, 'utf8');
  process.stdout.write(`[live:observe] 报告：${reportFile}\n`);
  process.stdout.write(
    `[live:observe] 会话 ${results.length}/${plan.length} 跑通；总 llm_usage ${totalUsage.calls} 条 / ` +
      `prompt=${totalUsage.prompt_tokens} / completion=${totalUsage.completion_tokens}\n`,
  );
}

/** 组装候选链格式（按 rank 序；assembly_candidate 事件序 = rank 序）。 */
function fmtChains(chains: string[][]): string {
  if (chains.length === 0) return '—';
  return chains.map((c, i) => `#${i + 1} ${c.join('→')}`).join('；');
}

/** 逐轮执行集格式（实例名 → 连接）。 */
function fmtExecuted(executed: string[]): string {
  return executed.length === 0 ? '（无节点事件）' : executed.join('→');
}

/** 逐会话逐轮图组成表（子轮维度；快照 = 用户轮收尾时最近回合组装图）。 */
function sessionCompositionMd(result: ObserveSessionResult): string {
  const lines: string[] = [];
  lines.push(`### 会话 ${result.plan.name}：${result.plan.goal}`);
  lines.push('');
  lines.push(`- thread：\`${result.thread_id}\``);
  lines.push(`- 会话骨架/自续路径：apply 落地 ${result.applyLanded ? '✅' : '—'} / auto 轮 ${result.sawAuto ? '✅ ' + result.autoRoundIds.join('、') : '—'} / 兜底 ${result.fallbackUsed ?? '无'}`);
  lines.push(`- LLM usage（llm_usage 事件近似）：prompt=${result.usage.prompt_tokens} / completion=${result.usage.completion_tokens} / ${result.usage.calls} 条`);
  lines.push('');
  const comps: string[] = [];
  for (const turn of result.turns) {
    comps.push(viewCompKey(turn.view));
  }
  const uniqueComps = [...new Set(comps)];
  const stable = uniqueComps.length <= 1;
  lines.push(`- 跨轮图快照同构：${stable ? '是（全部一致）' : `否（${uniqueComps.length} 种）`}`);
  lines.push('');
  for (const turn of result.turns) {
    lines.push(`#### 用户轮 #${turn.turnIndex}（checkpoint→${turn.checkpointCount}；reason=\`${turn.reason}\`${turn.approvalsResolved > 0 ? `；审批 resolve ×${turn.approvalsResolved}` : ''}）`);
    lines.push('');
    lines.push(`- prompt：${esc(turn.prompt.slice(0, 140))}${turn.prompt.length > 140 ? '…' : ''}`);
    if (turn.replyPreview !== '') {
      lines.push(`- reply 预览：${esc(turn.replyPreview.slice(0, 160))}`);
    }
    const view = turn.view;
    if (view === null) {
      lines.push('- 图快照：读取失败');
    } else {
      const nodeText = view.nodes.length === 0 ? '（空）' : view.nodes.map((n) => (n.id === n.type ? `\`${n.id}\`` : `\`${n.id}\`(${n.type})`)).join('、');
      const edgeText = view.edges.length === 0 ? '（无边）' : view.edges.map((e) => `\`${e.from}→${e.to}\`${e.condition !== undefined ? `〔${e.condition}〕` : ''}`).join('、');
      lines.push(`- 图快照 round_id=\`${view.round_id ?? 'null'}\`${view.auto_round ? '（auto 轮）' : ''}${view.continuation_reason !== null ? ` continuation=${view.continuation_reason}` : ''}${view.degraded ? `（degraded:${view.degraded_reason ?? ''}）` : ''}`);
      lines.push(`  - 节点实例（id/type）：${nodeText}`);
      lines.push(`  - 边集：${edgeText}`);
      if (Object.keys(view.node_status).length > 0) {
        lines.push(`  - 该轮执行态（node_status）：${Object.entries(view.node_status).map(([k, v]) => `${k}=${v}`).join('、')}`);
      }
    }
    lines.push('');
    lines.push('| 子轮 round_id | auto | 组装 | 候选链（rank 序） | 执行实例 | 工具 | LLM 调用 | usage(p+c) |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const round of turn.rounds) {
      const chainCol = round.assembly ? fmtChains(round.chains) : '（沿骨架/无组装动作）';
      const toolCol = round.tools.length === 0 ? '—' : round.tools.join('、');
      lines.push(
        `| \`${round.round_id}\` | ${round.auto ? 'auto' : '—'} | ${round.assembly ? '✅' : '—'} | ${chainCol} | ${fmtExecuted(round.executed)} | ${toolCol} | ${round.llm_calls} | ${round.prompt_tokens}+${round.completion_tokens} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** 观察报告构建（数据表 + 汇总；结论定稿见人工分析节）。 */
function buildObserveReport(
  opts: { caseId: string; approve: boolean },
  entryId: string,
  results: ObserveSessionResult[],
  totalUsage: { prompt_tokens: number; completion_tokens: number; calls: number },
): string {
  const lines: string[] = [];
  lines.push(`# Live 图架构多样观察报告：${opts.caseId}`);
  lines.push('');
  lines.push('> 本报告由 `live/run_live.ts --scenario observe` 生成（只读观察，产品代码零改动；脚本层扩展点 = run_live.ts 形态三）。');
  lines.push('');
  lines.push('## 测试内容标注（本观察验证什么）');
  lines.push('- 验证 P4.2a-3 落地后「组装图是否随目标变化、由哪些可区分实例/边组成」：出厂池 7 条可区分实例（llm_decider / llm_planner(llm,plan) / llm_reviewer(读 plan,review) / llm_main(读 plan+review,reply) / tool_pipeline / router_judge / router_plan_judge）+ 出厂边先验 seed_edges（默认关）。');
  lines.push('- 链路：web transport（createServeChannel）→ cli serve（127.0.0.1:18740，`--approve` 回环测试安全面）→ engine 回合（组装/骨架推进）→ 真实 LLM（`.dev-data/kilo-cli/config.json`）→ 事件回流。');
  lines.push('- 逐用户回合记录：事件流逐 round 执行实例集 / 组装候选链（assembly_candidate 仅在真组装轮出现）+ `graph.instance` 最近回合组装图节点/边快照。');
  lines.push(`- 注入知识条目：\`${entryId}\`（run token 唯一；只落本地 \`.dev-data/kilo-cli\` 测试知识集 template 条目）。`);
  lines.push('');
  lines.push('## 会话矩阵（3 个不同目标）');
  lines.push('');
  lines.push('| 会话 | 目标 | 用户轮 | 子轮总数 | 组装轮 | auto 轮 | apply 落地 | 跨轮图同构 | LLM usage(p+c) |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const result of results) {
    const turnViews = result.turns.map((t) => t.view);
    const uniqueViews = new Set(turnViews.map((v) => viewCompKey(v))).size;
    const subRounds = result.turns.reduce((acc, t) => acc + t.rounds.length, 0);
    const assemblyRounds = result.turns.reduce((acc, t) => acc + t.rounds.filter((r) => r.assembly).length, 0);
    const autoRounds = result.turns.reduce((acc, t) => acc + t.rounds.filter((r) => r.auto).length, 0);
    lines.push(
      `| ${result.plan.name} | ${esc(result.plan.goal)} | ${result.turns.length} | ${subRounds} | ${assemblyRounds} | ${autoRounds} | ${result.applyLanded ? '✅' : '—'} | ${uniqueViews <= 1 ? '是' : `否(${uniqueViews})`} | ${result.usage.prompt_tokens}+${result.usage.completion_tokens} |`,
    );
  }
  lines.push('');
  lines.push('## LLM usage 汇总');
  lines.push('');
  lines.push(`| 观测项 | 值 |`);
  lines.push('|---|---|');
  lines.push(`| llm_usage 事件（≈LLM 调用次数） | ${totalUsage.calls} |`);
  lines.push(`| prompt_tokens（近似累计） | ${totalUsage.prompt_tokens} |`);
  lines.push(`| completion_tokens（近似累计） | ${totalUsage.completion_tokens} |`);
  lines.push(`| serve 姿态 | ${opts.approve ? '--approve（autoApprove 直过；仅 127.0.0.1 回环 live 测试）' : '非 approve'}` );
  lines.push('');
  for (const result of results) {
    lines.push(sessionCompositionMd(result));
  }
  lines.push('## 观察结论（人工定稿）');
  lines.push('');
  lines.push('_待定稿：基于上方逐轮数据填写「是否多样 / 随目标变化 / 恒同构推断 / 字段链佐证 / 遗留建议」。_');
  lines.push('');
  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────────────────
// CLI 参数解析与分发
// ────────────────────────────────────────────────────────────────────────────

interface CliOpts {
  caseId: string;
  prompt: string;
  forceTool: boolean;
  forceSpawn: boolean;
  approve: boolean;
  scenario: string | null;
  thread: string | null;
}

/** 取带值 flag（`--flag value` / `--flag=value`）并移出 args。 */
function takeFlagValue(args: string[], flag: string): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] as string;
    if (token === flag) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        process.stderr.write(`${flag} 需带参数值\n`);
        process.exit(2);
        throw new Error(`${flag} 缺参数值`);
      }
      args.splice(i, 2);
      return value;
    }
    if (token.startsWith(`${flag}=`)) {
      const value = token.slice(flag.length + 1);
      args.splice(i, 1);
      return value;
    }
  }
  return null;
}

/** 去布尔 flag（`--flag`）并移出 args。 */
function takeBoolFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function parseCli(argv: string[]): CliOpts {
  const args = [...argv];
  const caseValue = takeFlagValue(args, '--case');
  const scenarioValue = takeFlagValue(args, '--scenario');
  const threadValue = takeFlagValue(args, '--thread');
  const forceSpawn = takeBoolFlag(args, '--force-spawn');
  const approve = takeBoolFlag(args, '--approve');
  const forceTool = takeBoolFlag(args, '--tool');
  const caseId = caseValue ?? (scenarioValue !== null ? scenarioValue : 'live');
  return {
    caseId,
    prompt: args.join(' '),
    forceTool,
    forceSpawn,
    approve,
    scenario: scenarioValue,
    thread: threadValue,
  };
}

/** 形态一：单回合冒烟（原行为）。 */
async function runSingleShot(opts: CliOpts): Promise<void> {
  const { prompt } = opts;
  const serve = await connectServe(opts.forceSpawn, opts.approve);
  process.stdout.write(`serve ${serve.url}（token=${serve.token.split('-')[0]}…）\n`);
  const channel = createServeChannel({ baseUrl: serve.url, token: serve.token }, {
    WebSocketImpl: WebSocket as unknown as new (url: string) => import('../renderer/src/shared/backend/transport.js').ServeWsLike,
  });
  try {
    const events: RawEvent[] = [];
    const unsubscribe = await channel.subscribe(ROUND_EVENT_TOPIC, (raw) => {
      const envelope = raw as unknown as Envelope;
      const event = envelope?.payload;
      if (typeof event === 'object' && event !== null && typeof event['type'] === 'string') {
        events.push(event as RawEvent);
      }
    });
    const trace_id = `live-${Date.now().toString(36)}`;
    const thread_id = `live-t-${trace_id}`;
    const round_id = `live-r-${trace_id}`;
    let result: SendResult | null = null;
    try {
      result = (await channel.request('rounds.send', {
        input: prompt,
        thread_id,
        round_id,
        trace_id,
      })) as SendResult;
    } finally {
      await sleep(300);
      await unsubscribe();
    }
    const obs = observe(events, result as Record<string, unknown> | null);
    const checksList = checks(obs, opts.forceTool);
    mkdirSync(REPORT_DIR, { recursive: true });
    const report = buildReport(opts.caseId, prompt, obs, checksList);
    const reportFile = path.join(REPORT_DIR, `${opts.caseId}.md`);
    writeFileSync(reportFile, report, 'utf8');
    process.stdout.write(`报告：${reportFile}\n`);
    process.stdout.write(`事件：${events.length} 条 / 断言 ${checksList.filter((c) => c.ok).length}/${checksList.length} 通过\n`);
    if (checksList.some((c) => !c.ok)) process.exitCode = 1;
  } finally {
    await serve.stop();
  }
}

async function main(): Promise<void> {
  const opts = parseCli(process.argv.slice(2));
  if (opts.scenario !== null && opts.scenario !== 'auto' && opts.scenario !== 'observe') {
    process.stderr.write(`未知 --scenario：${opts.scenario}（当前支持：auto / observe）\n`);
    process.exitCode = 2;
    return;
  }
  if (opts.scenario === 'auto') {
    await runAutoScenario(opts);
    return;
  }
  if (opts.scenario === 'observe') {
    await runObserveScenario(opts);
    return;
  }
  if (!opts.prompt) {
    process.stderr.write('用法：npx tsx live/run_live.ts [--case <id>] <prompt> [--tool] [--force-spawn] [--approve]\n');
    process.stderr.write('       npx tsx live/run_live.ts --scenario auto [--case <id>] [--force-spawn] [--approve]\n');
    process.stderr.write('       npx tsx live/run_live.ts --scenario observe [--case <id>] [--force-spawn] [--approve]\n');
    process.exitCode = 2;
    return;
  }
  await runSingleShot(opts);
}

main().catch((err) => {
  process.stderr.write(`[live] 运行失败：${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
