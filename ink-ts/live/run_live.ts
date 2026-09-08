/**
 * live 端到端真实链路冒烟（web 协议层直连，无需浏览器）。
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
 *  - 断言目标：thinking_start→thinking_end 发射、reply_token 发射、tool_start/
 *    tool_end 成对、无错误、exit 0（工具调用类 prompt 会触发工具卡，验证我这次
 *    改动的引擎侧事件发射在真实链路生效）。
 *
 * 流程：
 *  1. spawn `tsx bootstrap/main.ts serve`（data_dir = .dev-data/kilo-cli，
 *     复用持久化 model_config 装配真实模型；回环随机端口 + 随机 token）
 *  2. 读 serve listen 行（url/ws/token）
 *  3. createServeChannel + 订阅 round_event（含 events.* / state.*）
 *  4. rounds.send 发回合（wait 事件流）
 *  5. 解析事件 → 生成 live/report/<case>.md（每用例一份，多轮覆盖重写）
 *
 * 用法：npx tsx live/run_live.ts <case-id> <prompt> [--tool]
 *   --tool  强制断言工具卡（prompt 应触发工具调用时用）
 */

import { spawn, type ChildProcess } from 'node:child_process';
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

/** 连接 live serve：默认仅探测复用（需已启动常驻 serve，见 live/serve_live.ts）。
 *  --force-spawn 时 spawn 一次（用完关停；不常驻）。 */
async function connectServe(forceSpawn: boolean): Promise<{ url: string; ws: string; token: string; stop: () => Promise<void> }> {
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
  // --force-spawn：临时拉起，本脚本结束关停（不进常驻/不复用）
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', SERVE_ENTRY, 'serve', '--port', String(LIVE_PORT), '--token', LIVE_TOKEN, '--data-dir', CONFIG_DIR], {
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

/** 用 web 前端同款 transport 连 serve：订阅事件流 + rounds.send 发回合。 */
async function runWebRound(
  channel: ServeChannel,
  prompt: string,
): Promise<{ events: RawEvent[]; result: Record<string, unknown> | null }> {
  const events: RawEvent[] = [];
  let resolveDone: (() => void) | null = null;
  const done = new Promise<void>((r) => { resolveDone = r; });

  // 事件归约（web 前端 eventIngest 位于 renderer/src/shared/session/eventIngest.ts；
  // 此处只做采集 + 状态观测统计，不复制归约逻辑）
  const unsubscribe = await channel.subscribe(ROUND_EVENT_TOPIC, (raw) => {
    const envelope = raw as unknown as Envelope;
    const event = envelope?.payload;
    if (typeof event === 'object' && event !== null && typeof event['type'] === 'string') {
      events.push(event as RawEvent);
      if (event['type'] === 'turn_started') {
        // 回合结束由 rounds.send 解析结果确认（见下）
      }
    }
  });

  const trace_id = `live-${Date.now().toString(36)}`;
  const thread_id = `live-t-${trace_id}`;
  const round_id = `live-r-${trace_id}`;
  let result: Record<string, unknown> | null = null;
  try {
    result = (await channel.request('rounds.send', {
      input: prompt,
      thread_id,
      round_id,
      trace_id,
    })) as Record<string, unknown>;
  } finally {
    // rounds.send 返回后事件已齐；让订阅缓冲 flush
    await new Promise((r) => setTimeout(r, 200));
    await unsubscribe();
    resolveDone?.();
  }
  await done;
  return { events, result };
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
  const plannedEvents = events.filter((e) => e.type === 'plan_start');

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
    plan: plannedEvents.length,
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
  const eventTable = ''; // 事件表可选；此处聚焦统计（完整帧见 data_dir/events jsonl）
  void eventTable;
  void obs;
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
| plan_start 计划 | ${obs.plan} |
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const toolIdx = args.indexOf('--tool');
  const forceTool = toolIdx >= 0;
  if (toolIdx >= 0) args.splice(toolIdx, 1);
  // --force-spawn：跳过复用，强制 spawn 新 serve（改模型配置后重装配用）
  const spawnIdx = args.indexOf('--force-spawn');
  const forceSpawn = spawnIdx >= 0;
  if (spawnIdx >= 0) args.splice(spawnIdx, 1);
  // --case <id>：报告名（缺省 live → 反复运行覆盖 live/report/live.md）
  let caseId = 'live';
  const caseIdx = args.indexOf('--case');
  if (caseIdx >= 0) {
    const value = args[caseIdx + 1];
    if (value === undefined || value.startsWith('--')) {
      process.stderr.write('--case 需带报告名参数\n');
      process.exitCode = 2;
      return;
    }
    caseId = value;
    args.splice(caseIdx, 2);
  }
  const prompt = args.join(' ');
  if (!prompt) {
    process.stderr.write('用法：npx tsx live/run_live.ts [--case <id>] <prompt> [--tool] [--force-spawn]\n');
    process.stderr.write('  --case 报告名缺省 live（反复运行覆盖 live/report/live.md）\n');
    process.exitCode = 2;
    return;
  }

  const serve = await connectServe(forceSpawn);
  process.stdout.write(`serve ${serve.url}（token=${serve.token.split('-')[0]}…）\n`);
  const channel = createServeChannel({ baseUrl: serve.url, token: serve.token }, {
    WebSocketImpl: WebSocket as unknown as new (url: string) => import('../renderer/src/shared/backend/transport.js').ServeWsLike,
  });
  try {
    const { events, result } = await runWebRound(channel, prompt);
    const obs = observe(events, result);
    const checksList = checks(obs, forceTool);
    mkdirSync(REPORT_DIR, { recursive: true });
    const report = buildReport(caseId, prompt, obs, checksList);
    const reportFile = path.join(REPORT_DIR, `${caseId}.md`);
    writeFileSync(reportFile, report, 'utf8');
    process.stdout.write(`报告：${reportFile}\n`);
    process.stdout.write(`事件：${events.length} 条 / 断言 ${checksList.filter((c) => c.ok).length}/${checksList.length} 通过\n`);
    if (checksList.some((c) => !c.ok)) process.exitCode = 1;
  } finally {
    await serve.stop();
  }
}

main().catch((err) => {
  process.stderr.write(`[live] 运行失败：${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
