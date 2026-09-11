/**
 * 产品壳视图模型（宿主 → 渲染器 canonical 适配器的装配面）。
 *
 * 产品主壳改由 ui_spec 直渲后，壳层的机制回调与宿主数据经 UIRenderer 的
 * product chrome 统一注入适配器（适配器负责「绑定载荷 + 宿主数据 → 产品
 * 组件 props」的映射）。此处只声明数据形态，不含 React/JSX。
 */

import type { BackendAdapter, ModelArchiveSnapshot, SessionBranchTree } from '@/shared/backend/backendAdapter';
import type { ApprovalPose } from '@/shared/backend/backendAdapter';
import type { ChannelHub } from '@/shared/session/channelHub';
import type { SessionStore } from '@/shared/session/sessionStore';
import type { InkMessage, RoundStep, SimulationBranch } from '@/shared/session/types';
import type { AttachmentAsset } from '@/shared/session/eventIngest';
import type { SpawnInstance } from '../../../../../plugins/ui_features/message_list/faces/ui/SpawnPanel';
import type { TaskCapsuleData } from '../../../../../plugins/ui_features/task_capsule/faces/ui/types';
import type { MainTab, RailSession, ReviewResolution } from '@app/shell/shellContracts';
import type { ModelSelection } from '@/shared/backend/backendAdapter';
import type { AppBackend } from '../backend';
import type { PluginsCatalog } from '../pluginsCatalog';

/** 产品壳回显数据（适配器消费的宿主面）。 */
export interface ProductShellModel {
  backend: BackendAdapter;
  /** 壳服务座位（AppBackend 单例：App 视图层高层封装 = 带 dev fixture 兜底的
   *  共享后端服务；设置面板等声明 store:["appBackend"] 消费，非渲染器直连）。 */
  appBackend: AppBackend;
  hub: ChannelHub;
  sessionStore: SessionStore;
  activeSessionId: string;
  title: string;
  tab: MainTab;
  streaming: boolean;
  entries: InkMessage[];
  roundSteps: RoundStep[];
  simulations: SimulationBranch[];
  incubation: import('@/shared/session/types').IncubationEntry[];
  patchChain: import('@/shared/session/types').PatchChainEntry[];
  pendingReview: Record<string, unknown> | null;
  task: TaskCapsuleData | null;
  spawnInstances: SpawnInstance[];
  selectedSpawnIndex: number | null;
  sessions: RailSession[];
  branchTrees: Record<string, SessionBranchTree>;
  authorized: boolean;
  workspaceRoot: string | null;
  models: ModelArchiveSnapshot | undefined;
  agentModelId: string | null;
  roundCount: number;
  stepCount: number;
  settingsOpen: boolean;
  autoApprovableTools: string[];
  /** 弹卡档位（输入框三档；当前会话生效档 = 会话覆盖 ?? 宿主默认 review）。 */
  approvalPose: ApprovalPose;
  /** 插件目录（manifest 派生人类视图：唯一插件实体清单 + 提供物分类）。 */
  pluginsCatalog: PluginsCatalog;
  /** execution.run 在途标记（W7E 执行树接线；true = 回执未落位）。 */
  executionRunning: boolean;
}

/** 产品壳动作面（适配器消费的宿主回调；缺省 no-op 由宿主兜底）。 */
export interface ProductShellActions {
  onTabChange(tab: MainTab): void;
  onTitleChange(title: string): void;
  onOpenSettings(): void;
  onCloseSettings(): void;
  onAddWorkspace(): void;
  onSend(text: string, attachments: AttachmentAsset[], model?: ModelSelection): void;
  onAbort(): void;
  onAttachments(assets: AttachmentAsset[]): void;
  onAgentModelSelect(modelId: string, providerId?: string): void;
  /** 输入框弹卡档位切换：会话级覆盖写入；无活动会话 = 写宿主默认。 */
  onApprovalPoseChange(pose: ApprovalPose): void;
  onSpawnSelect(index: number): void;
  onSpawnSendInstruction(text: string): void;
  onSelectSession(id: string): void;
  onCreateSession(): void;
  onRenameSession(id: string, title: string): void;
  onDeleteSession(id: string): void;
  onResolveReview(resolution: ReviewResolution, editedContent?: string, payload?: Record<string, unknown>): void;
  /**
   * execution.run 会话入口：当前窗口发起一次执行运行（可空 task，缺省
   * 由实现侧承接最近用户输入）；回执投影落 state.executionRuns 执行树卡。
   */
  onExecutionRun(task?: string): void;
}

/** UIRenderer product chrome 载荷（product 字段名与 actions 扁平合并）。 */
export type ProductShellChrome = Partial<ProductShellModel> & Partial<ProductShellActions>;
