# settings_general（per-plugin AGENTS）

设置面板真 ui 面样板（设置「通用」段：外观三档卡片 + 语言）。声明真源 = 本目录
`spec.json`（kind=ui_feature、faces.ui target=web、data.node + 面板插件的
`data.settings_section`（key/label/order/icon））——本文件只写意图/边界。

## 是什么能力

设置浮层内「通用」面板（即改即存，无保存按钮）：
- 外观三档（浅色/深色/跟随系统）：主题走设备 `@/renderer/themeMode` 控制器
  （themeMode 管 data-theme 持久档位，themeTokens 白名单落地 CSS 变量）；
- 语言（简中/English）：走 `@/i18n/useT` setLocale/useT（文案包当前共用
  renderer/src/locales；目标态 locale 随插件走）。

## 数据从哪进 / 挂载

- 挂载：不经布局树 $ref——经生成器 settingsSections.generated.ts（住
  hosts/web/src/app/settings/）settings 派生清单引用；设置浮层
  （settings_floater 插件）读清单渲染左导航，内容按插件 id 经
  DynamicComponent name=settings_general 渲染（真源注册 = pluginFaces
  generated 静态 import 本 faces/ui/index.tsx 默认导出）。
- 即改即存由各段自管：主题 = themeMode 控制器（持久档位写 localStorage），
  语言 = setLocale 切换 useT 文案上下文；不落 engine 数据面。
- 同目录 `*.test.tsx` 走 jsdom + RTL（plugins vitest）。
