/**
 * 作用域目录资产层（执行模型作用域目录的声明面 + 出厂预置素材）。
 *
 * 目录资产映射：作用域资产 = 实体记录（core/entities/entities.ts 的 EntitySpec，
 * 同一集合/同一受控注册通道：EvolutionWriter + GuardedStorage）。本模块是
 * **薄作用域层**——只提供「在实体目录上读/写作用域声明」的构造与识别，
 * 不另建平行目录：
 *
 * - build_scope_asset：按目录身份（role）+ persona/model + 声明块构造实体
 *   （登记仍走实体注册表 register/replace + evolution writer 落位）；
 * - scope_decl_of / is_scope_asset：从实体读回声明块 / 判定作用域资产；
 * - default_scope_directory_seeds：出厂预置作用域目录（能力素材，8 行：
 *   main/planner/coder/critic/searcher/tester + collaborator + subagent）。
 *   预置的是**起点素材而非写死拓扑**：身份 persona/能力/契约是冷启动质量的
 *   集中点，随组织档案择优保留/降权/下架（执行模型 §六 语义的后续落地面）。
 *
 * 出厂素材 role 命名目录身份；model 一律 null = 会话/父作用域默认（model
 * 解析链运行时 seam：resolve_scope_llm，null = 继承不覆写）。guard_level 是
 * 「该资产被 agent 侧登记/更新/下架时须满足的审批档」；出厂/宿主装配期直注
 * 不走补丁链。
 */

import { EntitySpec } from '../entities/entities.js';
import {
  CAPABILITY_CLASS_FUNCTION,
  CAPABILITY_CLASS_ORGANIZATION,
  SCOPE_GUARD_DEFAULT,
  SCOPE_ROLE_COLLABORATOR,
  SCOPE_ROLE_SUBAGENT,
  type ScopeCapability,
  type ScopeDecl,
  type ScopeGuardLevel,
  type ScopeIoContract,
} from './scope_spec.js';

/** 构造作用域资产的构造选项（实体字段 + 声明块字段合一）。 */
export interface ScopeAssetInit {
  id: string;
  label?: string;
  persona?: string;
  model?: Record<string, string> | null;
  meta?: Record<string, unknown>;
  /** 目录身份（出厂词汇见 scope_spec；宿主可自定义）。 */
  role: string;
  capabilities?: ScopeCapability[];
  rules?: string[];
  cost_tier?: string;
  contract?: ScopeIoContract;
  guard_level?: ScopeGuardLevel;
}

/** 把声明块字段归一成 ScopeDecl（只落非空维度，保序列化最小）。 */
function _decl_of(init: ScopeAssetInit): ScopeDecl {
  const decl: ScopeDecl = {};
  if (init.capabilities !== undefined && init.capabilities.length > 0) {
    decl.capabilities = init.capabilities;
  }
  if (init.rules !== undefined && init.rules.length > 0) decl.rules = init.rules;
  if (init.cost_tier !== undefined) decl.cost_tier = init.cost_tier;
  if (init.contract !== undefined) decl.contract = init.contract;
  decl.guard_level = init.guard_level ?? SCOPE_GUARD_DEFAULT;
  return decl;
}

/**
 * 构造作用域资产（EntitySpec + scope 声明块）。
 * role 为空 = 显式拒绝（目录身份是作用域资产的必要维度）。
 */
export function build_scope_asset(init: ScopeAssetInit): EntitySpec {
  const role = init.role.trim();
  if (role === '') {
    throw new Error('作用域资产缺目录身份（role 非空字符串）');
  }
  return new EntitySpec({
    id: init.id,
    label: init.label,
    persona: init.persona,
    model: init.model,
    meta: init.meta,
    role,
    scope: _decl_of(init),
  });
}

/** 实体的作用域声明块（null = 普通实体非作用域资产）。 */
export function scope_decl_of(spec: EntitySpec): ScopeDecl | null {
  return spec.scope;
}

/** 实体是否作用域资产：携带 scope 声明块（构造时至少落守卫档，块恒在）。
 *  role 命中出厂目录身份的普通实体不算——实体目录缺省角色 collaborator 即
 *  出厂行，单凭 role 无法区分普通实体与目录资产。 */
export function is_scope_asset(spec: EntitySpec): boolean {
  return spec.scope !== null;
}

/** 执行类能力基（检索/测试等跨 doer 作用域共享的函数类能力素材）。 */
const FUNCTION_GROUP: ScopeCapability[] = [
  { id: 'search', class: CAPABILITY_CLASS_FUNCTION },
  { id: 'test', class: CAPABILITY_CLASS_FUNCTION },
];

/** 主持人：组织类执行能力（委托/fan-out/归并裁决）+ 会话内加工。 */
const MAIN_CAPABILITIES: ScopeCapability[] = [
  { id: 'orchestrate', class: CAPABILITY_CLASS_ORGANIZATION },
  { id: 'delegate', class: CAPABILITY_CLASS_ORGANIZATION },
  { id: 'converge', class: CAPABILITY_CLASS_ORGANIZATION },
  { id: 'answer', class: CAPABILITY_CLASS_FUNCTION },
];

/**
 * 出厂预置作用域目录（每次调用返回新鲜数据，防调用方就地改写污染素材）。
 *
 * 目录行 = 能力素材（persona/model/能力/契约随实体记录持久化，受控注册）；
 * 出厂 8 行含「协作者/子代理」两个通用身份模板（多协作者召集与 1→1 委托的
 * 目标作用域素材）。非写死拓扑：作为冷启动起点，后续经组织档案择优演化。
 */
export function default_scope_directory_seeds(): EntitySpec[] {
  const guard = SCOPE_GUARD_DEFAULT;
  return [
    build_scope_asset({
      id: 'main',
      role: 'main',
      label: '主持人',
      persona:
        '你是会话主持人（main 作用域）：负责入口判定、把用户请求综合成任务、'
        + '按组织先验决定是否分解/委托/召集多协作者/直接作答，并在汇聚点向用户'
        + '给出唯一收口的最终答复。用户输入始终最高优先，随时可注入。',
      capabilities: MAIN_CAPABILITIES,
      contract: {
        consumes: [{ shape: 'message', owner: 'user' }],
        produces: [{ shape: 'message', owner: 'user' }],
      },
      guard_level: guard,
    }),
    build_scope_asset({
      id: 'planner',
      role: 'planner',
      label: '规划',
      persona:
        '你是任务规划器（planner 作用域）：把任务目标拆成可执行步骤并给出验收标准'
        + '（只输出计划正文，不代替执行）。',
      capabilities: [{ id: 'plan', class: CAPABILITY_CLASS_FUNCTION }],
      contract: {
        consumes: [{ shape: 'message', key: 'task' }],
        produces: [{ shape: 'field', key: 'plan' }],
      },
      guard_level: guard,
    }),
    build_scope_asset({
      id: 'coder',
      role: 'coder',
      label: '编码',
      persona:
        '你是编码器（coder 作用域）：对照计划与验收标准编写增量 patch（只交付增量'
        + '变更，不自作主张重构无关范围）。',
      capabilities: [
        { id: 'patch', class: CAPABILITY_CLASS_FUNCTION },
        { id: 'fs', class: CAPABILITY_CLASS_FUNCTION },
        { id: 'bash', class: CAPABILITY_CLASS_FUNCTION },
        ...FUNCTION_GROUP,
      ],
      contract: {
        consumes: [{ shape: 'field', key: 'plan' }],
        produces: [{ shape: 'field', key: 'patch' }],
      },
      guard_level: guard,
    }),
    build_scope_asset({
      id: 'critic',
      role: 'critic',
      label: '审查',
      persona:
        '你是评审器（critic 作用域）：对照验收标准审查产出，输出风险与补充意见'
        + '（只输出评审正文，不代替执行）。',
      capabilities: [
        { id: 'review', class: CAPABILITY_CLASS_FUNCTION },
        ...FUNCTION_GROUP,
      ],
      contract: {
        consumes: [
          { shape: 'field', key: 'plan' },
          { shape: 'field', key: 'patch' },
        ],
        produces: [{ shape: 'field', key: 'review' }],
      },
      guard_level: guard,
    }),
    build_scope_asset({
      id: 'searcher',
      role: 'searcher',
      label: '检索',
      persona:
        '你是检索器（searcher 作用域）：按需查询代码索引/资料，返回相关证据'
        + '（只输出检索结果，不代替决策）。',
      capabilities: [
        { id: 'search', class: CAPABILITY_CLASS_FUNCTION },
        { id: 'web', class: CAPABILITY_CLASS_FUNCTION },
        { id: 'memory', class: CAPABILITY_CLASS_FUNCTION },
      ],
      contract: {
        consumes: [{ shape: 'message', key: 'task' }],
        produces: [{ shape: 'field', key: 'search' }],
      },
      guard_level: guard,
    }),
    build_scope_asset({
      id: 'tester',
      role: 'tester',
      label: '测试',
      persona:
        '你是测试器（tester 作用域）：跑相关测试验证产出符合验收标准，回报'
        + '测试结果与失败定位。',
      capabilities: [
        { id: 'test', class: CAPABILITY_CLASS_FUNCTION },
        { id: 'bash', class: CAPABILITY_CLASS_FUNCTION },
      ],
      contract: {
        consumes: [{ shape: 'field', key: 'patch' }],
        produces: [{ shape: 'field', key: 'test_result' }],
      },
      guard_level: guard,
    }),
    build_scope_asset({
      id: 'collaborator',
      role: SCOPE_ROLE_COLLABORATOR,
      label: '协作者',
      persona:
        '你是协作者（collaborator 作用域）：按分配的任务块独立产出意见，只就'
        + '被授权的任务/意见块作答，不越权访问他人意见。',
      capabilities: [{ id: 'opinion', class: CAPABILITY_CLASS_FUNCTION }],
      contract: {
        consumes: [{ shape: 'field', key: 'task' }],
        produces: [{ shape: 'field', key: 'opinion' }],
      },
      guard_level: guard,
    }),
    build_scope_asset({
      id: 'subagent',
      role: SCOPE_ROLE_SUBAGENT,
      label: '子代理',
      persona:
        '你是子代理（subagent 作用域）：承接委托的专门子任务并回传结果，'
        + '只处理被委托的任务描述。',
      capabilities: [...FUNCTION_GROUP],
      contract: {
        consumes: [{ shape: 'message', key: 'task' }],
        produces: [{ shape: 'message' }],
      },
      guard_level: guard,
    }),
  ];
}
