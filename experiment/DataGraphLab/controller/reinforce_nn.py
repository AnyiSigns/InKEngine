# -*- coding: utf-8 -*-
"""REINFORCE 批量策略梯度数学件（G2.3 对照臂的梯度侧，numpy-only）。

与 `train_nn.py` 的 BC 链严格同构：前向仍是 factorized bilinear pointer，逐候选
打分、掩码挡 padding；只有「对 logits 的余量」不同——BC 用 `p−y`，这里用策略梯度
的 `∇logit`。REINFORCE 目标是最大化 `A·log p(a) + β_ent·H(p)`（A = 终局 reward −
滑动均值 baseline，H = 候选集内 Shannon 熵），故

    L = (1/B) Σ_b [ −A_b·log p_{b,a_b} + β·Σ_i p_{b,i}·log p_{b,i} ]   （有效位）

对 logits 求导（softmax 链式，Σp=1、Σp·log p=−H）：

    g_{b,i} = (1/B)·[ A_b·p_{b,i} − A_b·1{i=a_b} + β·p_{b,i}·(log p_{b,i}+H_b) ]

`g` 进入与 BC 完全相同的回传（dws/dh/dz/…），因此两臂的架构与数值路径可逐行对照。
不使用 learned value head、不加权重衰减、不接进度头——A.2 钉死的 REINFORCE 规格
（baseline=滑动均值、β_ent=0.01、lr=1e-3、batch=512）在此只落梯度侧，采样与预算
编排在 TS（`eval/reinforce.ts`）。
"""

import numpy as np

from train_nn import PARAM_SHAPES, _as64, params_from_json, softmax_masked

BETA_ENT = 0.01  # 熵正则权重（A.2 钉死）；防策略过早坍缩到贪心


def policy_forward_rows(params, o, a, mask):
    """obs/动作特征/掩码 → 候选集内概率 [B,M]（逐行口径，供梯度与校验共用）。"""
    wo, bo, wa, ba, ws = (_as64(params[k]) for k in ("wo", "bo", "wa", "ba", "ws"))
    o2 = _as64(o)
    o2 = o2[None] if o2.ndim == 1 else o2
    a2 = _as64(a)
    a2 = a2[None] if a2.ndim == 2 else a2
    mk = np.asarray(mask, dtype=bool)
    mk = mk[None] if mk.ndim == 1 else mk
    h = np.tanh(o2 @ wo.T + bo)
    z = np.tanh(a2.reshape(-1, wa.shape[1]) @ wa.T + ba).reshape(o2.shape[0], a2.shape[1], -1)
    return softmax_masked((z * h[:, None, :]) @ ws, mk)


def policy_logp_entropy(params, o, a, mask, action_idx):
    """前向 + 逐行所选动作对数似然与熵（诊断与校验复用）；零概率位按 0 处理不产 NaN。"""
    p = _as64(policy_forward_rows(params, o, a, mask))
    safe = np.where(p > 0, p, 1.0)
    logp = np.where(p > 0, np.log(safe), 0.0)
    idx = np.atleast_1d(_as64(action_idx).astype(int))
    picked = logp[np.arange(p.shape[0]), idx]
    entropy = -np.sum(np.where(p > 0, p * logp, 0.0), axis=-1)
    return picked, entropy


def _logit_margin(probs, mask, action_idx, advantage, beta_ent):
    """策略梯度余量 g（∇L/∇logit，batch 均值）：BC 的 (p−y) 在此被策略梯度式替换。"""
    p = _as64(probs)
    mk = np.asarray(mask, dtype=bool)
    mk = mk[None] if mk.ndim == 1 else mk
    adv = np.atleast_1d(_as64(advantage))
    idx = np.atleast_1d(_as64(action_idx).astype(int))
    b = p.shape[0]
    safe = np.where(p > 0, p, 1.0)
    logp = np.where(p > 0, np.log(safe), 0.0)
    ent = -np.sum(np.where(p > 0, p * logp, 0.0), axis=-1)            # [B]
    g = adv[:, None] * p + beta_ent * p * (logp + ent[:, None])
    g[np.arange(b), idx] -= adv
    return (g / float(b)) * mk


def backward_reinforce(params, o, a, mask, action_idx, advantage, beta_ent=BETA_ENT):
    """整批策略梯度（batch 单步）：余量换 g，回传链与 `train_nn.backward` 逐行同构。

    无进度头、无权重衰减——REINFORCE 规格不使用 value head（A.2）；梯度只来自所选
    动作的对数似然与候选集熵。返回值键与 BC 反向一致（wp/bp 置零占位，保持形状契约）。
    """
    o_arr, a_arr = _as64(o), _as64(a)
    o2 = o_arr[None] if o_arr.ndim == 1 else o_arr
    a2 = a_arr[None] if a_arr.ndim == 2 else a_arr
    mk = np.asarray(mask, dtype=bool)
    mk = mk[None] if mk.ndim == 1 else mk
    wo, bo, wa, ba, ws = (_as64(params[k]) for k in ("wo", "bo", "wa", "ba", "ws"))
    h = np.tanh(o2 @ wo.T + bo)
    zpre = a2.reshape(-1, wa.shape[1]) @ wa.T + ba
    z = np.tanh(zpre.reshape(o2.shape[0], a2.shape[1], -1))
    p = softmax_masked((z * h[:, None, :]) @ ws, mk)
    g = _logit_margin(p, mk, action_idx, advantage, beta_ent)

    dws = np.einsum("bm,bmh,bh->h", g, z, h)
    dh = np.einsum("bm,bmh,h->bh", g, z, ws)
    dh_pre = dh * (1.0 - h ** 2)
    dz = g[:, :, None] * (ws * h)[:, None, :]
    dz_pre = dz * (1.0 - z ** 2)
    return {
        "wo": dh_pre.T @ o2,
        "bo": dh_pre.sum(axis=0),
        "wa": dz_pre.reshape(-1, z.shape[-1]).T @ a2.reshape(-1, a2.shape[-1]),
        "ba": dz_pre.sum(axis=(0, 1)),
        "ws": dws,
        "wp": np.zeros_like(_as64(params["wp"])),
        "bp": np.zeros_like(_as64(params["bp"])),
    }


def reinforce_loss(params, o, a, mask, action_idx, advantage, beta_ent=BETA_ENT):
    """标量目标（数值梯度校验的参考）：batch 均值的 −A·logp + β·Σp·logp。"""
    p = _as64(policy_forward_rows(params, o, a, mask))
    safe = np.where(p > 0, p, 1.0)
    logp = np.where(p > 0, np.log(safe), 0.0)
    idx = np.atleast_1d(_as64(action_idx).astype(int))
    b = p.shape[0]
    ent_term = np.sum(np.where(p > 0, p * logp, 0.0), axis=-1)
    picked = logp[np.arange(b), idx]
    return float(np.mean(-_as64(advantage) * picked + beta_ent * ent_term))


def check_numeric_gradient_reinforce(seed=7, delta=1e-6, verbose=True):
    """策略梯度链的中心差分校验：相对范数差 <1e-5 判过（与 BC 链同门槛）。

    用小维模型（obsDim=6/actDim=4/h=3）做逐元素差分：策略梯度链的解析式与 BCE 链
    只差 `_logit_margin`，小维即可逐张量精确比对；覆盖变长候选掩码与所选动作位。
    """
    dims = {"obsDim": 6, "actDim": 4, "h": 3, "head": "none"}
    params = params_from_json(dims, seed)
    prng = np.random.default_rng(seed)
    b, m = 2, 3
    o = prng.standard_normal((b, 6))
    a = prng.standard_normal((b, m, 4))
    mask = np.ones((b, m), dtype=bool)
    mask[1, 2] = False
    action_idx = np.array([1, 0])
    advantage = np.array([0.7, -0.3])
    ana = backward_reinforce(params, o, a, mask, action_idx, advantage)
    num = {}
    for key in PARAM_SHAPES:
        base = np.asarray(params[key], dtype=np.float64)
        if base.size == 0:
            num[key] = base
            continue
        n = np.zeros(base.size)
        for i in range(base.size):
            p_plus = {k: params[k].copy() for k in PARAM_SHAPES}
            p_minus = {k: params[k].copy() for k in PARAM_SHAPES}
            p_plus[key].reshape(-1)[i] += delta
            p_minus[key].reshape(-1)[i] -= delta
            hi = reinforce_loss(p_plus, o, a, mask, action_idx, advantage)
            lo = reinforce_loss(p_minus, o, a, mask, action_idx, advantage)
            n[i] = (hi - lo) / (2 * delta)
        num[key] = n.reshape(base.shape)
    nf = np.concatenate([np.asarray(num[k]).ravel() for k in PARAM_SHAPES])
    af = np.concatenate([np.asarray(ana[k]).ravel() for k in PARAM_SHAPES])
    rel = float(np.linalg.norm(nf - af) / max(np.linalg.norm(nf), 1e-12))
    if verbose:
        print(f"check-grad reinforce 总相对差 = {rel:.3e}（门槛 1e-5）")
    return rel < 1e-5


if __name__ == "__main__":
    import sys

    sys.exit(0 if check_numeric_gradient_reinforce() else 1)
