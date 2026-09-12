/**
 * 环境管理常量（environments.py 的常量面移植）：环境状态枚举值/实例根目录/
 * 环境审计集合。
 *
 * 状态为声明式字符串常量（防魔法字符串），提供器与句柄状态机共用同一口径；
 * ENV_AUDIT_COLLECTION 是 LocalProvider 落审计的 append-only 集合（什么环境
 * 跑过什么命令，留痕可查）。
 */

/** 环境状态：就绪。 */
export const ENV_STATUS_READY = 'ready';

/** 环境状态：安装中。 */
export const ENV_STATUS_INSTALLING = 'installing';

/** 环境状态：失败。 */
export const ENV_STATUS_FAILED = 'failed';

/** 环境状态：已销毁。 */
export const ENV_STATUS_DESTROYED = 'destroyed';

/** 环境实例根目录（数据目录内 envs/，可销毁重建）。 */
export const DEFAULT_ENVS_DIR = 'envs';

/** 环境运行/安装审计集合（append-only 留痕：什么环境跑过什么命令）。 */
export const ENV_AUDIT_COLLECTION = 'env_audit';
