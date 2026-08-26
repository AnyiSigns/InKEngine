# OS 操作评测（simulated 离线冒烟）

## 1. 实验/测试名称

OSWorld 风格 OS 操作评测 — simulated 后端离线冒烟（评测框架与任务口径自证）

## 2. 实验效果

| 指标 | 结果 | 达标线 | 判定 |
|---|---|---|---|
| 任务通过率 | **3/3（100.0%）** | 离线冒烟无达标率门禁（真实后端 ≥40% 另行判定） | 框架与任务口径可用 |
| 评测框架耗时 | 0.00s（进程整体 < 1s） | — | — |
| 退出码 | 0 | 0 | 通过 |

逐任务明细（与命令输出一致）：

| # | 任务 | 结果 | 断言依据 |
|---|---|---|---|
| 1 | 计算器点击数字键 | PASS | 元素树查到 `label=digit-7` → `ui_click` → 显示屏元素 `value == "7"` |
| 2 | 记事本输入文本 | PASS | 元素树查到 `type=edit` → `ui_type("hello")` → 编辑框 `value == "hello"` |
| 3 | 窗口列表+聚焦+最小化 | PASS | `window_list` ≥2 条 → `focus(w2)` → `minimize(w1)` → 复查 `minimized[w1] == True` |

口径说明：simulated 后端为进程内内存态 UI 树（窗口/元素状态随操作演进），
用于验证**评测框架本身**（驱动接口、任务序列、断言与失败归类）而非真实桌面能力。
真实达标率见同目录 `os操作评测-live-20260826.md`。

## 3. 实验时间

- 起：2026-08-26 16:25:56
- 止：2026-08-26 16:25:57
- 耗时：评测循环 0.00s（3 任务共 9 次驱动调用，纯内存态）
- 同日先前跑批（15:36、16:05 各一次）结果一致：3/3。

## 4. 实验模型

**无**（OS 操作评测不依赖模型：任务为确定性步骤序列 + 断言，无模型推理参与）。

## 5. 相对文件路径

- 评测脚本：`tools/benchmarks/bench_os_ops.py`
- 被评测驱动（本实验）：`tools/benchmarks/bench_os_ops.py` 内 `SimulatedUIDriver`
- 任务定义：同文件 `_task_calc_click` / `_task_notepad_type` / `_task_window_manage`
- 真实命令面对照报告：`docs/experiments/os/os操作评测-live-20260826.md`

## 6. 执行命令（可复现）

```powershell
& ".venv\Scripts\python.exe" -X utf8 tools\benchmarks\bench_os_ops.py
```

环境：

| 项 | 值 |
|---|---|
| Python | 3.14.0（`.venv\Scripts\python.exe`） |
| OS | Windows（win32），PowerShell 5.1 |
| git HEAD（开跑时） | `d936d1a91743b3518d3a9e3f42e7ca7bd2ee4bf8` |
| git HEAD（成稿时，他区域并行提交推进） | `c685b84701f240b014587b41ba533466a30cbd6c` |
| 本区域改动 | `inkling/cli/src/lib.rs`、`inkling/cli/src/main.rs`、`tools/benchmarks/bench_os_ops.py`（仅 live 驱动与 CLI 接线；simulated 路径与任务定义**零改动**） |

## 7. 失败明细与分类

本次无失败项（3/3 PASS）。

需要如实标注的**范围限制**（非本次失败，但影响该结果的解释力）：

| 事项 | 分类 | 说明 |
|---|---|---|
| simulated 断言用的元素模型（`label=digit-7`、`display.value`、`edit.value`、`window.minimized`）在真实命令面并不存在 | 任务集缺陷（口径与真实执行体不同构） | 真实 `ui_tree_query` 只回传 HWND 层级（handle/title/class/visible），无控件矩形、无跨进程控件文本、无 minimized 字段；故 simulated 100% 不能外推为真实能力，详见 live 报告根因分析 |
| 离线冒烟不阻塞门禁（`--live` 未指定时退出码恒 0） | 机制取向（设计如此） | 门禁只用它证明「框架可跑」；真实达标率必须 `--live` 判定 |

## 8. 复现步骤

1. 仓库根执行第 6 节命令（无需真实桌面、无需网络、无需模型）。
2. 期望输出：3 行 `[PASS]`，`通过 3/3（100.0%）`，末行「离线冒烟结论：框架与任务口径可用」，退出码 0。
3. 如需真实桌面复核：见 live 报告第 6 节命令（需先构建 `inkling-headless`）。
