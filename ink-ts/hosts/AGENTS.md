# hosts 宿主面契约（AGENTS.md）

hosts/ = **宿主仓**：kind=host 装配期 spec（tauri/cli/web/ide 四份
`*.spec.json` 平铺）+ 宿主实现同住。**宿主 = 面插件（换宿主像换插件）**——只换
IO/传输/呈现面，不换机制语义（机制语义属 engine core，宿主不得复制）。详细
目录/命令面/验证见 `docs/subsystems/host.md`（跨层权威）与 CODING §1 术语。

## 本仓放什么

```
hosts/
├─ lib/    @ink-ts/host  装配库（L4 composition root）：createHost/loadHostSpec/
│                         binary/face loader/recipe/bridge——只装配不实现机制
├─ cli/    @ink-ts/cli   唯一进程载体（stdio/run/serve/tui；含 main）
├─ web/    @ink-ts/web   web 产品壳（浏览器呈现面 + 产品 chrome + 装配单点）
├─ *.spec.json           tauri/cli/web/ide 宿主 spec（kind='host'，HostFaces）
└─ verify_host_spec.ts   spec 数据/装配面一致性审计（root test 链强制）
```

## spec 四件套不变式

- cli/web = 本仓装配 `implemented=true`，`renderer.entry` 真实存在
  （cli→`hosts/cli/src/tui`、web→`hosts/web/src`）；tauri/ide = 外部壳仓
  `implemented=false`（换宿主 = 外部壳读 spec + 重启装配）。
- 形状校验单一真源 = `hosts/lib/src/host_spec.ts`（validateHostSpec：
  HostFaces 词汇），存在性/不变式 = verify_host_spec.ts；改表面/入口须同改
  本文件、spec 与 verify 注释。

## 子包纪律

- **lib**：只做「选适配、读配置、注入 seam」与薄接线；不写 main、不监听端口、
  不是进程；命令方法名不手写数组（verify:bridge-mount：BRIDGE_METHODS 只允许
  各域 `*_COMMANDS` spread）。
- **cli**：唯一进程载体；tui = cli 宿主终端呈现面，serve 出 http+ws 供 web。
- **web**：产品壳（App/activate/state/shell/productView/views/AppBackend +
  index.html/main/vite）；显示设备 = renderer（单向 import）；真 ui 面注册
  （pluginFaces.generated.ts）与设置派生清单随壳；`@app` 别名 = 本包 src/app，
  `@` = renderer/src（见 renderer/AGENTS.md 与 docs/subsystems/renderer.md）。
- 任何子包禁把 engine 机制语义（审批/补丁链/审计/闸门/沙箱判定）复制进宿主。

## 验证命令

- `vitest run --root hosts/lib | hosts/cli | hosts/web`、各子包 `tsc -p`
- `tsx hosts/lib/scripts/verify_bridge_mount.ts`、`tsx hosts/verify_host_spec.ts`
- root `npm test` 全链收口（含 gate 扫描 hosts lib·cli·web）
