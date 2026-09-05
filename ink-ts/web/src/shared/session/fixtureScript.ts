/**
 * 夹具会话驱动（演示形态）：脚本化回合事件流 → ChannelHub。
 *
 * 集成期替换为真实事件源（SSE/宿主桥）——驱动接口 = dispatch(HubEvent)，
 * 组件与渲染器不感知来源。脚本节奏：思考/工具/孵化/推演/审批/设备留痕，
 * 覆盖 message_list/审批卡/孵化面板/时间线/推演树的联动演示。
 */

import type { ChannelHub, HubEvent } from './channelHub';
import { setStreaming, createIngester, commitStreaming } from './eventIngest';
import type { EventTypeName } from './eventTypes';

export interface FixtureScriptOptions {
  /** 事件间隔基数（毫秒）；测试环境可调小 */
  baseDelayMs?: number;
  onDone?: () => void;
}

const ROUND_ID = 'round-1';

function ev(type: EventTypeName, payload: Record<string, unknown> = {}, at = Date.now()): HubEvent {
  return { type, payload: { ...payload, round_id: ROUND_ID }, at };
}

/** 脚本化回合：以固定节拍投递事件（返回清理函数，卸载时停表）。 */
export function runFixtureSession(hub: ChannelHub, options: FixtureScriptOptions = {}): () => void {
  const { baseDelayMs = 700, onDone } = options;
  const ingest = createIngester(hub);
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const schedule = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));

  const at = (step: number, fn: () => void) => schedule(step * baseDelayMs, fn);

  const tokens = (step: number, text: string, stepId: string) => {
    for (const [index, chunk] of text.split(/(?<=。)/).entries()) {
      const chunkText = chunk.trim();
      if (!chunkText) continue;
      at(step + index * 0.6, () => ingest(ev('reply_token', { step_id: stepId, token: chunkText })));
    }
  };

  setStreaming(hub, true);

  // 推理流式：thinking_start 分片逐片追加（中途逐步可见），thinking_end 定型
  at(0, () => ingest(ev('thinking_start', { step_id: 'think:1', content: '' })));
  at(0.4, () => ingest(ev('thinking_start', { step_id: 'think:1', content: '观察当前领域的' })));
  at(0.8, () => ingest(ev('thinking_start', { step_id: 'think:1', content: '知识缺口：引用质量校验规则' })));
  at(1, () => ingest(ev('thinking_end', { step_id: 'think:1', content: '观察当前领域的知识缺口：引用质量校验规则尚未沉淀为可复用条目。' })));

  at(2, () => ingest(ev('plan_start', { step_id: 'plan:1', workflow: 'research_orchestrator' })));
  at(3, () => ingest(ev('plan_end', { step_id: 'plan:1', content: '计划：检索既有知识 → 执行引用质量校验 → 孵化信号 → 蒸馏候选条目 → 审批沉淀。' })));

  at(4, () => ingest(ev('tool_start', { step_id: 'tool:1', tool: 'inspect_knowledge', permission: 'allow' })));
  at(5, () => ingest(ev('tool_end', { step_id: 'tool:1', tool: 'inspect_knowledge', summary: '2 条知识，可信度 0.61–0.92' })));

  at(6, () => ingest(ev('tool_start', { step_id: 'tool:2', tool: 'research_pipeline', permission: 'allow' })));
  at(7, () => ingest(ev('tool_end', { step_id: 'tool:2', tool: 'research_pipeline', summary: '3 个来源交叉验证通过' })));

  at(8, () =>
    ingest(
      ev('memory_recall', {
        step_id: 'plan:1',
        hits: [
          { id: 'k-001', title: '引用质量校验：来源可追溯', snippet: '每次沉淀前校验来源标识' },
          { id: 'k-002', title: '蒸馏产物长度下限经验值', snippet: '阈值 20 字' },
        ],
      }),
    ),
  );

  at(9, () => tokens(9, '已完成首轮领域观察：引用质量校验规则命中既有知识，建议沉淀一条「来源可追溯」约束到知识集。', 'reply:1'));
  at(14, () => ingest(ev('suggestions', { step_id: 'reply:1', items: ['调用 inspect_ui 观察界面形态', '推演下一个研究决策', '进入孵化面板查看流水'] })));

  // 孵化流水：信号 → 蒸馏 → 闸门
  at(15, () => ingest(ev('signal_detected', { signal_id: 'sig-1', signal_type: 'insight', signal: '引用质量校验规则可抽象为通用约束条目' })));
  at(16, () => ingest(ev('distill_outcome', { signal_id: 'sig-1', distilled: '约束：知识条目引用须带来源标识（r-001）' })));
  at(17, () => ingest(ev('gate_verdict', { signal_id: 'sig-1', level: 'L1', passed: true, reason: '样例校验通过，规则语义一致' })));

  // 补丁链
  at(18, () => ingest(ev('patch_proposed', { patch_id: 'p-004', kind: 'knowledge', title: '沉淀：来源可追溯约束条目', level: 'L1' })));
  at(19, () => ingest(ev('patch_applied', { patch_id: 'p-004' })));
  at(20, () => ingest(ev('patch_proposed', { patch_id: 'p-005', kind: 'rule', title: '补充：蒸馏产物长度下限', level: 'L2' })));

  // 推演：决策点分支对比 + 换选
  at(21, () =>
    ingest(
      ev('simulate_decision', {
        step_id: 'sim:1',
        branches: [
          { branch_id: 'b-1', label: '直接沉淀规则', score: 0.82, rationale: '样例库可支撑校验', steps: [{ node: 'evaluate', status: 'completed', note: '0.82' }, { node: 'apply', status: 'completed' }], selected: true },
          { branch_id: 'b-2', label: '先孵化再沉淀', score: 0.74, rationale: '多一道闸门防退化', steps: [{ node: 'distill', status: 'completed' }, { node: 'gate', status: 'pending' }] },
        ],
      }),
    ),
  );
  at(22, () => ingest(ev('swap_branch', { branch_id: 'b-2' })));
  at(23, () => ingest(ev('branch_result', { branch_id: 'b-2', score: 0.79, rationale: '观察窗口加长后评分上调' })));

  // 进化工厂：变异 + 防退化
  at(24, () => ingest(ev('mutation_proposed', { mutation_id: 'mut-1', mutation: '变体：约束升级为跨层通用条目（work → project）' })));
  at(25, () => ingest(ev('regression_guard', { mutation_id: 'mut-1', passed: false, reason: '跨层晋升须 L2 审批且样例未覆盖' })));

  // vetting 留痕 + 调优
  at(26, () => ingest(ev('vetting_result', { tool: 'propose_patch', passed: true, reason: '静态钩子核对通过' })));
  at(27, () => ingest(ev('tuning_update', { detail: '引用质量权重 0.6 → 0.65（低分降权）' })));

  // 审批卡（朱砂 accent，任何视图可弹）
  at(28, () =>
    ingest(
      ev('review_card', {
        title: '补丁审批',
        kind: 'rule',
        level: 'L2',
        tool: 'propose_patch',
        reason: '规则补丁「蒸馏产物长度下限」请求应用：变更规则集 r-002。',
        content: '{"kind": "rule", "target": "r-002", "payload": {"min_length": 20}}',
      }),
    ),
  );

  // 设备感知/控制留痕
  at(30, () => ingest(ev('device_sensed', { step_id: 'dev:1', action: 'system_query', detail: 'os=windows · arch=x86_64 · uptime 3h' })));
  at(31, () => ingest(ev('device_control', { step_id: 'dev:2', action: 'notify', detail: '通知：补丁 p-004 已沉淀' })));

  at(32, () => ingest(ev('spawn_start', { step_id: 'spawn:1', node_id: 'sub-1', label: '子任务：生成知识条目草稿' })));
  at(33, () => ingest(ev('spawn_end', { step_id: 'spawn:1', node_id: 'sub-1' })));

  at(34, () => {
    ingest(ev('end'));
    setStreaming(hub, false);
    // 回合结束：残留 streaming 行定型为正式回复（消除永久闪烁光标）
    commitStreaming(hub);
    onDone?.();
  });

  return () => {
    for (const timer of timers) clearTimeout(timer);
  };
}
