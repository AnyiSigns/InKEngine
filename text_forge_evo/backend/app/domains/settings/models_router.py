"""模型双挡配置域：配置存引擎存储 records（key 独立存 secrets.db）。

挡位：main / router（audit 已随引擎合并为双挡）。router 为 null = 回落 main。
引擎存储对全部通道剥离敏感键（api_key 落库即置空），故 api_key 单独存
secrets.db（集外），读取时合并。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from ink_engine.core.llm import LLMError, Message, create_llm
from pydantic import BaseModel

from ... import secrets as secrets_store
from ...engine import get_storage

router = APIRouter(prefix="/settings/models", tags=["models"])

MODELS_COLLECTION = "settings"
MODELS_KEY = "models"

TIERS = ("main", "router")
TIER_LABELS = {
    "main": "主模型（域专才/生成/模拟）",
    "router": "制片人决策（留空回落 main）",
}

DEFAULT_TIER: dict[str, Any] = {
    "adapter": "openai_compat",
    "base_url": "",
    "model_id": "",
    "api_key": "",
    "temperature": 0.7,
    "max_tokens": None,
    "request_timeout": 120,
}


async def _read_models() -> dict[str, Any]:
    storage = get_storage()
    record = await storage.get_record(MODELS_COLLECTION, MODELS_KEY)
    if record is None:
        models: dict[str, Any] = {
            "main": dict(DEFAULT_TIER),
            "router": None,
        }
    else:
        models = dict(record)
        for tier in TIERS:
            models.setdefault(tier, dict(DEFAULT_TIER) if tier == "main" else None)
    # 挡位裁剪迁移：剥离契约外遗留键（如旧三挡的 audit），并清理
    # secrets.db 的孤儿密钥行——不返回契约外配置，不留无人引用的凭据
    legacy = [key for key in models if key not in TIERS]
    if legacy:
        for key in legacy:
            await secrets_store.delete_api_key(key)
            del models[key]
        await storage.put_record(MODELS_COLLECTION, MODELS_KEY, models)
    for tier in TIERS:
        cfg = models.get(tier)
        if cfg:
            cfg["api_key"] = await secrets_store.get_api_key(tier)
    return models


async def _write_models(models: dict[str, Any]) -> None:
    storage = get_storage()
    record_models: dict[str, Any] = {}
    for tier in TIERS:
        cfg = models.get(tier)
        if not cfg:
            record_models[tier] = None
            continue
        tier_key = str(cfg.get("api_key") or "")
        await secrets_store.set_api_key(tier, tier_key)
        safe_cfg = dict(cfg)
        safe_cfg["api_key"] = ""
        record_models[tier] = safe_cfg
    await storage.put_record(MODELS_COLLECTION, MODELS_KEY, record_models)


def _resolve_config(models: dict[str, Any], tier: str) -> dict[str, Any]:
    """挡位配置解析：router 为 None 时回落 main。"""
    if tier not in TIERS:
        raise HTTPException(status_code=400, detail=f"未知挡位: {tier}")
    cfg = models.get(tier) or models.get("main")
    if not cfg or not cfg.get("model_id") or not cfg.get("base_url"):
        raise HTTPException(
            status_code=400,
            detail=f"挡位「{tier}」未配置完整（base_url/model_id 必填）",
        )
    return dict(cfg)


@router.get("")
async def get_models():
    return await _read_models()


class ModelsRequest(BaseModel):
    models: dict[str, Any]


@router.put("")
async def put_models(req: ModelsRequest):
    for tier in req.models:
        if tier not in TIERS:
            raise HTTPException(status_code=400, detail=f"未知挡位: {tier}")
    await _write_models(req.models)
    return {"ok": True, "models": await _read_models()}


class TestRequest(BaseModel):
    tier: str = "main"


@router.post("/test")
async def test_connection(req: TestRequest):
    """最小请求验证端点可达（网络/鉴权/模型名/超时分类报错）。"""
    models = await _read_models()
    cfg = _resolve_config(models, req.tier)
    try:
        llm = create_llm(cfg)
        result = await llm.ainvoke(
            [Message(role="user", content="连通性测试：请回复 OK")],
            params=None,
        )
        reply = (result.content or "").strip()
        return {"ok": True, "tier": req.tier, "reply": reply[:80]}
    except LLMError as exc:
        return {"ok": False, "tier": req.tier, "error": str(exc)}
    except BaseException as exc:
        return {"ok": False, "tier": req.tier, "error": f"测试失败: {type(exc).__name__}"}
