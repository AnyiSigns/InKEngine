/**
 * path_assembler 机制件契约声明：路径组装器（只读组装出候选路径清单 + 干预
 * 落库 + canary 兼容验证）。
 *
 * 契约面：effects 声明本机制消费的副作用端口白名单——干预能力
 * （choose_candidate / clear_candidate_selection / set_multipath）经注入的窄
 * 存储协议对象（CandidateStorage，storage 为 null 早退）直读直写候选选中与
 * 多径开关状态记录（PATH_CANDIDATE_COLLECTION / PATH_FLAGS_COLLECTION），并
 * 复用 audit_log 的 emit_audit 通道落审计，属 storage_seam 端口面（0-IO：
 * 不自持 IO，只经注入存储读写记录）；其余面纯数据：组装审计记录经
 * audit_sink 回调承接（本机制不直接写库），canary 重建 + 单回合试跑只构造
 * 图实例数据并复用 executor.Engine 执行（试跑强制无存储、进程内执行不启
 * 沙箱），机制 src 无模型调用（不列 llm_port）、无进程/文件沙箱消费（不列
 * exec_envelope）。
 *
 * depends = 值面机制清单：audit_log（emit_audit 落库通道）、budget（canary
 * 步数护栏 BudgetManager）、executor（canary_round 单回合试跑复用 Engine；
 * executor 侧经组装默认运行期消费本机制——value 级相互依赖如实声明，装配期
 * 循环校验由此获真实依赖边）。契约化归属见
 * engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../registry/contract_types.js';
import { PORT_STORAGE_SEAM } from '../registry/ports.js';

/** path_assembler 机制契约：消费 storage_seam 干预落库面，值依赖审计/预算/执行器。 */
export const path_assembler_contract: MechanismContract = {
  id: 'path_assembler',
  contract: {
    effects: [PORT_STORAGE_SEAM],
  },
  depends: ['audit_log', 'budget', 'executor'],
};
