"""Forge shell CLI 单测：参数解析 + 本地自起单回合端到端。

覆盖：parse_args 路由（web/chat/round/help/version）、本地自起
单回合（假模型注入 → 终端输出渲染断言）、空消息拒绝。
"""
from __future__ import annotations

from app import boot, cli
from tests.test_round import FakeLLM


def test_parse_args_routing() -> None:
    assert cli.parse_args([]).kind == "web"
    assert cli.parse_args(["chat"]).kind == "chat"
    assert cli.parse_args(["-h"]).kind == "help"
    assert cli.parse_args(["-v"]).kind == "version"
    round_action = cli.parse_args(["你好啊"])
    assert round_action.kind == "round"
    assert round_action.text == "你好啊"
    multi = cli.parse_args(["看", "看", "工具"])
    assert multi.kind == "round"
    assert multi.text == "看 看 工具"


async def test_run_cli_round_local_roundtrip(monkeypatch, capsys) -> None:
    # 本地自起：装配 + 假模型回合 → 终端输出完整回复
    from app.boot import ForgeApp

    async def _fake_resolve(_self):
        return FakeLLM()

    monkeypatch.setattr(ForgeApp, "resolve_llm", _fake_resolve)
    code = await cli.run_cli_round("介绍一下你自己")
    out = capsys.readouterr().out
    assert code == 0
    assert "Forge: 我是 Forge，这是观察后的回复。" in out
    assert "[工具] inspect_graph 调用中" in out
    # 回合后释放锁（close_app 幂等，conftest 后置再关一次无副作用）
    assert boot._app is None


async def test_run_cli_round_empty_rejected(capsys) -> None:
    code = await cli.run_cli_round("   ")
    out = capsys.readouterr().out
    assert code == 2
    assert "消息不能为空" in out
