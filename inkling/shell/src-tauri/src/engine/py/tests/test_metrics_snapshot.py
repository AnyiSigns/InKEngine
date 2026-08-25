"""metrics.snapshot op verification (shell-side embedded bridge aggregation).

Feeds constructed metrics and asserts aggregated fields (hit rate / usage /
avg_cost / occupancy threshold). Loads bridge.py directly and awaits the async
op. No pytest dependency: run with `py test_metrics_snapshot.py`; also pytest
compatible (functions named test_*).
"""

import asyncio
import importlib.util
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
_BRIDGE_PATH = os.path.join(_HERE, "..", "bridge.py")


def _load_bridge():
    spec = importlib.util.spec_from_file_location("bridge_under_test", _BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _call(args):
    bridge = _load_bridge()
    return asyncio.run(bridge._metrics_snapshot(args))


def test_hit_rate_and_token_totals():
    args = {
        "turn_metrics": {
            "turns": 10,
            "failures": 2,
            "llm_calls_by_tier": {"main": 7, "router": 3},
        },
        "llm_usage": [
            {"prompt_tokens": 100, "completion_tokens": 50},
            {"prompt_tokens": 200, "completion_tokens": 80},
        ],
        "cache_stats": {
            "cache_hits": 8,
            "cache_misses": 2,
            "cache_invalidations": 1,
            "cache_replacements": 0,
        },
        "cache_entries": 42,
        "edges": [{"avg_cost": 0.2}, {"avg_cost": 0.4}, {"avg_cost": 0.6}],
    }
    out = _call(args)
    assert out["ok"] is True
    assert out["cache"]["hits"] == 8
    assert out["cache"]["misses"] == 2
    assert abs(out["cache"]["hit_rate"] - 0.8) < 1e-9
    assert out["cache"]["invalidations"] == 1
    assert out["llm"]["prompt_tokens_total"] == 300
    assert out["llm"]["completion_tokens_total"] == 130
    assert out["llm"]["tokens_total"] == 430
    assert out["llm"]["last_prompt_tokens"] == 200
    assert out["llm"]["last_completion_tokens"] == 80
    assert out["llm"]["calls_total"] == 10
    assert out["edges"]["count"] == 3
    assert abs(out["edges"]["avg_cost_mean"] - 0.4) < 1e-9
    assert out["edges"]["avg_cost_min"] == 0.2
    assert out["edges"]["avg_cost_max"] == 0.6
    assert out["cache_entries"] == 42


def test_occupancy_over_threshold_flag():
    out = _call({"occupancy": {"current": 85, "limit": 100}})
    assert out["occupancy"]["over_threshold"] is True
    out = _call({"occupancy": {"current": 70, "limit": 100}})
    assert out["occupancy"]["over_threshold"] is False
    out = _call({"occupancy": {"current": 5, "limit": 0}})
    assert out["occupancy"]["over_threshold"] is False


def test_missing_blocks_default_to_zero():
    out = _call({})
    assert out["cache"]["hit_rate"] == 0.0
    assert out["llm"]["tokens_total"] == 0
    assert out["llm"]["last_prompt_tokens"] is None
    assert out["edges"]["count"] == 0
    assert out["edges"]["avg_cost_mean"] == 0.0
    assert out["cache_entries"] == 0
    assert out["occupancy"] is None


def test_dirty_values_do_not_crash():
    args = {
        "llm_usage": [
            {"prompt_tokens": "oops", "completion_tokens": None},
            "not-a-dict",
        ],
        "cache_stats": {"cache_hits": "x", "cache_misses": 0},
        "edges": [{"avg_cost": "bad"}, {}],
    }
    out = _call(args)
    assert out["llm"]["tokens_total"] == 0
    assert out["cache"]["hit_rate"] == 0.0
    assert out["edges"]["count"] == 2
    assert out["edges"]["avg_cost_mean"] == 0.0


if __name__ == "__main__":
    test_hit_rate_and_token_totals()
    test_occupancy_over_threshold_flag()
    test_missing_blocks_default_to_zero()
    test_dirty_values_do_not_crash()
    print("metrics.snapshot all assertions passed")
