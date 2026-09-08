/**
 * 生成文件勿手改：渲染器插件 ui 面注册派生视图（真源 = plugins/ui_features/<id>/spec.json
 * 的 faces.ui + data.node（kind=component））。由 plugins/scripts/sync_plugin_manifest.mjs
 * 生成（按插件 id 升序静态 import 各真 ui 面 entry + registerComponent 白名单注册）；
 * renderer 装配期经 registerPluginFaces() 调用；verify:plugin-manifest 强制逐字一致。
 */

import type { PlainComponent } from '../renderer/componentRegistry';
import { registerComponent } from '../renderer/componentRegistry';

export interface UiFaceEntry {
  id: string;
  type: string;
  entry: string;
}

export const PLUGIN_UI_FACES: UiFaceEntry[] = [
  { id: 'review_card', type: 'review_card', entry: '../../../plugins/ui_features/review_card/faces/ui/index.tsx' },
  { id: 'file_tree', type: 'file_tree', entry: '../../../plugins/ui_features/file_tree/faces/ui/index.tsx' },
  { id: 'top_bar', type: 'top_bar', entry: '../../../plugins/ui_features/top_bar/faces/ui/index.tsx' },
  { id: 'message_list', type: 'message_list', entry: '../../../plugins/ui_features/message_list/faces/ui/index.tsx' },
  { id: 'task_capsule', type: 'task_capsule', entry: '../../../plugins/ui_features/task_capsule/faces/ui/index.tsx' },
  { id: 'agent_input', type: 'agent_input', entry: '../../../plugins/ui_features/agent_input/faces/ui/index.tsx' },
  { id: 'evolution_feed', type: 'evolution_feed', entry: '../../../plugins/ui_features/evolution_feed/faces/ui/index.tsx' },
  { id: 'mechanism_view', type: 'mechanism_view', entry: '../../../plugins/ui_features/mechanism_view/faces/ui/index.tsx' },
  { id: 'ledger_view', type: 'ledger_view', entry: '../../../plugins/ui_features/ledger_view/faces/ui/index.tsx' },
  { id: 'trajectory_view', type: 'trajectory_view', entry: '../../../plugins/ui_features/trajectory_view/faces/ui/index.tsx' },
  { id: 'todo_view', type: 'todo_view', entry: '../../../plugins/ui_features/todo_view/faces/ui/index.tsx' },
  { id: 'session_list', type: 'session_list', entry: '../../../plugins/ui_features/session_list/faces/ui/index.tsx' },
  { id: 'settings_general', type: 'settings_general', entry: '../../../plugins/ui_features/settings_general/faces/ui/index.tsx' },
  { id: 'settings_model', type: 'settings_model', entry: '../../../plugins/ui_features/settings_model/faces/ui/index.tsx' },
  { id: 'settings_connect', type: 'settings_connect', entry: '../../../plugins/ui_features/settings_connect/faces/ui/index.tsx' },
  { id: 'settings_knowledge', type: 'settings_knowledge', entry: '../../../plugins/ui_features/settings_knowledge/faces/ui/index.tsx' },
  { id: 'settings_architecture', type: 'settings_architecture', entry: '../../../plugins/ui_features/settings_architecture/faces/ui/index.tsx' },
  { id: 'mcp_market', type: 'mcp_market', entry: '../../../plugins/ui_features/mcp_market/faces/ui/index.tsx' },
  { id: 'tools_panel', type: 'tools_panel', entry: '../../../plugins/ui_features/tools_panel/faces/ui/index.tsx' },
  { id: 'workspace_auth', type: 'workspace_auth', entry: '../../../plugins/ui_features/workspace_auth/faces/ui/index.tsx' },
  { id: 'ui_editor_host', type: 'ui_editor_host', entry: '../../../plugins/ui_features/ui_editor_host/faces/ui/index.tsx' },
  { id: 'settings_memory', type: 'settings_memory', entry: '../../../plugins/ui_features/settings_memory/faces/ui/index.tsx' },
  { id: 'settings_insights', type: 'settings_insights', entry: '../../../plugins/ui_features/settings_insights/faces/ui/index.tsx' },
  { id: 'settings_audit_recovery', type: 'settings_audit_recovery', entry: '../../../plugins/ui_features/settings_audit_recovery/faces/ui/index.tsx' },
  { id: 'settings_backup', type: 'settings_backup', entry: '../../../plugins/ui_features/settings_backup/faces/ui/index.tsx' },
] as const;

/** 装配期调用：把各真 ui 面插件的默认导出注册进渲染器白名单。 */
export function registerPluginFaces(): void {
  registerComponent('review_card', (review_cardDefault as unknown) as PlainComponent);
  registerComponent('file_tree', (file_treeDefault as unknown) as PlainComponent);
  registerComponent('top_bar', (top_barDefault as unknown) as PlainComponent);
  registerComponent('message_list', (message_listDefault as unknown) as PlainComponent);
  registerComponent('task_capsule', (task_capsuleDefault as unknown) as PlainComponent);
  registerComponent('agent_input', (agent_inputDefault as unknown) as PlainComponent);
  registerComponent('evolution_feed', (evolution_feedDefault as unknown) as PlainComponent);
  registerComponent('mechanism_view', (mechanism_viewDefault as unknown) as PlainComponent);
  registerComponent('ledger_view', (ledger_viewDefault as unknown) as PlainComponent);
  registerComponent('trajectory_view', (trajectory_viewDefault as unknown) as PlainComponent);
  registerComponent('todo_view', (todo_viewDefault as unknown) as PlainComponent);
  registerComponent('session_list', (session_listDefault as unknown) as PlainComponent);
  registerComponent('settings_general', (settings_generalDefault as unknown) as PlainComponent);
  registerComponent('settings_model', (settings_modelDefault as unknown) as PlainComponent);
  registerComponent('settings_connect', (settings_connectDefault as unknown) as PlainComponent);
  registerComponent('settings_knowledge', (settings_knowledgeDefault as unknown) as PlainComponent);
  registerComponent('settings_architecture', (settings_architectureDefault as unknown) as PlainComponent);
  registerComponent('mcp_market', (mcp_marketDefault as unknown) as PlainComponent);
  registerComponent('tools_panel', (tools_panelDefault as unknown) as PlainComponent);
  registerComponent('workspace_auth', (workspace_authDefault as unknown) as PlainComponent);
  registerComponent('ui_editor_host', (ui_editor_hostDefault as unknown) as PlainComponent);
  registerComponent('settings_memory', (settings_memoryDefault as unknown) as PlainComponent);
  registerComponent('settings_insights', (settings_insightsDefault as unknown) as PlainComponent);
  registerComponent('settings_audit_recovery', (settings_audit_recoveryDefault as unknown) as PlainComponent);
  registerComponent('settings_backup', (settings_backupDefault as unknown) as PlainComponent);
}

import review_cardDefault from '../../../plugins/ui_features/review_card/faces/ui/index.tsx';
import file_treeDefault from '../../../plugins/ui_features/file_tree/faces/ui/index.tsx';
import top_barDefault from '../../../plugins/ui_features/top_bar/faces/ui/index.tsx';
import message_listDefault from '../../../plugins/ui_features/message_list/faces/ui/index.tsx';
import task_capsuleDefault from '../../../plugins/ui_features/task_capsule/faces/ui/index.tsx';
import agent_inputDefault from '../../../plugins/ui_features/agent_input/faces/ui/index.tsx';
import evolution_feedDefault from '../../../plugins/ui_features/evolution_feed/faces/ui/index.tsx';
import mechanism_viewDefault from '../../../plugins/ui_features/mechanism_view/faces/ui/index.tsx';
import ledger_viewDefault from '../../../plugins/ui_features/ledger_view/faces/ui/index.tsx';
import trajectory_viewDefault from '../../../plugins/ui_features/trajectory_view/faces/ui/index.tsx';
import todo_viewDefault from '../../../plugins/ui_features/todo_view/faces/ui/index.tsx';
import session_listDefault from '../../../plugins/ui_features/session_list/faces/ui/index.tsx';
import settings_generalDefault from '../../../plugins/ui_features/settings_general/faces/ui/index.tsx';
import settings_modelDefault from '../../../plugins/ui_features/settings_model/faces/ui/index.tsx';
import settings_connectDefault from '../../../plugins/ui_features/settings_connect/faces/ui/index.tsx';
import settings_knowledgeDefault from '../../../plugins/ui_features/settings_knowledge/faces/ui/index.tsx';
import settings_architectureDefault from '../../../plugins/ui_features/settings_architecture/faces/ui/index.tsx';
import mcp_marketDefault from '../../../plugins/ui_features/mcp_market/faces/ui/index.tsx';
import tools_panelDefault from '../../../plugins/ui_features/tools_panel/faces/ui/index.tsx';
import workspace_authDefault from '../../../plugins/ui_features/workspace_auth/faces/ui/index.tsx';
import ui_editor_hostDefault from '../../../plugins/ui_features/ui_editor_host/faces/ui/index.tsx';
import settings_memoryDefault from '../../../plugins/ui_features/settings_memory/faces/ui/index.tsx';
import settings_insightsDefault from '../../../plugins/ui_features/settings_insights/faces/ui/index.tsx';
import settings_audit_recoveryDefault from '../../../plugins/ui_features/settings_audit_recovery/faces/ui/index.tsx';
import settings_backupDefault from '../../../plugins/ui_features/settings_backup/faces/ui/index.tsx';
