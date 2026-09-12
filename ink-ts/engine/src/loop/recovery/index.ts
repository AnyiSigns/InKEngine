/**
 * 恢复/续流解析公共 API 汇出口（recovery.py 移植）。
 *
 * 公共 API 与 Python `__all__` 对齐——只暴露 ResumeResolution、
 * collect_resume_anchors、resolve_resume、tail_checkpoint；签名所需的
 * 类型（ResolveResumeOptions/ResumeMap）随之导出，内部实现文件
 * （recovery_anchors.ts/recovery_types.ts/recovery.ts）不重复对外。
 */

export { ResumeResolution } from './recovery_types.js';
export type { ResolveResumeOptions } from './recovery_types.js';
export type { ResumeMap } from './recovery_types.js';
export { collect_resume_anchors } from './recovery_anchors.js';
export { resolve_resume, tail_checkpoint } from './recovery.js';