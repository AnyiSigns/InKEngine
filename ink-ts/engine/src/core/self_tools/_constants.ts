/**
 * 自指元工具常量面（core/self_tools.py 顶层常量移植）。
 *
 * 观察工具让 AI 看清自己；这套工具让 AI 合法地修改产品形态——提案
 * （propose_patch）校验形态与基准版本但不落链；应用（apply_patch）走
 * 完整管线（校验 → 审批分级 → 补丁链落库 → 活跃态生效）；回退
 * （revert_patch）仅允许链尾补丁；领域生成（propose_domain_manifest）
 * 从高层描述产出新领域清单并提案；search_tools/request_tool 为自指
 * 发现通道（检索工具集 / 把工具绑定到当前会话窗口）。
 */

import { DEFAULT_MAX_RESULT_CHARS } from '../tool_pipeline/_types.js';

// 权限声明（自定义域：self:propose / self:apply）
export const PERMISSION_PROPOSE = 'self:propose:*';
export const PERMISSION_APPLY = 'self:apply:*';

// thread 标签前缀（单源 + 标签：绑定 = 给当前会话 thread 打标签；与
// runtime 的 TAG_THREAD_PREFIX 同值，此处本地定义避免循环导入）
export const TAG_THREAD_PREFIX = 'thread:';

// 契约工具清单（与 seeds/boot 的 BOOT_METATOOLS 演化子集同源；
// 宿主装配据此登记，漏注册即违反契约）
export const SELF_TOOL_CONTRACT: readonly string[] = [
  'propose_patch',
  'apply_patch',
  'revert_patch',
  'propose_domain_manifest',
  'search_tools',
  'request_tool',
];

// 判定动作（与权限声明的 action 配对）
export const _OPERATION_PROPOSE = 'propose';
export const _OPERATION_APPLY = 'apply';
export const _OPERATION_DISCOVER = 'discover';

// 收敛管制评估的审计扫描上限（指标聚合有界，防大链拖慢工具调用）
export const _AUDIT_SCAN_LIMIT = 1000;

// 结果文本截断上限（ENG6-6：共享常量——与引擎工具流水线默认一致）
export const _MAX_RESULT_CHARS = DEFAULT_MAX_RESULT_CHARS;

