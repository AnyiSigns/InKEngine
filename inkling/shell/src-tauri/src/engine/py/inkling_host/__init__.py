"""InKling 宿主接线包：装配配方数据映射 + Host 五件套 + 图配方 + MCP 挂载服务。

本包是设计文档第二节设计公理中的「通用 Python 接线件」：只负责把
``seed_data/`` JSON 与引擎机制装配起来，不含任何产品内容（产品
内容 = seed_data 数据 + exec/frontend 机制件）。引擎不可改，本包
只消费引擎公开契约。
"""
from .host import InKlingHost, boot_inkling
from .mcp_service import McpMountService
from .recipe_loader import build_recipe, load_seed_data

__all__ = [
    "InKlingHost",
    "McpMountService",
    "boot_inkling",
    "build_recipe",
    "load_seed_data",
]
