/**
 * 契约自指元工具描述面（core/self_tools.py self_tool_specs / operation_of
 * 移植）。
 *
 * 6 个契约工具（:data:`SELF_TOOL_CONTRACT`，与 seeds/boot 的
 * BOOT_METATOOLS 中演化子集一一对应）——引擎能力，随机制层走补丁链
 * 演化、不随宿主壳漂移。operation_of 供自指流水线与宿主统一流水线
 * 接线使用（单一判定来源，两条管线分类一致，避免新工具只在一侧登记
 * 造成的权限误判）。宿主扩展工具（如种子沉淀）在宿主侧合并进统一判定，
 * 本模块只管契约工具。
 */

import { ToolSpec } from '../llm/tools.js';
import { _PATCH_KIND_VALUES } from '../self_proposal/self_proposal.js';
import { PERMISSION_APPLY, PERMISSION_PROPOSE } from './_constants.js';

/** 工具参数 JSON Schema 的 kind 枚举（补丁类型声明序；与 PatchKind 同源）。 */
const _KIND_ENUM: readonly string[] = [..._PATCH_KIND_VALUES];

/**
 * 契约自指元工具的工具描述清单（注册进引擎工具表走标准流水线）。
 */
export function self_tool_specs(): ToolSpec[] {
  return [
    new ToolSpec({
      name: 'propose_patch',
      description:
        '提出产品演化补丁（只校验不落链）：按类型校验 payload 形态与'
        + '基准版本，返回校验结果与当前集版本——合法提案的下一步是 apply_patch。'
        + 'payload 是嵌套声明形态，不是扁平字段：kind=rule 须为 '
        + 'payload.rule={id,predicate,path,config,severity,description}；'
        + 'kind=knowledge 须为 payload.entry={id,level,kind,data}；'
        + 'kind=tool 须为 payload={name,description,permissions,endpoint,'
        + 'endpoint_config}；其余类型同样以类型对应的嵌套声明为 payload。'
        + '校验失败会随违规清单回传合法形态示例骨架。'
        + '任务中工具不够用时可自举：kind=tool 新增/修改工具定义（含权限档位'
        + 'approval、端点、命令白名单——如把 deny 档转正或放宽命令面），'
        + 'apply_patch 落地后新工具即注入可用，无需等用户提需求',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: [..._KIND_ENUM],
            description:
              '补丁类型（ui/theme/tool/rule/knowledge/harness/event_type/'
              + 'environment/artifact）',
          },
          payload: {
            type: 'object',
            description:
              '补丁内容（按类型校验的嵌套声明形态：rule 走 payload.rule，'
              + 'knowledge 走 payload.entry，tool 走 name/description/permissions/'
              + 'endpoint/endpoint_config，harness 走 payload.definition）',
          },
          rationale: {
            type: 'string',
            description: '提案理由（审批卡展示与审计留痕）',
          },
        },
        required: ['kind', 'payload'],
      },
      permissions: [PERMISSION_PROPOSE],
    }),
    new ToolSpec({
      name: 'apply_patch',
      description:
        '应用演化补丁：校验 → 审批分级（L0 直过/L1 弹卡/L2 沙箱验证'
        + '+人工）→ 补丁链落库 → 活跃态生效；审批卡等待用户决议时回合挂起',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: [..._KIND_ENUM],
            description: '补丁类型（与 propose_patch 同口径）',
          },
          payload: {
            type: 'object',
            description: '补丁内容（与 propose_patch 同口径）',
          },
          base_version: {
            type: 'integer',
            minimum: 1,
            description:
              '提案时的集版本（缺省 = 当前版本；基准不匹配 = 并发冲突，'
              + '拒绝并要求重提）',
          },
          rationale: {
            type: 'string',
            description: '提案理由（审批卡展示与审计留痕）',
          },
        },
        required: ['kind', 'payload'],
      },
      permissions: [PERMISSION_APPLY],
    }),
    new ToolSpec({
      name: 'revert_patch',
      description:
        '回退已应用补丁（仅链尾，须审批）：回退后集状态回到目标版本，'
        + '审计保留完整历史（append-only）',
      parameters: {
        type: 'object',
        properties: {
          patch_id: {
            type: 'integer',
            minimum: 1,
            description: '要回退的补丁版本号（须为当前链尾）',
          },
          reason: {
            type: 'string',
            description: '回退原因（审计留痕）',
          },
        },
        required: ['patch_id'],
      },
      permissions: [PERMISSION_APPLY],
    }),
    new ToolSpec({
      name: 'propose_domain_manifest',
      description:
        '领域生成器（自举造工具）：根据自然语言领域需求生成最小可用'
        + '领域清单（harness 定义，含该领域的工具定义与执行图）并提案——输入'
        + '领域名/描述/关键词（可选工具与图），校验后产出 harness 补丁；经审批'
        + '落地后该领域即出现在能力清单，可被路由激活（长出新领域 = 真实产品演化）。'
        + '任务中现有工具覆盖不了需求时，用本工具为手头任务自举生成专用工具集，'
        + 'apply_patch 落地后即可用新工具继续任务。生成时参考集内沉淀的'
        + '相关经验（related_knowledge 字段），复用优先于从头发明',
      parameters: {
        type: 'object',
        properties: {
          domain_name: {
            type: 'string',
            description: '领域名（harness 名，全局唯一）',
          },
          description: {
            type: 'string',
            description: '领域能力描述（能力路由/用户可见说明）',
          },
          keywords: {
            type: 'array',
            items: { type: 'string' },
            description: '能力关键词（路由匹配依据）',
          },
          tools: {
            type: 'array',
            items: { type: 'object' },
            description: '可选声明式工具定义清单（扩展领域能力）',
          },
          graph: {
            type: 'object',
            description: '可选图定义数据（领域工作流；省略 = 纯能力标记）',
          },
          rationale: {
            type: 'string',
            description: '提案理由（审批卡展示与审计留痕）',
          },
        },
        required: ['domain_name', 'description', 'keywords'],
      },
      permissions: [PERMISSION_PROPOSE],
    }),
    new ToolSpec({
      name: 'search_tools',
      description:
        '检索工具集（保底集以外的工具经此发现，注册但未注入的工具均可检索）：'
        + '输入自然语言查询，返回匹配工具列表（名称/摘要/参数/权限档/端点/'
        + '端点可用性，≤8 条）。注意：检索到 ≠ 可用——挂载/注册只是进入总源，'
        + '调用前须经 request_tool 绑定到当前会话窗口才注入，且绑定响应会标注'
        + '端点是否已连接',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '自然语言查询（如「读取文件」「搜索代码」）',
          },
        },
        required: ['query'],
      },
      permissions: [PERMISSION_PROPOSE],
    }),
    new ToolSpec({
      name: 'request_tool',
      description:
        '绑定指定工具到当前会话窗口（thread 内恒注入）：校验工具名合法性，'
        + '非法名返回明确错误；合法则打 thread 标签注入完整 schema，返回'
        + '「已绑定」确认——本会话后续轮次即可按 schema 生成 tool_call。'
        + '绑定响应携带端点状态（endpoint_status）：MCP/远程端点未连接时标注'
        + 'connected=false——绑定≠端点可用，调用前须确认端点状态。'
        + '注意：绑定是会话级（thread 隔离），其它会话/新会话需重新绑定；'
        + '同一会话重复绑定幂等',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '要绑定的工具名（须在工具注册表中）',
          },
        },
        required: ['name'],
      },
      permissions: [PERMISSION_PROPOSE],
    }),
  ];
}

/**
 * 操作提取：按工具名定动作（propose/apply × patch 目标）。
 *
 * 同时供自指流水线与宿主统一流水线接线使用（单一判定来源，两条管线
 * 分类一致，避免新工具只在一侧登记造成的权限误判）。宿主扩展工具
 * （如种子沉淀）在宿主侧合并进统一判定，本函数只管契约工具。
 */
export function operation_of(spec: ToolSpec): [string, string] {
  if (
    spec.name === 'propose_patch'
    || spec.name === 'propose_domain_manifest'
    || spec.name === 'search_tools'
    || spec.name === 'request_tool'
  ) {
    return ['propose', 'patch'];
  }
  return ['apply', 'patch'];
}
