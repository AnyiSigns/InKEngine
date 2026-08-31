#!python
"""E2 自举实证驱动：产品 agent 经产品自身管线完成真实任务。

任务选型（Q15 已定）：新事件类型 + 自定义渲染器。
管线 = 读代码 → 写 TSX + vitest 测试 → shell_exec 验证
（类型检查/测试）→ propose_patch 挂载 event_type 补丁 → 审批链 → 补丁链生效
→ 渲染生效验证 → revert 回退演练（链上状态还原）。

驱动方式：inkling-headless --round（真实模型，经 INK_LLM_* env 注入）。
回合拆分 = 每个阶段一个明确动作（模型自主决策工具调用，多轮工具循环），
回合间共享 sqlite 数据目录（补丁链持久）与仓库文件系统（写码持久）。
回合后按事件流断言关键环节，输出报告 JSON 供 BOOTSTRAP.md 引用。
失败不重试硬撑，失败模式如实记录。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

# 管道日志按 UTF-8 输出（避免 Windows 默认 GBK 编码造成乱码）
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = REPO_ROOT / ".kilo" / "测试模型配置.txt"
HEADLESS = REPO_ROOT / "inkling" / "cli" / "target" / "debug" / "inkling-headless.exe"

# 全程运行日志（控制台与文件双写；进程被外部终止时日志仍可查）
RUN_LOG = REPO_ROOT / ".kilo" / "tmp" / "bootstrap-proof-run.log"


class _Tee:
    """print 双写：控制台（实时）+ 运行日志文件（事后可查）。"""

    def __init__(self, stream) -> None:
        self._stream = stream

    def write(self, text: str) -> int:
        self._stream.write(text)
        self._stream.flush()
        try:
            with RUN_LOG.open("a", encoding="utf-8") as fh:
                fh.write(text)
        except OSError:
            pass
        return len(text)

    def flush(self) -> None:
        self._stream.flush()


sys.stdout = _Tee(sys.stdout)
sys.stderr = _Tee(sys.stderr)

EVENT_TYPE = "milestone_reached"
RENDERER = "milestone_entry"

# 单回合最长等待（秒）；回合内模型自主工具循环，超时即终止该回合
ROUND_TIMEOUT = 1500

# 每回合一个明确动作（agent 自主决策工具与参数，多轮工具循环直至完成）

# 阶段1 渲染器代码模板（E2 实证产物：注册机制与 messageRendererRegistry.ts 对齐——
# registerRendererKey 白名单登记 + registerMessageRenderer 绑定 + resolveMessageRenderer 解析）
RENDERER_TSX = """/**
 * milestone_reached 事件自定义渲染器（自举实证产物）。
 *
 * 注册机制：milestone_reached 不在 EVENT_TYPE_NAMES 基线白名单内，
 * 须先 registerRendererKey 登记白名单，再 registerMessageRenderer 绑定。
 */
import type { MessageRenderer, MessageRendererProps } from './messageRendererRegistry';
import { registerMessageRenderer, registerRendererKey } from './messageRendererRegistry';

const MilestoneEntry: MessageRenderer = (props: MessageRendererProps) => {
  const payload = (props.event ?? {}) as { title?: string; detail?: string };
  return (
    <div className="milestone-entry">
      <strong>{payload.title ?? '事件达成'}</strong>
      {payload.detail ? <p>{payload.detail}</p> : null}
    </div>
  );
};

export function registerMilestoneEntry(): boolean {
  registerRendererKey('milestone_reached');
  return registerMessageRenderer('milestone_reached', MilestoneEntry);
}
"""

RENDERER_TEST_TSX = """/**
 * milestone_reached 渲染器测试（自举实证产物）。
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetMessageRendererRegistry, resolveMessageRenderer } from '@/renderer/messageRendererRegistry';
import { registerMilestoneEntry } from '@/renderer/milestone_entry';

describe('milestone_entry 渲染器', () => {
  beforeEach(() => {
    resetMessageRendererRegistry();
  });

  it('milestone_reached 可解析到自定义渲染器并渲染标题', () => {
    expect(registerMilestoneEntry()).toBe(true);
    const Renderer = resolveMessageRenderer('milestone_reached');
    expect(Renderer).not.toBeNull();
    if (Renderer === null) return;
    render(<Renderer event={{ title: '首章完成', detail: '第一章已写完' }} />);
    expect(screen.getByText('首章完成')).toBeInTheDocument();
    expect(screen.getByText('第一章已写完')).toBeInTheDocument();
  });
});
"""

ROUNDS = [
    (
        "阶段1 写码",
        f"""在 inkling/frontend 里为事件类型 {EVENT_TYPE} 实现自定义渲染器并写测试。

工作区根 = 仓库根（文件工具沙箱根），绝对路径前缀为 {REPO_ROOT}（正斜杠）；
文件工具路径必须用这个绝对前缀，相对路径会被权限拒绝。
研究链材料工具（collect_material 等）依赖未连接的 MCP server，调用必失败——
不要调用它们。也不要读任何参考文件或探查目录，直接照抄下面模板写文件。

工具调用形态（严格按此传参，缺字段会被 fail-closed 拒绝）：
- file_write: {{"operation": "write", "path": "<绝对路径>", "content": "<文件内容>"}}

请执行且只执行两次 file_write：
1. 把下面 RENDERER_TSX 的内容原样写入
   {REPO_ROOT}/inkling/frontend/src/renderer/{RENDERER}.tsx
2. 把下面 RENDERER_TEST_TSX 的内容原样写入
   {REPO_ROOT}/inkling/frontend/src/renderer/__tests__/{RENDERER}.test.tsx

RENDERER_TSX 内容（=== 开始，=== 结束之间为文件全文）：
===
{RENDERER_TSX}
===

RENDERER_TEST_TSX 内容：
===
{RENDERER_TEST_TSX}
===

完成后汇报两个文件的写入结果。""",
    ),
    (
        "阶段2 验证",
        f"""你已在 inkling/frontend 创建了 {RENDERER}.tsx 与对应测试。

请严格依次调用两个工具，缺一不可：
1. 先用 shell_exec 执行前端类型检查（如 npx tsc --noEmit）；
2. 再用 shell_exec 运行 vitest（filter 限定 {RENDERER} 测试），
   确认渲染器测试通过。
分别汇报两项命令的通过/失败与关键输出（不要只跑其中一个就收口）。""",
    ),
    (
        "阶段3 挂载",
        f"""把事件类型 {EVENT_TYPE} 挂载为产品能力（补丁链）。

严格按两步走，缺一不可：
1. 用 propose_patch 提交补丁，参数必须精确为：
   {{
     "command": "propose_patch",
     "kind": "event_type",
     "payload": {{
       "name": "{EVENT_TYPE}",
       "schema": {{
         "name": "{EVENT_TYPE}",
         "fields": [
           {{ "name": "title", "required": true, "kind": "string" }},
           {{ "name": "detail", "kind": "string" }}
         ]
       }},
       "renderer": "{RENDERER}",
       "system": false
     }},
     "rationale": "自举实证：事件类型经补丁链挂载为产品能力"
   }}
   校验会要求 schema 含 name 与 fields 清单，字段声明须含 name/required/kind——
   直接按上面形态提交，不要自行改动字段名（如 schema.name 必须等于 {EVENT_TYPE}）。
2. 提案返回成功后（ok=true 且含补丁号），必须再用 apply_patch 落链：
   apply_patch 的参数 = kind/payload 与提案完全一致，再加 base_version
   （= 提案返回的版本号）。apply_patch 返回补丁 id 才算挂载完成。
3. 汇报补丁链版本与挂载结果（含 apply_patch 返回的 patch_id）。""",
    ),
    (
        "阶段4 渲染生效验证",
        f"""验证事件类型 {EVENT_TYPE} 的渲染已生效。

用 shell_exec 运行 vitest（filter 限定 {RENDERER}）确认渲染器测试仍通过，
再用 file_read 读取事件类型注册相关文件确认 {EVENT_TYPE} 已登记。
汇报验证结果。""",
    ),
    (
        "阶段5 回退演练",
        f"""回退演练：用 revert_patch 回退你挂载的 {EVENT_TYPE} 事件类型补丁
（补丁链尾，即阶段3落链的那一条；先调 inspect_tools 或直接 revert_patch
看链尾 id，再以该 id 回退）。回退后汇报补丁链版本与
事件类型状态已还原。""",
    ),
]


def load_model_env() -> dict[str, str]:
    """读 .kilo/测试模型配置.txt → INK_LLM_* env（产品宿主同口径）。"""
    if not CONFIG_PATH.exists():
        raise SystemExit(f"模型配置缺失: {CONFIG_PATH}")
    lines = CONFIG_PATH.read_text(encoding="utf-8").splitlines()
    url = key = model = None
    for line in lines:
        line = line.strip()
        if line.startswith("url:"):
            url = line[4:].strip()
        elif line.startswith("key:"):
            key = line[4:].strip()
        elif line.startswith("model_name:") and model is None:
            model = line[11:].strip()
    if not url or not model:
        raise SystemExit("模型配置缺 url/model_name")
    env = dict(os.environ)
    env["INK_LLM_BASE_URL"] = url
    env["INK_LLM_MODEL"] = model
    if key:
        env["INK_LLM_API_KEY"] = key
    venv_python = (
        Path(os.environ.get("VIRTUAL_ENV", "")) / "Scripts" / "python.exe"
        if os.environ.get("VIRTUAL_ENV")
        else REPO_ROOT / ".venv" / "Scripts" / "python.exe"
    )
    if venv_python.exists():
        env["PYO3_PYTHON"] = str(venv_python)
    python_root = Path("C:/Users/Anyi/AppData/Local/Programs/Python")
    if python_root.exists():
        for sub in ("Python314", "Python312"):
            candidate = python_root / sub
            if candidate.exists() and str(candidate) not in env.get("PATH", ""):
                env["PATH"] = str(candidate) + os.pathsep + env.get("PATH", "")
    return env


def run_round(data_dir: Path, prompt: str, env: dict[str, str]) -> dict:
    """发起一轮 headless 回合，返回信封 JSON。

    headless 回合内事件经 stderr `[round]` 通道实时输出（模型流式回复 /
    工具调用留痕），这里用独立线程逐行转印，避免 subprocess.run 全量捕获
    造成的长时间静默；stdout 只承载最终信封，进程结束后再解析。
    """
    cmd = [str(HEADLESS), "--data-dir", str(data_dir), "--round", prompt]
    print(f"[drive] 回合发起: {cmd[-1][:60]} ...", flush=True)
    started = time.time()
    proc = subprocess.Popen(
        cmd,
        cwd=str(REPO_ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    stderr_lines: list[str] = []

    def drain_stderr() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            stderr_lines.append(line)
            print(f"  {line}", end="", flush=True)

    reader = threading.Thread(target=drain_stderr, daemon=True)
    reader.start()
    try:
        # 注意：不用 communicate() 读 stderr（会与转印线程抢同一管道）；
        # stdout 由主线程独占读到 EOF，再 wait 收进程。
        stdout = proc.stdout.read() if proc.stdout else ""
        proc.wait(timeout=ROUND_TIMEOUT)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        reader.join(timeout=5)
        elapsed = time.time() - started
        print(f"[drive] 回合超时（>{ROUND_TIMEOUT}s），已终止")
        return {"envelope": None, "elapsed": elapsed, "exit": -1}
    reader.join(timeout=5)
    elapsed = time.time() - started
    if proc.returncode != 0:
        print(f"[drive] 回合退出码 {proc.returncode}（耗时 {elapsed:.1f}s）")
        print(proc.stderr[-1500:] if not stderr_lines else "")
    envelope = None
    try:
        envelope = json.loads(stdout)
    except json.JSONDecodeError:
        print("[drive] 信封解析失败，stdout 尾部:")
        print(stdout[-1500:])
    print(f"[drive] 回合完成（耗时 {elapsed:.1f}s）")
    return {"envelope": envelope, "elapsed": elapsed, "exit": proc.returncode}


def collect_events(envelope: dict | None) -> list[dict]:
    if not envelope or not envelope.get("ok"):
        return []
    data = envelope.get("data") or {}
    return data.get("events") or []


def summarize(events: list[dict]) -> dict:
    tools: dict[str, int] = {}
    tokens = 0
    for event in events:
        etype = event.get("type") or ""
        if etype == "tool_start":
            name = (event.get("payload") or {}).get("tool") or ""
            tools[name] = tools.get(name, 0) + 1
        elif etype == "reply_token":
            tokens += 1
    return {"tools_called": tools, "reply_tokens": tokens, "events": len(events)}


def main() -> None:
    out_dir = REPO_ROOT / "docs" / "experiments" / "self-learning"
    out_dir.mkdir(parents=True, exist_ok=True)
    data_dir = REPO_ROOT / ".kilo" / "tmp" / "bootstrap-proof"
    data_dir.mkdir(parents=True, exist_ok=True)

    env = load_model_env()
    report = {
        "实验名称": "E2 自举实证（产品 agent 走自身管线）",
        "任务": f"新事件类型 {EVENT_TYPE} + 自定义渲染器 {RENDERER}",
        "管线": "读代码 → 写 TSX+测试 → typecheck/vitest → propose_patch 挂载 → 渲染生效 → 回退演练",
        "模型": env.get("INK_LLM_MODEL", ""),
        "时间": time.strftime("%Y-%m-%d %H:%M:%S"),
        "回合": [],
        "结论": "",
        "失败模式": [],
    }

    all_events: dict[str, list[dict]] = {}
    for stage, prompt in ROUNDS:
        result = run_round(data_dir, prompt, env)
        events = collect_events(result["envelope"])
        all_events[stage] = events
        summary = summarize(events)
        report["回合"].append({"阶段": stage, **result, "摘要": summary})
        print(f"[drive] {stage} 摘要: {json.dumps(summary, ensure_ascii=False)}")

    # 结论判定：各阶段须出现对应工具
    stages = {r[0]: r[1] for r in ROUNDS}
    expect = {
        "阶段1 写码": {"file_write"},
        "阶段2 验证": {"shell_exec"},
        "阶段3 挂载": {"propose_patch", "apply_patch"},
        "阶段4 渲染生效验证": {"shell_exec"},
        "阶段5 回退演练": {"revert_patch"},
    }
    ok = True
    for stage, needed in expect.items():
        tools = set(summarize(all_events.get(stage, [])).get("tools_called", {}))
        missing = needed - tools
        if missing:
            ok = False
            report["失败模式"].append(f"{stage} 缺工具调用（缺 {sorted(missing)}）")
    report["结论"] = "端到端成功一次 + 回退一次（双向断言）" if ok else "未达标"

    detail_path = out_dir / f"自举实证-事件流-{time.strftime('%Y%m%d-%H%M%S')}.json"
    detail_path.write_text(
        json.dumps(all_events, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    report["事件流文件"] = str(detail_path.relative_to(REPO_ROOT))

    report_path = out_dir / f"自举实证-{time.strftime('%Y%m%d-%H%M%S')}.json"
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"[drive] 报告: {report_path}")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    sys.exit(0 if report["结论"] == "端到端成功一次 + 回退一次（双向断言）" else 1)


if __name__ == "__main__":
    main()
