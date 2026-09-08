import { createAppBackend, type AppBackend } from '@app/backend';
import { UiEditorHost } from './UiEditorHost';

/**
 * ui_editor_host ui 面入口：设置「界面编辑器」面板声明式接入。
 *
 * spec faces.ui.access store:["appBackend"] —— 壳装配层（hosts/web
 * settings_floater 经 sliceUiAccess 按声明切片）注入共享 AppBackend 单例，
 * 不再模块级自建。缺注入路径（壳外直接挂载）时惰性回退自建实例，
 * 保证不白屏。
 */

let fallbackBackend: AppBackend | undefined;

function getFallbackBackend(): AppBackend {
  fallbackBackend ??= createAppBackend();
  return fallbackBackend;
}

export default function UiEditorHostEntry(props: Record<string, unknown>) {
  const backend = (props.appBackend as AppBackend | undefined) ?? getFallbackBackend();
  return <UiEditorHost backend={backend} />;
}
