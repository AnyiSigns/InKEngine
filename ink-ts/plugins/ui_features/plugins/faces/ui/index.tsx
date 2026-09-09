import { createAppBackend, type AppBackend } from '@app/backend';
import { derivePluginsCatalog, type PluginsCatalog } from '@app/pluginsCatalog';
import { PluginsPanel } from './PluginsPanel';

/**
 * plugins ui 面入口：设置「插件」面板声明式接入。
 *
 * spec faces.ui.access store:["appBackend","pluginsCatalog"] —— 壳装配层
 * （hosts/web settings_floater 经 sliceUiAccess 按声明切片）注入共享 AppBackend
 * 单例与 manifest 派生目录；缺注入路径（壳外直接挂载/测试）时惰性回退自建 +
 * derivePluginsCatalog()，保证不白屏。
 */

let fallbackBackend: AppBackend | undefined;

function getFallbackBackend(): AppBackend {
  fallbackBackend ??= createAppBackend();
  return fallbackBackend;
}

export default function PluginsPanelEntry(props: Record<string, unknown>) {
  const backend = (props.appBackend as AppBackend | undefined) ?? getFallbackBackend();
  const catalog = (props.pluginsCatalog as PluginsCatalog | undefined) ?? derivePluginsCatalog();
  return <PluginsPanel backend={backend} catalog={catalog} />;
}
