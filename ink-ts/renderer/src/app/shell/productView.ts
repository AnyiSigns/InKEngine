/**
 * 产品壳视图模型（宿主 → 渲染器 canonical 适配器的装配面）。
 *
 * 产品主壳改由 ui_spec 直渲后，壳层的机制回调与宿主数据经 UIRenderer 的
 * product chrome 统一注入适配器（适配器负责「绑定载荷 + 宿主数据 → 产品
 * 组件 props」的映射）。此处只声明数据形态，不含 React/JSX。
 */

import type { BackendAdapter, ModelArchiveSnapshot, SessionBranchTree } from '@/shared/backend/backendAdapter';
import type { ChannelHub } from '@/shared/session/channelHub';
import type { SessionStore } from '@/shared/session/sessionStore';
import type { InkMessage, RoundStep, SimulationBranch } from '@/shared/session/types';
import type { AttachmentAsset } from '@/shared/session/eventIngest';
import type { SpawnInstance } from '@/app/session/SpawnPanel';
import type { TaskCapsuleData } from '../../../../plugins/ui_features/task_capsule/faces/ui/types';
import type { MainTab, RailSession, ReviewResolution, RoutePlanResult } from '@/app/shell/shellContracts';
import type { ModelSelection } from '@/shared/backend/backendAdapter';

/** 产品壳回显数据（适配器消费的宿主面）。 */
export interface ProductShellModel {
  backend: BackendAdapter;
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
  routePlan: RoutePlanResult | undefined;
  roundCount: number;
  stepCount: number;
  hasTodo: boolean;
  todoPending: number;
  settingsOpen: boolean;
  autoApprovableTools: string[];
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
  onRoutePlanPreview(text: string): void;
  onAgentModelSelect(modelId: string, providerId?: string): void;
  onSpawnSelect(index: number): void;
  onSpawnSendInstruction(text: string): void;
  onBranchFromMessage(messageId: string, branchLabel: string): void;
  onBranchFromLeaf(sessionId: string, leaf: number): void;
  onSelectSession(id: string): void;
  onCreateSession(): void;
  onRenameSession(id: string, title: string): void;
  onDeleteSession(id: string): void;
  onResolveReview(resolution: ReviewResolution, editedContent?: string, payload?: Record<string, unknown>): void;
}

/** UIRenderer product chrome 载荷（product 字段名与 actions 扁平合并）。 */
export type ProductShellChrome = Partial<ProductShellModel> & Partial<ProductShellActions>;
