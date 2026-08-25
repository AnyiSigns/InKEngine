"""live 报告生成（JSON + MD + 覆盖矩阵 + 费用审计）。

测试说明文档第七节：每用例通过/失败/跳过 + 耗时 + token 估算；失败四分类
（机制缺陷/模型行为/环境/测试设计错误）；覆盖矩阵（coverage.md
59 模块逐项打勾）；费用审计（总调用/轮数/token 估算）；门禁 ①-⑤
逐项核对输出。
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path

from tests.live.coverage_map import MODULE_FILES

FAMILY_DIR = Path(__file__).parent
REPORT_DIR = FAMILY_DIR / "report"

# 失败四分类
CAT_MECHANISM = "mechanism"  # 机制缺陷（经确定性复现归类）
CAT_MODEL = "model"  # 模型行为/输出漂移
CAT_ENVIRONMENT = "environment"  # 网络/端点/环境不可用
CAT_TEST = "test"  # 测试设计错误


def classify_failure(exc: BaseException) -> str:
    """失败分类启发式（报告提示口径；确定性复现归类为机制缺陷的权威路径）。

    分类优先序：本地端点相关（fault server/MCP 本地服务）失败属环境或
    测试设计；LLM 层异常属模型/环境；引擎机制异常属机制；其余（断言等）
    默认测试设计错误——用例可经 ``live_report.mark(nodeid, cat)`` 覆盖。
    """
    from ink_engine.core.exceptions import EngineError
    from ink_engine.core.llm.errors import LLMError

    name = exc.__class__.__name__
    if isinstance(exc, LLMError):
        return CAT_MODEL
    if isinstance(exc, EngineError):
        return CAT_MECHANISM
    if isinstance(exc, (ConnectionError, TimeoutError, OSError)):
        return CAT_ENVIRONMENT
    if name in ("AssertionError", "TypeError", "KeyError", "ValueError", "AttributeError"):
        return CAT_TEST
    return CAT_ENVIRONMENT


def estimate_tokens(text: str) -> int:
    """token 估算（熔断记账口径，保守偏高）：ASCII ≈ 4 字符/词元，
    非 ASCII ≈ 1 字符/词元；零文本返回 0。"""
    ascii_chars = sum(1 for ch in text if ord(ch) < 128)
    non_ascii = len(text) - ascii_chars
    return max(0, ascii_chars // 4) + non_ascii


@dataclass
class TestEntry:
    nodeid: str
    status: str  # passed/failed/skipped
    duration: float = 0.0
    category: str | None = None  # 失败分类（failed 时）
    llm_rounds: int = 0
    tokens_estimate: int = 0
    is_real: bool = False
    family: str = ""

    def to_dict(self) -> dict:
        return {
            "nodeid": self.nodeid,
            "family": self.family,
            "status": self.status,
            "duration": round(self.duration, 3),
            "category": self.category,
            "llm_rounds": self.llm_rounds,
            "tokens_estimate": self.tokens_estimate,
            "is_real": self.is_real,
        }


def _family_of(nodeid: str) -> str:
    for part in nodeid.split("/"):
        if part.startswith("test_") and part.endswith(".py"):
            return part[5 : part.index("_", 5)] if "_" in part[5:] else part[5:7]
    return ""


@dataclass
class LiveReport:
    """会话级报告收集器（conftest 钩子写入，sessionfinish 落盘）。"""

    started_at: float = field(default_factory=time.time)
    entries: dict[str, TestEntry] = field(default_factory=dict)
    llm_total_rounds: int = 0
    token_estimate_total: int = 0
    fuse_max_rounds: int = 120
    fuse_max_tokens: int = 600_000
    fuse_exhausted: bool = False
    probe_ok: bool | None = None
    probe_error: str | None = None

    def record(self, entry: TestEntry) -> None:
        self.entries[entry.nodeid] = entry

    def mark(self, nodeid: str, category: str) -> None:
        if nodeid in self.entries:
            self.entries[nodeid].category = category

    def charge(self, rounds: int, tokens: int) -> None:
        self.llm_total_rounds += rounds
        self.token_estimate_total += tokens

    # ------------------------------------------------------------------
    # 门禁核对
    # ------------------------------------------------------------------
    def gates(self) -> dict:
        passed = [e for e in self.entries.values() if e.status == "passed"]
        failed = [e for e in self.entries.values() if e.status == "failed"]
        skipped = [e for e in self.entries.values() if e.status == "skipped"]
        passed_files = {Path(e.nodeid.split("::")[0]).name for e in passed}
        # ① 覆盖矩阵「未覆盖」= 0（孤儿模块 = 失败）
        uncovered = [
            module
            for module, files in MODULE_FILES.items()
            if not (set(files) & passed_files)
        ]
        # ② 每机制族 ≥1 条真实 LLM 驱动用例
        families = sorted({e.family for e in self.entries.values()})
        real_per_family = {
            f: any(e.is_real and e.status == "passed" for e in self.entries.values() if e.family == f)
            for f in families
        }
        # ③④ 叠加/对抗族门禁（test_21/test_22 全绿 + 探针由用例自身断言）
        overlay_ok = all(
            e.status == "passed" for e in self.entries.values() if e.family == "21"
        )
        adversarial_ok = all(
            e.status == "passed" for e in self.entries.values() if e.family == "22"
        )
        # ⑤ 「机制缺陷」类失败 = 0
        mechanism_failures = [e for e in failed if e.category == CAT_MECHANISM]
        return {
            "g1_no_orphan_modules": len(uncovered) == 0,
            "g1_uncovered": uncovered,
            "g2_real_per_family": real_per_family,
            "g3_overlay_all_green": overlay_ok,
            "g4_adversarial_all_green": adversarial_ok,
            "g5_no_mechanism_failures": len(mechanism_failures) == 0,
            "g5_mechanism_failures": [e.nodeid for e in mechanism_failures],
            "summary": {
                "total": len(self.entries),
                "passed": len(passed),
                "failed": len(failed),
                "skipped": len(skipped),
            },
        }

    # ------------------------------------------------------------------
    # 输出
    # ------------------------------------------------------------------
    def to_dict(self) -> dict:
        return {
            "started_at": self.started_at,
            "fuse": {
                "max_rounds": self.fuse_max_rounds,
                "max_tokens": self.fuse_max_tokens,
                "exhausted": self.fuse_exhausted,
                "llm_total_rounds": self.llm_total_rounds,
                "token_estimate_total": self.token_estimate_total,
            },
            "probe": {"ok": self.probe_ok, "error": self.probe_error},
            "entries": [e.to_dict() for e in self.entries.values()],
            "gates": self.gates(),
        }

    def write(self, out_dir: Path = REPORT_DIR) -> tuple[Path, Path]:
        out_dir.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        json_path = out_dir / f"live-report-{stamp}.json"
        md_path = out_dir / f"live-report-{stamp}.md"
        json_path.write_text(
            json.dumps(self.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8"
        )
        md_path.write_text(self._markdown(), encoding="utf-8")
        (out_dir / "latest.json").write_text(
            json.dumps(self.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8"
        )
        (out_dir / "latest.md").write_text(self._markdown(), encoding="utf-8")
        return json_path, md_path

    def _markdown(self) -> str:
        gates = self.gates()
        lines: list[str] = [
            "# live 测试报告",
            "",
            f"- 生成时间：{time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(self.started_at))}",
            f"- 结果：{gates['summary']['passed']} 通过 / "
            f"{gates['summary']['failed']} 失败 / {gates['summary']['skipped']} 跳过"
            f"（共 {gates['summary']['total']}）",
            f"- 连通性探测：{'OK' if self.probe_ok else '失败'}"
            + (f"（{self.probe_error}）" if self.probe_error else ""),
            "",
            "## 费用审计",
            "",
            f"- 真实调用轮数：{self.llm_total_rounds}（熔断上限 {self.fuse_max_rounds}）",
            f"- token 估算：{self.token_estimate_total}（熔断上限 {self.fuse_max_tokens}）",
            f"- 熔断触发：{'是（剩余真实族已停）' if self.fuse_exhausted else '否'}",
            "",
            "## 门禁核对",
            "",
            f"- ① 覆盖矩阵「未覆盖」= 0：{'✅' if gates['g1_no_orphan_modules'] else '❌ 孤儿模块: ' + ', '.join(gates['g1_uncovered'])}",
            "- ② 每机制族 ≥1 条真实 LLM 驱动用例："
            + "、".join(
                f"族 {f}{'✅' if ok else '❌'}" for f, ok in sorted(gates["g2_real_per_family"].items())
            ),
            f"- ③ 叠加族（21）全绿：{'✅' if gates['g3_overlay_all_green'] else '❌'}",
            f"- ④ 对抗族（22）全绿：{'✅' if gates['g4_adversarial_all_green'] else '❌'}",
            f"- ⑤ 「机制缺陷」类失败 = 0：{'✅' if gates['g5_no_mechanism_failures'] else '❌ ' + ', '.join(gates['g5_mechanism_failures'])}",
            "",
            "## 失败明细",
            "",
        ]
        failed = [e for e in self.entries.values() if e.status == "failed"]
        if not failed:
            lines.append("_（无失败）_")
        for e in failed:
            lines.append(f"- `{e.nodeid}`：{e.category or '未分类'}（{e.duration:.1f}s）")
        lines += [
            "",
            "## 用例清单",
            "",
            "| 用例 | 状态 | 分类 | 轮数 | token 估算 | 真实 | 耗时(s) |",
            "|---|---|---|---|---|---|---|",
        ]
        for nodeid in sorted(self.entries):
            e = self.entries[nodeid]
            lines.append(
                f"| `{e.nodeid.split('::')[-1]}` | {e.status} | {e.category or '-'} "
                f"| {e.llm_rounds} | {e.tokens_estimate} | {'是' if e.is_real else '-'} | {e.duration:.1f} |"
            )
        lines.append("")
        return "\n".join(lines)


__all__ = [
    "CAT_ENVIRONMENT",
    "CAT_MECHANISM",
    "CAT_MODEL",
    "CAT_TEST",
    "LiveReport",
    "TestEntry",
    "classify_failure",
    "estimate_tokens",
]
