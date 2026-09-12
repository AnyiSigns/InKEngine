"""适配层 Serialization：jsonl 审计落账（跨脚本复用的唯一审计原语）。

原 graph_lab agent_demo / agent_demo2 两份逐字节相同的 log_jsonl；checkpoint 封装
两处内容字段不同（v1 无 contract 表、v2 带 arm 重建），不合并，保留在 demo 本地。
"""

from __future__ import annotations

import json


class Serialization:
    @staticmethod
    def log_jsonl(path, obj):
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(obj, ensure_ascii=False) + "\n")
