# host 层（docs/subsystems/host.md）

**层权威**：改 hosts/ 先读本文件 + `hosts/AGENTS.md`；本层跨子包（lib/cli/web）
边界以 CODING §1 术语为准；spec 数据面见 `hosts/lib/src/host_spec.ts`（单一真源）。

## 定位

hosts/ = **宿主仓**：kind=host 装配期 spec（tauri/cli/web/ide 四份
`*.spec.json` 平铺）+ 宿主实现同住。哲学：**宿主 = 面插件（换宿主像换插件）**——
只换 IO/传输/呈现面，不换机制语义（机制语义属 engine core，宿主不得复制）。

```
hosts/
├─ AGENTS.md                 # 宿主面契约（就近权威）
├─ lib/                      # @ink-ts/host 装配库（L4 composition root）：
│   │                        #   createHost/loadHostSpec/binary/face loader/recipe/bridge
│   └─ scripts/verify_bridge_mount.ts   # 命令声明即挂载 verify
├─ cli/                      # @ink-ts/cli 唯一进程载体（stdio/run/serve/tui）
│   └─ src/tui/              #   cli 宿主终端呈现面
├─ web/                      # @ink-ts/web web 产品壳（浏览器呈现面 + 产品 chrome）
│   └─ src/                  #   App/main/activate/state/shell/views + pluginFaces 注册
├─ <surface>.spec.json       # tauri/cli/web/ide 宿主 spec（kind='host'，HostFaces）
└─ verify_host_spec.ts       # spec 数据/装配面一致性审计（root test 链强制）
```

## 分层语义

- **spec 四件套**：cli/web = 本仓装配 `implemented=true`（renderer.entry 真实
  存在于仓库根：cli→`hosts/cli/src/tui`、web→`hosts/web/src`）；tauri/ide =
  外部壳仓装配 `implemented=false`（占位，换宿主 = 外部壳读 spec + 重启装配）。
  形状校验 = `hosts/lib/src/host_spec.ts` validateHostSpec（HostFaces 词汇）；
  存在性/不变式 = verify_host_spec.ts。
- **lib（装配层）**：只做「选适配、读配置、注入 seam」与薄接线——装配 engine
  Runtime、实现 Host 五件套、构建产品配方、出宿主命令面 bridge。不写 main、
  不监听端口、不是进程；被 hosts/cli 与 vitest 链 import。
- **cli（进程层）**：唯一进程载体（含 main + stdio/run/serve/tui 四形态）。
  tui 是 cli 宿主的终端呈现面；serve 出 http+ws 供 web 呈现面消费。
- **web（产品壳层）**：浏览器呈现面。产品 chrome（App/activate/state/shell/
  productView/views/AppBackend）+「宿主数据/动作 → 显示设备」装配单点；
  index.html/main/vite dev&build 在此；显示设备 = renderer（@ink-ts/renderer，
  单向 import）；真 ui 面注册生成物 pluginFaces.generated.ts 与设置派生清单
  settingsSections.generated.ts 随壳同住。cli 与 web 均跑同一 bootstrap 进程
  （`bootstrap/main.ts` 唯一进程入口按 spec 委托 hosts/cli runCliMain）。

## 命令面与生成物

- 命令声明真源 = plugins/commands → 生成 `commands.generated.ts`；host 域
  实现文件只允许 `import type`/re-export 取用，方法名不手写数组
  （verify:bridge-mount 强制：BRIDGE_METHODS 数组体只允许各域 `*_COMMANDS`
  spread）。
- 原生执行件定位 = plugins/endpoints → `native.generated.ts`（binary.ts 按
  声明定位，手写 env/文件名表已删）。
- 界面白名单 = ui_canonical.generated.ts（host recipe 装配面）。

## 验证

- `vitest run --root hosts/lib`、`vitest run --root hosts/cli`、
  `vitest run --root hosts/web`；`tsc -p` 各子包 typecheck。
- verify 链：`tsx hosts/lib/scripts/verify_bridge_mount.ts`、
  `tsx hosts/verify_host_spec.ts`；root `npm test` 全链收口。
- 改 spec / AGENTS / CODING 后跑 `tsx gate/src/check.ts`（架构门禁含 hosts
  lib·cli·web 目录扫描）。
