# docs/checklist.md

**用途**：加插件/加包/跨层改动时的「填空模板」与检查阶梯——不自由发挥。
层权威文档 = 各层 `AGENTS.md` + `docs/subsystems/{engine,plugins,renderer,host,exec}.md`；
本文件只给「怎么做 + 检查什么」，真源/语义一律回指层文档。

## 0. 改任何一层前（检查阶梯 0）

- [ ] 先读对应 `docs/subsystems/<层>.md` + 该层 `AGENTS.md`（改哪层先读哪层）；
- [ ] 跨层（引擎↔宿主↔插件↔显示面）契约改动：先写/改真源声明 + spec，再谈代码；
- [ ] 决策留痕：有取舍/语义拍板 → 在 `docs/plugin_issues.md` 追加决策行（编号连续、
      日期、拍板内容、落点文件），与变更同提交（不留「口头决定」）。

## 1. 加插件 = 填空（模板）

`plugins/<kind>/<id>/`（kind ∈ tool|command|ui_feature|endpoint|mcp）：

- [ ] `spec.json`：id=目录名、kind、capability、data.*（逐字承载行为声明）；
      ui_feature 叶子/设置面板声明 `faces.ui`（target=web + entry 相对路径）；
      host logic face 声明 `faces.logic` + 按需 `depends`（端口词表见
      `engine/src/dock/ports.ts`）。
- [ ] `package.json`：npm 包名 `@ink-ts/plugin-<kebab>`（下划线/点号转连字符）。
- [ ] 独占实现面（真面）才建 `faces/*/` + 同目录 `*.test.ts(x)`；data-only 不填
      占位 faces/depends/contract（防第二份平行真相）。
- [ ] AGENTS 政策：真面/样板插件补 `AGENTS.md`（意图/边界/数据从哪进，不重复
      spec）；data-only 免写。
- [ ] 布局接入（ui_feature 叶子）：父容器 children 补 `$ref`；设置面板 =
      `data.settings_section`（key/label/order/icon），不入布局树。
- [ ] 重跑生成器：`node plugins/scripts/sync_plugin_manifest.mjs`（派生 7 视图）。
- [ ] 卸载预检：`tsx plugins/scripts/verify_unload.ts --plan <id>`（有活动下游/
      父容器 $ref 即阻断，fail-closed）。
- [ ] 测试与覆盖：新插件单测随 faces 同住；不可达分支写真实理由注释（见 §4）。
- [ ] 同步纪律：工具清单/命令表/数量表述动文档前先对码源码（根 AGENTS 纪律 2）。

## 2. 加包/加 workspace（模板）

- [ ] 目录入 root `package.json` workspaces + `npm install` 重链 lockfile；
- [ ] `tsconfig.json` extends 相对路径正确（`hosts/web` 这类两级目录 =
      `../../tsconfig.base.json`）；`@`/`@app` 别名在 tsconfig paths 与
      vite/vitest alias 双写（plugins 与 hosts/web 同构）；
- [ ] root `npm test` 链加对应 `vitest run --root <pkg>`（位置随依赖序）；
- [ ] gate `lineScanDirs`、self_check `symbols.ts` INDEX_DIRS、行数/UTF-8 扫描集
      同步；
- [ ] 层 AGENTS + `docs/subsystems/<层>.md` 目录语义段更新（物理形态为准）；
- [ ] 引例/脚本/注释路径全量改指（参考 Step1/Step2 提交的路径同步清单）。

## 3. 文案 / token 有源

- [ ] web 可见文案：走 locale（`@/i18n/useT`；目标态 locale 随插件走），
      不硬编码中文字面量于组件；
- [ ] 色值：只走语义 token/designTokens 与 `--ink-*` token 白名单
      （themeTokens.ts 同源），禁硬编码颜色；
- [ ] 行为承诺（界面文案/命令名/参数模式）：与 CODING §11 语义标签端到端对链
      （语义标签沿调用链能找到执行点，孤儿语义标签按阻塞报）。

## 4. 覆盖纪律

- [ ] 每插件/每机制实现带 vitest 对标测试；逻辑全在数据层（插件只收 props +
      经 bind/AppBackend/chrome 取数），倒逼可测；
- [ ] 目标：每插件 100% 覆盖门禁；不可达分支必须写真实理由（非「写不完」）。
      当前无全局覆盖率阈值强制（覆盖率 CI 门禁未启用）——未达门禁的新插件须
      在 PR/commit 说明中给覆盖统计与豁免理由，待覆盖率门禁启用后回填。

## 5. 提交前一键（检查阶梯 3）

- [ ] `npm --prefix ink-ts run typecheck`（全 workspace）
- [ ] `npm --prefix ink-ts run gate`（架构门禁真实扫描）
- [ ] `npm --prefix ink-ts test`（引擎/cli/lib/web/renderer/plugins vitest +
      contracts:verify + verify:mechanisms/bridge-mount/plugin-manifest/unload/
      host-spec 全链）
- [ ] CI 全量红绿 = root `.github/workflows/ci.yml` ink-ts job 同链（typecheck →
      gate → test → contracts:verify）；本链新包增删同步该 job（走 npm scripts，
      一般无需改 workflow）。
- [ ] 决策留痕/落地状态随变更提交（本 checklist 在 `docs/checklist.md`，勿删）。
