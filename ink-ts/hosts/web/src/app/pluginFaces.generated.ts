/**
 * 生成文件勿手改：web 产品壳插件 ui 面注册派生视图（真源 = plugins/ui_features/<id>/spec.json
 * 的 faces.ui + data.node（kind=component））。由 plugins/scripts/sync_plugin_manifest.mjs
 * 生成（按插件 id 升序静态 import 各真 ui 面 entry + registerComponent 白名单注册）；
 * hosts/web 装配期经 registerPluginFaces() 调用；verify:plugin-manifest 强制逐字一致。
 * 默认导出注册前套 accessAwareFace 包装（hosts/web 壳装配层按 spec
 * faces.ui.access 切片注入——声明 access 的面只收声明名，未声明 = 原样透传）。
 */

import type { PlainComponent } from '@/renderer/componentRegistry';
import { registerComponent } from '@/renderer/componentRegistry';
import { accessAwareFace } from './shell/accessAwareFace';

export interface UiFaceEntry {
  id: string;
  type: string;
  entry: string;
}

export const PLUGIN_UI_FACES: UiFaceEntry[] = [
  { id: 'review_card', type: 'review_card', entry: '../../../../plugins/ui_features/review_card/faces/ui/index.tsx' },
  { id: 'settings_floater', type: 'settings_floater', entry: '../../../../plugins/ui_features/settings_floater/faces/ui/index.tsx' },
  { id: 'file_tree', type: 'file_tree', entry: '../../../../plugins/ui_features/file_tree/faces/ui/index.tsx' },
  { id: 'top_bar', type: 'top_bar', entry: '../../../../plugins/ui_features/top_bar/faces/ui/index.tsx' },
  { id: 'message_list', type: 'message_list', entry: '../../../../plugins/ui_features/message_list/faces/ui/index.tsx' },
  { id: 'task_capsule', type: 'task_capsule', entry: '../../../../plugins/ui_features/task_capsule/faces/ui/index.tsx' },
  { id: 'agent_input', type: 'agent_input', entry: '../../../../plugins/ui_features/agent_input/faces/ui/index.tsx' },
  { id: 'evolution_feed', type: 'evolution_feed', entry: '../../../../plugins/ui_features/evolution_feed/faces/ui/index.tsx' },
  { id: 'mechanism_view', type: 'mechanism_view', entry: '../../../../plugins/ui_features/mechanism_view/faces/ui/index.tsx' },
  { id: 'trajectory_view', type: 'trajectory_view', entry: '../../../../plugins/ui_features/trajectory_view/faces/ui/index.tsx' },
  { id: 'session_list', type: 'session_list', entry: '../../../../plugins/ui_features/session_list/faces/ui/index.tsx' },
  { id: 'settings_general', type: 'settings_general', entry: '../../../../plugins/ui_features/settings_general/faces/ui/index.tsx' },
  { id: 'settings_model', type: 'settings_model', entry: '../../../../plugins/ui_features/settings_model/faces/ui/index.tsx' },
  { id: 'settings_connect', type: 'settings_connect', entry: '../../../../plugins/ui_features/settings_connect/faces/ui/index.tsx' },
  { id: 'settings_knowledge', type: 'settings_knowledge', entry: '../../../../plugins/ui_features/settings_knowledge/faces/ui/index.tsx' },
  { id: 'settings_architecture', type: 'settings_architecture', entry: '../../../../plugins/ui_features/settings_architecture/faces/ui/index.tsx' },
  { id: 'plugins', type: 'plugins', entry: '../../../../plugins/ui_features/plugins/faces/ui/index.tsx' },
  { id: 'workspace_auth', type: 'workspace_auth', entry: '../../../../plugins/ui_features/workspace_auth/faces/ui/index.tsx' },
  { id: 'ui_editor_host', type: 'ui_editor_host', entry: '../../../../plugins/ui_features/ui_editor_host/faces/ui/index.tsx' },
  { id: 'settings_memory', type: 'settings_memory', entry: '../../../../plugins/ui_features/settings_memory/faces/ui/index.tsx' },
  { id: 'settings_insights', type: 'settings_insights', entry: '../../../../plugins/ui_features/settings_insights/faces/ui/index.tsx' },
  { id: 'settings_audit_recovery', type: 'settings_audit_recovery', entry: '../../../../plugins/ui_features/settings_audit_recovery/faces/ui/index.tsx' },
  { id: 'settings_backup', type: 'settings_backup', entry: '../../../../plugins/ui_features/settings_backup/faces/ui/index.tsx' },
] as const;

/** 装配期调用：把各真 ui 面插件的默认导出注册进渲染器白名单。 */
export function registerPluginFaces(): void {
  registerComponent('review_card', accessAwareFace('review_card', (review_cardDefault as unknown) as PlainComponent));
  registerComponent('settings_floater', accessAwareFace('settings_floater', (settings_floaterDefault as unknown) as PlainComponent));
  registerComponent('file_tree', accessAwareFace('file_tree', (file_treeDefault as unknown) as PlainComponent));
  registerComponent('top_bar', accessAwareFace('top_bar', (top_barDefault as unknown) as PlainComponent));
  registerComponent('message_list', accessAwareFace('message_list', (message_listDefault as unknown) as PlainComponent));
  registerComponent('task_capsule', accessAwareFace('task_capsule', (task_capsuleDefault as unknown) as PlainComponent));
  registerComponent('agent_input', accessAwareFace('agent_input', (agent_inputDefault as unknown) as PlainComponent));
  registerComponent('evolution_feed', accessAwareFace('evolution_feed', (evolution_feedDefault as unknown) as PlainComponent));
  registerComponent('mechanism_view', accessAwareFace('mechanism_view', (mechanism_viewDefault as unknown) as PlainComponent));
  registerComponent('trajectory_view', accessAwareFace('trajectory_view', (trajectory_viewDefault as unknown) as PlainComponent));
  registerComponent('session_list', accessAwareFace('session_list', (session_listDefault as unknown) as PlainComponent));
  registerComponent('settings_general', accessAwareFace('settings_general', (settings_generalDefault as unknown) as PlainComponent));
  registerComponent('settings_model', accessAwareFace('settings_model', (settings_modelDefault as unknown) as PlainComponent));
  registerComponent('settings_connect', accessAwareFace('settings_connect', (settings_connectDefault as unknown) as PlainComponent));
  registerComponent('settings_knowledge', accessAwareFace('settings_knowledge', (settings_knowledgeDefault as unknown) as PlainComponent));
  registerComponent('settings_architecture', accessAwareFace('settings_architecture', (settings_architectureDefault as unknown) as PlainComponent));
  registerComponent('plugins', accessAwareFace('plugins', (pluginsDefault as unknown) as PlainComponent));
  registerComponent('workspace_auth', accessAwareFace('workspace_auth', (workspace_authDefault as unknown) as PlainComponent));
  registerComponent('ui_editor_host', accessAwareFace('ui_editor_host', (ui_editor_hostDefault as unknown) as PlainComponent));
  registerComponent('settings_memory', accessAwareFace('settings_memory', (settings_memoryDefault as unknown) as PlainComponent));
  registerComponent('settings_insights', accessAwareFace('settings_insights', (settings_insightsDefault as unknown) as PlainComponent));
  registerComponent('settings_audit_recovery', accessAwareFace('settings_audit_recovery', (settings_audit_recoveryDefault as unknown) as PlainComponent));
  registerComponent('settings_backup', accessAwareFace('settings_backup', (settings_backupDefault as unknown) as PlainComponent));
}

import review_cardDefault from '../../../../plugins/ui_features/review_card/faces/ui/index.tsx';
import settings_floaterDefault from '../../../../plugins/ui_features/settings_floater/faces/ui/index.tsx';
import file_treeDefault from '../../../../plugins/ui_features/file_tree/faces/ui/index.tsx';
import top_barDefault from '../../../../plugins/ui_features/top_bar/faces/ui/index.tsx';
import message_listDefault from '../../../../plugins/ui_features/message_list/faces/ui/index.tsx';
import task_capsuleDefault from '../../../../plugins/ui_features/task_capsule/faces/ui/index.tsx';
import agent_inputDefault from '../../../../plugins/ui_features/agent_input/faces/ui/index.tsx';
import evolution_feedDefault from '../../../../plugins/ui_features/evolution_feed/faces/ui/index.tsx';
import mechanism_viewDefault from '../../../../plugins/ui_features/mechanism_view/faces/ui/index.tsx';
import trajectory_viewDefault from '../../../../plugins/ui_features/trajectory_view/faces/ui/index.tsx';
import session_listDefault from '../../../../plugins/ui_features/session_list/faces/ui/index.tsx';
import settings_generalDefault from '../../../../plugins/ui_features/settings_general/faces/ui/index.tsx';
import settings_modelDefault from '../../../../plugins/ui_features/settings_model/faces/ui/index.tsx';
import settings_connectDefault from '../../../../plugins/ui_features/settings_connect/faces/ui/index.tsx';
import settings_knowledgeDefault from '../../../../plugins/ui_features/settings_knowledge/faces/ui/index.tsx';
import settings_architectureDefault from '../../../../plugins/ui_features/settings_architecture/faces/ui/index.tsx';
import pluginsDefault from '../../../../plugins/ui_features/plugins/faces/ui/index.tsx';
import workspace_authDefault from '../../../../plugins/ui_features/workspace_auth/faces/ui/index.tsx';
import ui_editor_hostDefault from '../../../../plugins/ui_features/ui_editor_host/faces/ui/index.tsx';
import settings_memoryDefault from '../../../../plugins/ui_features/settings_memory/faces/ui/index.tsx';
import settings_insightsDefault from '../../../../plugins/ui_features/settings_insights/faces/ui/index.tsx';
import settings_audit_recoveryDefault from '../../../../plugins/ui_features/settings_audit_recovery/faces/ui/index.tsx';
import settings_backupDefault from '../../../../plugins/ui_features/settings_backup/faces/ui/index.tsx';
