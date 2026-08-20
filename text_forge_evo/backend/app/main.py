"""Forge 后端：FastAPI 装配 + 引擎接线 + 静态托管（单端口）。

`uv run forge` 即本模块入口：启动 uvicorn，lifespan 内完成开局装配
（进程锁 + 存储 + 种子 + harness + 元工具 + LLM 挡位 + Engine），
前端产物经 StaticFiles 单端口托管。
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import boot, config
from .domains.agent.router import router as agent_router
from .domains.files.router import router as files_router
from .domains.mcp.router import router as mcp_router
from .domains.self.router import router as self_router
from .domains.settings.models_router import router as models_router
from .domains.settings.router import router as settings_router
from .engine import close_engine

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
)
logger = logging.getLogger(__name__)

FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"


@asynccontextmanager
async def lifespan(_application: FastAPI):
    config.ensure_home()
    await boot.init_app()
    logger.info("Forge 已启动（集目录: %s）", config.SET_DIR)
    yield
    await close_engine()
    logger.info("Forge 已关闭")


app = FastAPI(title="Forge", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5174",
        "http://127.0.0.1:5174",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(agent_router, prefix="/api")
app.include_router(self_router, prefix="/api")
app.include_router(files_router, prefix="/api")
app.include_router(mcp_router, prefix="/api")
app.include_router(settings_router, prefix="/api")
app.include_router(models_router, prefix="/api")


@app.get("/api/health")
def health():
    return {"status": "ok"}


if FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="static")


def main() -> None:
    """`uv run forge` 入口：单端口启动（集目录随 TEXTFORGE_HOME 迁移）。"""
    uvicorn.run(
        "app.main:app", host="127.0.0.1", port=config.WEB_PORT, log_level="info"
    )


if __name__ == "__main__":
    main()
