/**
 * boot 种子（自举引导数据资产）：系统提示词 / 初始界面描述 / 事件类型 /
 * 自举 harness 定义——宿主装配开局注入的只读基线。
 *
 * boot 种子 = 引擎随带的引导发布物（非领域成品）：开局即提供「AI 自描述
 * + 自举面板 + 元工具能力」的初始形态。宿主装配时经配方直注——
 * AssemblyRecipe(seeds=[("boot", build_boot_seed_entries)]) 注入系统
 * 提示词知识条目；其余描述（界面/事件/自举 harness）供装配直接消费
 * （非知识条目，是装配期数据）。
 *
 * 数据与机制分离：本模块只持有 boot 引导的数据形态，不引入任何机制依赖；
 * 宿主（InKling 智能体/stdio 等）从本模块取用，保持机制层零领域/产品内容。
 *
 * 移植说明：适配层 boot 模块（镜像 Python ink_engine/seeds/boot），
 * snake_case 命名与 __all__ 镜像，常量与 id 严格保留 Python 字面；
 * JSON 数据直接字面，机制依赖只取 migrated 的类型形态。
 * 例外：BOOT_SYSTEM_PROMPT 文本已按「工具语义入 schema、提示词只留
 * 策略」收敛（见下），不再逐字节对齐 Python 字面。
 *
 * 状态标注（机制就绪 / 宿主接线点待定）：引导种子装配位——runtime 已接
 * seed_general（通用种子，引擎侧 seed_knowledge_set 直注）；boot 引导数据
 * （系统提示词/界面/事件/自举 harness）由宿主配方 AssemblyRecipe.seeds
 * 直注装配。
 */

import { EventTypeSpec } from '../../core/event_types/eventTypeSpec.js';
import { HarnessDefinition } from '../../core/harness/index.js';
import type { JsonRecord } from '../../core/json.js';
import { KnowledgeEntry, SOURCE_MODEL } from '../../core/knowledge_set/index.js';

// 自举系统提示词（AI 自描述：观察 + 演化 + 编排策略）。
// 作为种子知识条目注入，AI 回合内可被检索/引用，而非硬编码进图装配。
// 提示词只承载策略与编排（何时观察/演化/绑定），不枚举工具语义——
// 观察/演化工具各自的能力与参数经 ToolSpec description + 函数清单注入
// （introspection/pipeline.ts、self_tools/_specs.ts），保底常驻集合见
// runtime/_constants.ts BASELINE_TOOL_NAMES（单一真源，此处不重复）。
// 注：内容有意收敛于 Python 字面之外（不再含工具清单枚举）。
export const BOOT_SYSTEM_PROMPT = `你同时具备任务执行与形态自进化能力：先观察再作答，需要了解自身状态时先调用相应观察工具（图/规则/知识/界面/工具），再基于观察结果组织回复；各工具的用途与参数以注入的函数清单为准。

形态演化（用户提需求时）：
- 改界面/加工具/换主题/调规则 → propose_patch 校验后 apply_patch 落地（apply 按审批分级，中高风险弹审批卡，回合等待决议后继续）；
- 建新领域 → propose_domain_manifest 生成领域 harness 定义后 apply_patch 落地（改既有领域仍用 propose_patch）。

能力自举（任务中主动扩展，不必等用户提需求）：
- 任务需要而当前清单没有工具时，优先「自造」而非硬绕或跳过必要环节：
  propose_domain_manifest 造领域专用工具集，或 propose_patch kind=tool 造/调单个工具（含权限档位，如 deny 转正、放宽白名单、改端点），apply 落地后继续任务。

工具规约：函数清单内已注入的工具直接调用；清单外 → search_tools 检索 → request_tool 绑定 → 按注入 schema 传参；计划预编排步骤的工具由计划指定，无需检索。简明直接。`;

// 初始界面描述（对话面板 = 数据；渲染器消费布局树即时重渲）——
// 布局树原样 JSON，不改写结构与键序
export const BOOT_UI_SPEC: JsonRecord = {
  name: 'boot.panel',
  version: 1,
  root: {
    kind: 'container',
    type: 'column',
    children: [
      {
        kind: 'component',
        type: 'message_list',
        bind: { channel: 'state', path: 'messages' },
      },
      { kind: 'component', type: 'agent_input' },
    ],
  },
  theme: { bg: '#09090b', fg: '#e4e4e7', accent: '#f59e0b' },
};

// boot 内置事件类型登记：协议 v2 的建卡型事件 → 前端同名渲染组件。
// 更新型事件（*_token/*_end）不独立建卡不登记；schema 缺省不校验
// payload 形态（发射侧保持宽松——注册表是增强不是收紧）
export const BOOT_EVENT_TYPES: readonly EventTypeSpec[] = [
  new EventTypeSpec({
    name: 'reply_token',
    renderer: 'StreamingRow',
    meta: { source: 'boot', description: '正文流式输出' },
  }),
  new EventTypeSpec({
    name: 'thinking_start',
    renderer: 'ThinkingRow',
    meta: { source: 'boot', description: '思考卡' },
  }),
  new EventTypeSpec({
    name: 'plan_start',
    renderer: 'PlanRow',
    meta: { source: 'boot', description: '规划卡' },
  }),
  new EventTypeSpec({
    name: 'tool_start',
    renderer: 'ToolRow',
    meta: { source: 'boot', description: '工具卡' },
  }),
  new EventTypeSpec({
    name: 'node_start',
    renderer: 'NodeRow',
    meta: { source: 'boot', description: '节点卡' },
  }),
  new EventTypeSpec({
    name: 'review_card',
    renderer: 'ReviewCard',
    meta: { source: 'boot', description: '审核卡' },
  }),
  new EventTypeSpec({
    name: 'suggestions',
    renderer: 'TextRow',
    meta: { source: 'boot', description: '建议卡' },
  }),
  new EventTypeSpec({
    name: 'error',
    renderer: 'ErrorRow',
    meta: { source: 'boot', description: '错误消息' },
  }),
];

// 自举 harness 定义（forge 自举领域：观察/提案/应用的元能力集）。
export function boot_harness_definition(): HarnessDefinition {
  return new HarnessDefinition({
    name: 'forge',
    description: '自举领域：观察/提案/应用的元能力集',
    keywords: ['观察', '内省', '演化', '自举'],
    meta: { set_id: 'default', role: 'self' },
  });
}

// boot 系统提示词知识条目 id（稳定键：幂等注入与版本回退锚点）
export const BOOT_PROMPT_SEED_ID = 'seed.boot.system_prompt';

// boot 种子条目（自举系统提示词，作为高可信度种子知识注入）。
export function build_boot_seed_entries(): KnowledgeEntry[] {
  return [
    new KnowledgeEntry({
      id: BOOT_PROMPT_SEED_ID,
      level: 'project',
      kind: 'boot_prompt',
      data: { prompt: BOOT_SYSTEM_PROMPT },
      source: SOURCE_MODEL,
      credibility: 1.0,
      title: 'Forge 自举系统提示词',
      tags: ['boot', 'system_prompt'],
    }),
  ];
}

// boot 自指元工具注册清单（引擎层能力契约）：AI 自举的「观察 + 演化」
// 工具集合，是本产品「agent 知道自己能干啥」的只读基线。
//
// 清单用途（换壳不失明的关键）：
// - 宿主装配时据此登记元工具（introspection + self 两套），漏注册即
//   违反契约；
// - AI 经 inspect_tools 动态发现自身能力，清单即认知边界的数据化；
// - 引擎单测强制 engine-resident 的 introspection 子集 ⊆ 本清单，
//   防止机制层新增观察工具后换壳宿主未同步导致 agent 失明。
// 观察工具来自 introspection 机制层，演化工具来自 self_application
// 机制层——二者均为引擎能力，不随宿主壳漂移。
export const BOOT_METATOOLS: readonly string[] = [
  'inspect_graph',
  'inspect_rules',
  'inspect_knowledge',
  'inspect_ui',
  'inspect_tools',
  'inspect_entities',
  'propose_patch',
  'apply_patch',
  'revert_patch',
  'propose_domain_manifest',
  'search_tools',
  'request_tool',
];
