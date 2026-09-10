# kernel/tool_vetting — 工具可信度闸门（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` + `engine/AGENTS.md`

## 定位

MCP/外挂工具挂载前的可信度闸门（`tool_vetting.py` 移植）：清单校验 →
静态审查 → 判定，附观察模式（影子运行）。安全边界 fail-closed：未知来源且
无签名拒绝、权限声明逐项解析非法拒绝、哈希须 sha256 hex 64 字符、零权限
声明拒绝；静态审查命中降级 review（strict 直接 rejected）；影子运行写
虚拟化、结果恒 untrusted。与 `kernel/tool_pipeline` 分工：本机制管「挂载前
信任」，tool_pipeline 管「运行中执行」。

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `_types.ts` | 值面枚举类 `ToolSource`（market/github/ai_generated/unknown + `is_valid`）/`VettingVerdict`（verified/review/rejected）；`ToolManifest`（name/source/signature/hashes/permissions/dependencies/meta，构造即 freeze，`from_dict` 逐项校验）；`VettingCheck`/`ShadowWrite`/`ShadowRunResult`/`VettingResult`；钩子形态 `StaticHook`/`ShadowExecutor`；`FsSeam`（12 原语注入面）；`pyRepr`（错误消息携带注入值形态）——跨域契约模块 |
| `tool_vetting.ts` | `ToolVetting.vet(manifest, code_paths, {strict})`：`_check_manifest`（来源/签名/权限声明 `parse_permission` 逐项/哈希长度+hex）→ 静态审查钩子逐个执行（异常按违规计入，`static_hook_N` 逐项可审计）→ 判定（命中默认 review/strict rejected/通过 verified）；`shadow_run(executor, args, {workdir})`：影子区拷贝（symlink 按链接复制防逃逸）→ 执行前 `rglob`+`stat_size` 快照 → 执行 → 前后 diff → 写操作清单（write/modify/delete）→ finally rmtree；`code_files_exist` 出厂前置钩子（ENG6-7）；`unavailableFs()` fail-closed 兜底 |
| `contract.ts` | `tool_vetting_contract: MechanismContract`：id `'tool_vetting'`、effects `[]`（纯判定 + 注入 FsSeam，非 storage seam）、depends `['permissions']` |

## 对外契约面

公共面零导出：`src/index.ts` 逐名 grep 无 tool_vetting 任何名（`ToolVetting`/
`ToolManifest`/`FsSeam`/`VettingResult` 等仅引擎内部与 adapters 消费）——
宿主经 `@ink-ts/engine` 不可达，属引擎内部机制面。

目录导出面（`tool_vetting.ts` 转出）：类 `ToolVetting` `ToolSource`
`ToolManifest` `ShadowRunResult` `ShadowWrite` `VettingCheck` `VettingResult`
`VettingVerdict`；函数 `code_files_exist`；类型 `FsSeam`/`ShadowExecutor`/
`StaticHook`/`ToolSourceValue`。`_types.ts` 另导出 `pyRepr`（未随
`tool_vetting.ts` 转出）。机制契约 `tool_vetting_contract` 经
`kernel/registry/contracts.ts` 入全量注册表（34 机制）。

## 数据形态

- 判定枚举（StrEnum 镜像为静态常量类，字段存值面字符串 + `is_valid` 白名单）：
  `ToolSource` market/github/ai_generated/unknown；`VettingVerdict`
  verified/review/rejected。
- `ToolManifest`：source 缺省 unknown；hashes = 文件 → sha256 hex（64 字符）
  dict；permissions/dependencies = 非空字符串清单；meta = dict。
- `VettingCheck`（name/ok/detail）；`ShadowWrite`（path/operation/size）；
  `ShadowRunResult`（ok/writes/output/error/`untrusted` 缺省 true）；
  `VettingResult`（ok/verdict/checks/shadow/reason）——verdict=review 时
  `ok=true`（ok 语义 = 未 rejected，需人工确认）。
- `FsSeam` 12 原语：`mkdtemp`/`rmtree`/`is_dir`/`is_file`/`is_symlink`/
  `readlink`/`copy2`/`symlink_to`/`mkdir`/`iterdir`/`rglob`/`stat_size`
  （对齐 os/shutil/tempfile stdlib 语义；路径以字符串表达；stat 失败返回
  null = 快照跳过）。

## Seam 与 IO 边界

机制契约 effects 为空：清单校验与静态审查为纯判定（权限声明经
`parse_permission` 逐项解析）；影子运行的工作区副本/快照 diff/写虚拟化经
注入 `FsSeam` 执行（文件系统 seam，不读写 Storage 记录集合）；观察执行体为
注入 `ShadowExecutor`（回调执行，非进程 spawn 信封面）。未注入 fs 的实例
触碰文件面即抛错（`unavailableFs()`，zero-IO core 的 fail-closed）；无
logger、无时间/随机 seam（确定性）。真实 fs 后端在 `adapters/mcp/
_fs_seam.ts`（node:fs 同步装，供 `ToolVetting.shadow_run`）。

## 装配与消费

- runtime 装配默认构造 `new ToolVetting()`（`_runtime_assemble`，缺省无
  宿主钩子——静态审查仍含 `code_files_exist` 基线），`_runtime_base.vetting`
  持有；`runtime_contract` depends 含 tool_vetting。
- `adapters/mcp` 为主要消费方：`convert.ts` 把 MCP 工具声明转 `ToolManifest`
  （source 经 `ToolSourceValue`）、`manager.ts` 持 vetting 闸门调用面
  （真实 `ToolVetting` 或测试桩）、`_fs_seam.ts` 注入 FsSeam 真实装、
  `registry.ts`/`config.ts` 用 `ToolSource` 分类。
- 机制契约经 `kernel/registry/contracts.ts` 汇总（verify:mechanisms 三键）。

## 不变式与门禁

- fail-closed 清单闸门：来源未知且无签名 / 权限声明非法 / 哈希长度或 hex
  非法 / 未声明权限 → manifest check 拒 → 总体 REJECTED。
- ENG6-7 静态审查非空操作：出厂基线附带 `code_files_exist`（声明代码文件
  必须真实存在），宿主钩子叠加不替换——杜绝「零钩子 = 审查空操作」。
- 静态审查命中：默认降级 review（需人工）、strict 直接 rejected；钩子异常
  计为违规（不静默跳过）。
- 影子运行写虚拟化：独立工作目录副本 + 快照 diff，写操作只记录不落真实
  工作区；结果恒 `untrusted=true`（观察数据只作行为证据，不作信任依据）。
- 影子区 symlink 按链接复制（防逃逸）；`rmtree(ignore_errors=true)` 清理
  兜底；`stat_size` 失败跳过该文件快照。

## 测试

镜像测试 `test/kernel/tool_vetting/tool_vetting.test.ts`（5 组）：清单校验
（ToolManifest）、vet 清单闸门 fail-closed、vet 静态审查命中判定、shadow_run
观察模式（写虚拟化属真实 fs seam，验机制环）、code_files_exist 存在性前置
钩子。

## 疑点与不一致

1. `VettingVerdict` 类注释（`_types.ts`「总体判定（approved/review/
   rejected）」）写 `approved`，实际值面为 `verified`/review/rejected——
   注释与代码不符。
2. `pyRepr` 多份拷贝并存：`core/py_repr.ts` 注释自认单源（已就绪），本目录
   `_types.ts` 与 `kernel/builder/_types`、`kernel/self_tools/_json`、
   `kernel/self_proposal` 各持一份（grep「export function pyRepr」核验）；
   `_types.ts` 头注释自述以 core/py_repr.ts 为迁移点但本文件实现未迁移。
3. `_is_hex` 容忍 `0x` 前缀（对齐 Python `int(digest, 16)`）与
   `_HASH_LENGTH`=64 硬长度校验并存：`0x`+62 位 hex 可通过两道校验、
   `0x`+64 位被长度拒——两道校验口径不一致，测试未见覆盖该边界。
4. `vet()` 违规 `reason` 仅取前 5 条（`static_violations.slice(0, 5)`）——
   截断口径无常量化与显式说明。
