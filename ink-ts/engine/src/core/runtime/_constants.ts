/**
 * 运行时机壳常量（runtime.py 模块级常量移植）。
 *
 * 常驻必带集/动态注册机制工具/thread 标签 TTL/records 通道键 与 Python
 * 侧逐项对齐——重启装载（_restore_baseline/_restore_thread_tags）依赖同名
 * 常量，改动须两端同步。
 */

// 回合装配检索上限（ENG3-16：与检索原语 DEFAULT_LIMIT 同值 8，钳制回合
// 注入上下文体积；分级口径见 _assembly_sources）
export const _ASSEMBLY_SOURCE_LIMIT = 8;

// 保底 8+2 常驻集合（collect_specs 只注入这些完整 schema 进 tools 参数）。
// 保底 8 = file_read/file_write/file_edit/grep/glob（声明式）
//         + propose_patch/propose_domain_manifest（自指）+ inspect_tools（内省）
// +2 自指 = search_tools/request_tool
// +1 续航 = task_manager（待办清单常驻——跨回合续航锚点，agent 开局即拆解任务）
export const BASELINE_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  'file_read', 'file_write', 'file_edit', 'grep', 'glob',
  'propose_patch', 'propose_domain_manifest',
  'inspect_tools',
  'search_tools', 'request_tool',
  'task_manager',
]);

// 常驻必带集持久化（records 通道；集合不在演化资产守卫表内 = 直写放行）。
export const BASELINE_RECORD_COLLECTION = 'runtime_config';
export const BASELINE_RECORD_KEY = 'tool_baseline';

// 动态注册机制工具（search_tools/request_tool）：永远强制常驻，用户不可摘除。
export const BASELINE_IMMUTABLE_TOOLS: ReadonlySet<string> = new Set<string>([
  'search_tools', 'request_tool',
]);

// 工具标签（单源 + 标签：tool_registry 是全量存储，标签区分注册状态）
export const TAG_IMMUTABLE = 'immutable';
export const TAG_BASELINE = 'baseline';

// thread 标签 TTL（秒）：到期惰性清理（无会话关闭语义，纯按时间回收）
export const THREAD_TAG_TTL_SECONDS = 3 * 24 * 3600;

// thread 标签持久化（records 通道；与常驻必带集同形态）
export const THREAD_TAG_RECORD_COLLECTION = 'runtime_config';
export const THREAD_TAG_RECORD_KEY = 'tool_thread_tags';

// 出厂界面组件启停持久化（records 通道；禁用集 ⊆ 配方 ui_allowed_components）
export const UI_COMPONENTS_RECORD_COLLECTION = 'runtime_config';
export const UI_COMPONENTS_RECORD_KEY = 'ui_components_disabled';
