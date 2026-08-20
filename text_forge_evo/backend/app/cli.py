"""Forge shell（CLI，机制层后门）：一行命令 = 一个回合。

入口形态（`uv run forge` 之后由 scripts 路由）：
- `forge`（无参）→ 启动 Web 壳（对话面板，与历史行为一致）；
- `forge "消息"` → 单回合：本地自起引擎实例（持锁）执行并终端输出；
  已有实例在跑（锁被占）→ 附加模式：经 HTTP 复用运行中实例的回合
  通道（浏览器与 CLI 同时在线），失败则提示；
- `forge chat` → 交互式终端对话（Ctrl+C / /quit 退出）；
- `forge -h/--help`、`forge -v/--version`。

两级后门语义：UI 层（Cmd+K，界面正常时永在）+ 进程层（shell，
界面白屏/布局损坏/无头设备/自动化脚本时兜底——「界面被 AI 改坏了」
时终端一条命令即可对话/回退）。
"""

from __future__ import annotations

import asyncio
import json
import sys
import uuid
from typing import Any

import httpx

from . import boot, config
from .terminal import TerminalTransport, render_frame

# 附加模式目标端口（与 Web 壳共用 config 单一来源）
WEB_PORT = config.WEB_PORT

VERSION = "0.1.0"


class CliAction:
    """CLI 动作解析结果（纯数据；测试直接构造断言）。"""

    def __init__(self, kind: str, text: str = "") -> None:
        self.kind = kind  # web / round / chat / help / version
        self.text = text


def parse_args(args: list[str]) -> CliAction:
    """argv 解析（无参 = 启动 Web；首参为命令字或消息本身）。"""
    if not args:
        return CliAction("web")
    first = args[0]
    if first in ("-h", "--help"):
        return CliAction("help")
    if first in ("-v", "--version"):
        return CliAction("version")
    if first == "chat":
        return CliAction("chat")
    return CliAction("round", " ".join(args).strip())


async def _port_alive() -> bool:
    """探测 Web 壳端口是否真实有实例在监听（锁失败后的二次确认）。"""
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.get(f"http://127.0.0.1:{WEB_PORT}/api/health")
            return resp.status_code == 200
    except httpx.HTTPError:
        return False


async def _run_local_round(app: boot.ForgeApp, text: str) -> int:
    """在已装配实例上执行本地回合（单回合与交互终端共用）。

    装配与锁由调用方持有（单回合 = run_cli_round；交互终端 = chat_loop
    会话全程持锁），本函数只负责回合执行与终端输出。
    """
    llm = await app.resolve_llm()
    if llm is None:
        print("模型未配置，请先运行 forge（Web 壳）完成模型设置")
        return 1
    await app.rebuild_engine(llm)
    if app.engine is None:
        print("引擎未装配，请稍后重试")
        return 1
    thread_id = uuid.uuid4().hex
    round_id = uuid.uuid4().hex
    transport = TerminalTransport()
    await app.engine.ainvoke(
        {"input": text, "thread_id": thread_id},
        thread_id=thread_id,
        round_id=round_id,
        transports=[transport],
    )
    return 0


async def run_cli_round(text: str) -> int:
    """执行一个回合：本地自起装配（持锁）；已有实例则附加对话。"""
    if not text.strip():
        print("消息不能为空（用法：forge \"消息\" 或 forge chat）")
        return 2
    try:
        await boot.init_app()
    except RuntimeError:
        if await _port_alive():
            # 另一实例持锁（Web 壳或另一 CLI）：附加模式复用其回合通道
            return await _attach_round(text)
        print("检测到锁文件但实例未在监听（可能残留），请先停止其它 Forge 进程再试")
        return 1
    app = boot.get_app()
    try:
        return await _run_local_round(app, text)
    finally:
        await boot.close_app()


async def _attach_round(text: str) -> int:
    """附加模式：经 HTTP 把回合交给运行中的实例（SSE 流 → 终端渲染）。"""
    url = f"http://127.0.0.1:{WEB_PORT}/api/chat"
    print("检测到运行中的 Forge 实例，附加对话（浏览器与终端同时在线）")
    thinking: list[str] = []
    reply: list[str] = []
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=5.0)) as client, client.stream(
            "POST", url, json={"message": text}
        ) as resp:
            if resp.status_code != 200:
                body = (await resp.aread()).decode("utf-8", "replace")
                print(f"附加失败（{resp.status_code}）：{body[:200]}")
                return 1
            async for line in resp.aiter_lines():
                if not line.startswith("data: "):
                    continue
                try:
                    frame: dict[str, Any] = json.loads(line[6:])
                except ValueError:
                    continue
                render_frame(frame, print, thinking, reply)
        return 0
    except httpx.HTTPError as exc:
        print(f"附加对话失败（实例不可达）：{exc}")
        print("提示：本地模式须独占实例，可先停止运行中的 forge 再试")
        return 1


async def chat_loop() -> int:
    """交互式终端对话（每行一个回合；Ctrl+C / /quit 退出）。"""
    print(f"Forge shell {VERSION} · 输入消息开始回合（/quit 退出，Ctrl+C 中断）")
    # 首次装配：校验实例可用性与模型配置（避免逐条提示）
    try:
        await boot.init_app()
    except RuntimeError:
        if not await _port_alive():
            print("检测到锁文件但实例未在监听（可能残留），请先停止其它 Forge 进程再试")
            return 1
        print("检测到运行中的 Forge 实例，附加对话模式（每回合经 HTTP 转发）")
        while True:
            try:
                text = await asyncio.to_thread(input, "forge> ")
            except (EOFError, KeyboardInterrupt):
                break
            if not text.strip():
                continue
            if text.strip() in ("/quit", "/exit"):
                break
            await _attach_round(text.strip())
        return 0
    # 本地模式：会话全程持锁（回合间不释放，防并发实例抢占静默转附加）
    app = boot.get_app()
    try:
        while True:
            try:
                text = await asyncio.to_thread(input, "forge> ")
            except (EOFError, KeyboardInterrupt):
                break
            if not text.strip():
                continue
            if text.strip() in ("/quit", "/exit"):
                break
            await _run_local_round(app, text.strip())
        return 0
    finally:
        await boot.close_app()


def main() -> None:
    """`uv run forge` 入口：按参数路由（无参 = 启动 Web 壳）。"""
    action = parse_args(sys.argv[1:])
    if action.kind == "help":
        print(
            "Forge shell 用法：\n"
            "  forge              启动 Web 壳（对话面板）\n"
            '  forge "消息"       一行命令 = 一个回合（本地自起/附加实例）\n'
            "  forge chat         交互式终端对话\n"
            "  forge -v           版本号"
        )
        return
    if action.kind == "version":
        print(f"Forge {VERSION}")
        return
    if action.kind == "web":
        from .main import main as web_main

        web_main()
        return
    if action.kind == "chat":
        sys.exit(asyncio.run(chat_loop()))
    sys.exit(asyncio.run(run_cli_round(action.text)))


if __name__ == "__main__":
    main()
