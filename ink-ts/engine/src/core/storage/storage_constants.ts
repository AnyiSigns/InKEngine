/**
 * 存储服务常量与序列化标记键（storage.py 移植）。
 *
 * 协议前缀与魔法数字：连接串解析为路由后端（memory/sqlite/postgres），
 * DEFAULT_* 限定为链巡检/列表默认上限（注入即覆盖）。序列化 marker 是
 * checkpoint JSON 列内联结构（PatchChain/Message/ToolCall）的识别键，
 * 写入侧贴标 + 读取侧认标以精确还原——非标记结构按普通递归处理。
 *
 * core 零 IO：连接串解析/后端实现交由宿主注入；本模块仅承载协议语义
 * （常量 + marker + 纯数据结构）。
 */

import { PROTOCOL_VERSION } from '../events/events.js';

export const SCHEME_MEMORY = 'memory';
export const SCHEME_SQLITE = 'sqlite';
export const SCHEME_POSTGRES = 'postgresql';

export const DEFAULT_CHAIN_WALK_LIMIT = 10000;
export const DEFAULT_LIST_CHECKPOINTS_LIMIT = 100;

// 补丁链内联标记（与 Python 一致，键名跨语言稳定以便对账）
export const PATCH_CHAIN_MARKER = '__patch_chain__';
export const MESSAGE_MARKER = '__engine_message__';
export const TOOL_CALL_MARKER = '__engine_tool_call__';

/** 事件协议版本镜像（用于事件 JSON 内 ProtocolVersionError 同口径判定）。 */
export const STORAGE_PROTOCOL_VERSION = PROTOCOL_VERSION;
