/**
 * 真 ui 面宿主接入词表（阶段 9b 单一真源）。
 *
 * faces.ui.access 里出现的 store/inject 名称必须命中本词表——扁平一张表，
 * 不做读面/动作面手工分类（避免为 BackendAdapter 60+ 方法维护第二份
 * 读/写清单；安全保证 = 名称命中词表 + 宿主对每个词提供实现）。
 *
 * 词表 = 产品 chrome 的可注入面：ProductShellModel 字段（数据/服务座位，
 * backend/hub/sessionStore 为整对象座位，内部方法面 = 各自 TS 接口，
 * 不进 spec 词表）+ ProductShellActions 动作名。接口加键须同步补词表：
 * 下方类型级断言强制词表与 keyof 精确一致（漏词/多词/拼错 = 编译红）。
 */

import type { ProductShellActions, ProductShellModel } from './productView';

/** store 词表（数据/服务座位名；= ProductShellModel 键，编译期锁精确一致）。 */
const UI_STORE_NAMES = [
  'backend',
  'appBackend',
  'hub',
  'sessionStore',
  'activeSessionId',
  'title',
  'tab',
  'streaming',
  'entries',
  'roundSteps',
  'simulations',
  'incubation',
  'patchChain',
  'pendingReview',
  'task',
  'spawnInstances',
  'selectedSpawnIndex',
  'sessions',
  'branchTrees',
  'authorized',
  'workspaceRoot',
  'models',
  'agentModelId',
  'routePlan',
  'roundCount',
  'stepCount',
  'hasTodo',
  'todoPending',
  'settingsOpen',
  'autoApprovableTools',
] as const satisfies readonly (keyof ProductShellModel)[];

/** inject 词表（宿主动作名；= ProductShellActions 键，编译期锁精确一致）。 */
const UI_INJECT_NAMES = [
  'onTabChange',
  'onTitleChange',
  'onOpenSettings',
  'onCloseSettings',
  'onAddWorkspace',
  'onSend',
  'onAbort',
  'onAttachments',
  'onRoutePlanPreview',
  'onAgentModelSelect',
  'onSpawnSelect',
  'onSpawnSendInstruction',
  'onBranchFromMessage',
  'onBranchFromLeaf',
  'onSelectSession',
  'onCreateSession',
  'onRenameSession',
  'onDeleteSession',
  'onResolveReview',
] as const satisfies readonly (keyof ProductShellActions)[];

type Expect<T extends true> = T;
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

/** 词表与接口键精确一致（ProductShellModel / ProductShellActions 改键 → 编译红）。 */
export type _StoreExactCheck = Expect<Equal<keyof ProductShellModel, (typeof UI_STORE_NAMES)[number]>>;
export type _InjectExactCheck = Expect<Equal<keyof ProductShellActions, (typeof UI_INJECT_NAMES)[number]>>;

/** 扁平接入词表（store ∪ inject，单一真源；spec access 名称须命中本并集）。 */
export const UI_HOST_ACCESS_NAMES = [...UI_STORE_NAMES, ...UI_INJECT_NAMES] as const;

export type UiHostAccessName = (typeof UI_HOST_ACCESS_NAMES)[number];
export const UI_HOST_ACCESS_SET = new Set<string>(UI_HOST_ACCESS_NAMES);

/** 槽位集合：store 槽只收数据/服务座位（ProductShellModel 字段），inject 槽只收
 *  宿主动作（ProductShellActions 键）——两集合源自同一份编译期锁定数组，非手工
 *  第二清单；verify:unload 用其做槽位正确性校验（动作名进 store 槽 = 违规）。 */
export const UI_STORE_SET = new Set<string>(UI_STORE_NAMES);
export const UI_INJECT_SET = new Set<string>(UI_INJECT_NAMES);

export function isUiHostAccessName(name: string): name is UiHostAccessName {
  return UI_HOST_ACCESS_SET.has(name);
}
