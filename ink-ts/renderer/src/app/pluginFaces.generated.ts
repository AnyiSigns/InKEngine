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
  { id: 'task_capsule', type: 'task_capsule', entry: '../../../plugins/ui_features/task_capsule/faces/ui/index.tsx' },
  { id: 'todo_view', type: 'todo_view', entry: '../../../plugins/ui_features/todo_view/faces/ui/index.tsx' },
] as const;

/** 装配期调用：把各真 ui 面插件的默认导出注册进渲染器白名单。 */
export function registerPluginFaces(): void {
  registerComponent('task_capsule', (task_capsuleDefault as unknown) as PlainComponent);
  registerComponent('todo_view', (todo_viewDefault as unknown) as PlainComponent);
}

import task_capsuleDefault from '../../../plugins/ui_features/task_capsule/faces/ui/index.tsx';
import todo_viewDefault from '../../../plugins/ui_features/todo_view/faces/ui/index.tsx';
