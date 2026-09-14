# -*- coding: utf-8 -*-
"""可微控制器的纯 numpy 数学件：前向 / 反向 / Adam / 参数序列化 / 数值自检。

训练内部一律 float64（数值梯度校验的 1e-5 相对差口径要求），落盘参数由
`params_to_json` 逐值 cast float32 对齐 weights.json 契约。反向逐条对应前向的
乘法交互（factorized bilinear pointer）：每候选独立打分、对候选置换等变，
padding 位挡在 softmax 之外、梯度零贡献。动作特征 `a` 永远是显式入参：本模块
不构造 obs/act 特征（特征语义只有源头一份实现），只对给到的向量做数学。
`check_numeric_gradient` / `memory_selftest` 为确定性自检面，显式 seed。
"""

import math
import random
import time

import numpy as np

PROG_LAMBDA = 0.1  # 进度 critic 辅助头 L2 权重：只在完整轨迹行（progressWeight=1）计入
LABEL_SMOOTHING = 0.05  # 标签平滑：y=(1-eps)*onehot+eps/m，只摊到有效位
WEIGHT_DECAY = 1e-4  # 只加在 wo/wa/ws/wp 权重上，bias 与空张量豁免
PARAM_SHAPES = ("wo", "bo", "wa", "ba", "ws", "wp", "bp")


def _as64(x):
    """数值入口统一转 float64；NaN/Inf 扫描在读入边界负责，这里不重复扫。"""
    return np.asarray(x, dtype=np.float64)


def forward_o(wo, bo, o):
    """h = tanh(o @ Wo^T + bo)；o 取 [..., obsDim]。"""
    return np.tanh(_as64(o) @ _as64(wo).T + _as64(bo))


def forward_z(wa, ba, a_batch):
    """z = tanh(a_batch @ Wa^T + ba)；a_batch 取 [..., actDim]。"""
    return np.tanh(_as64(a_batch) @ _as64(wa).T + _as64(ba))


def scores(ws, h, z_batch):
    """s = Σ_h ws_h·h_h·z_h：逐元素乘后收缩末轴；h 少一维时自动补候选轴。"""
    ws, h, z_batch = _as64(ws), _as64(h), _as64(z_batch)
    if h.ndim == z_batch.ndim - 1 and h.ndim > 1:
        h = h[..., np.newaxis, :]
    return (z_batch * h) @ ws


def softmax_masked(logits, mask):
    """数值稳定 softmax：无效位记 -inf → 概率恰为 0；分母非正的病态行给均匀（正常不触发）。"""
    lg, mk = _as64(logits), np.asarray(mask, dtype=bool)
    single = lg.ndim == 1
    if single:
        lg, mk = lg[None], mk[None]
    lg2 = np.where(mk, lg, -np.inf)
    mx = lg2.max(axis=-1, keepdims=True)
    mx = np.where(np.isfinite(mx), mx, 0.0)  # 整行被掩时 max 为 -inf，兜底后 exp 仍全 0
    e = np.where(mk, np.exp(lg2 - mx), 0.0)
    den = e.sum(axis=-1, keepdims=True)
    out = np.where(den > 0, e / np.where(den > 0, den, 1.0), 1.0 / mk.shape[-1])
    return out[0] if single else out


def policy_forward(params, o, a, mask):
    """整链前向：obs(+候选动作特征+掩码) → 候选集内归一化概率，[..., m]。"""
    o_arr, a_arr = _as64(o), _as64(a)
    single = o_arr.ndim == 1
    o2 = o_arr[None] if single else o_arr
    a2 = a_arr[None] if a_arr.ndim == 2 else a_arr
    mk = np.asarray(mask, dtype=bool)
    mk2 = mk[None] if mk.ndim == 1 else mk
    h = forward_o(params["wo"], params["bo"], o2)
    z = forward_z(params["wa"], params["ba"], a2)
    p = softmax_masked(scores(params["ws"], h, z), mk2)
    return p[0] if single else p


def _y_from_mask(valid, target_idx, eps):
    """软标签：eps 均摊到有效位，pad 位零——平滑分母绝不把 padding 算进候选数。"""
    mk = np.asarray(valid, dtype=bool)
    m_b = np.where(mk.sum(axis=-1) > 0, mk.sum(axis=-1), 1).astype(np.float64)
    y = (eps / m_b)[..., None] * mk
    y[np.arange(mk.shape[0]), _as64(target_idx).astype(int)] += 1.0 - eps
    return y


def ce_loss_with_smoothing(probs, target_idx, eps=LABEL_SMOOTHING):
    """平滑交叉熵 batch 均值；「有效位」以 p>0 判（被掩位概率恰为 0）。"""
    p = _as64(probs)
    p2 = p[None] if p.ndim == 1 else p
    y = _y_from_mask(p2 > 0, np.atleast_1d(target_idx), eps)
    return float(-(y * np.where(p2 > 0, np.log(np.where(p2 > 0, p2, 1.0)), 0.0)).sum(axis=-1).mean())


def progress_loss(h, wp, bp, progress_label, progress_weight):
    """进度头加权 L2 均值：0.5·Σ w_b(ĝ_b−y_b)²/max(1,Σw)；空头或缺标签返回 None。"""
    if wp is None or wp.size == 0 or progress_label is None:
        return None
    w = _as64(progress_weight)
    g_hat = h @ _as64(wp) + _as64(bp)[0]
    sse = float(np.sum(w * (g_hat - _as64(progress_label)) ** 2))
    return 0.5 * sse / max(1.0, float(w.sum()))


def weight_decay_loss(params, weight_decay=WEIGHT_DECAY):
    """0.5·wd·Σ‖W‖²，只含 wo/wa/ws/wp（bias 与空张量豁免）。"""
    acc = 0.0
    for k in ("wo", "wa", "ws", "wp"):
        arr = params.get(k)
        if arr is not None and arr.size:
            acc += float(np.sum(_as64(arr) ** 2))
    return 0.5 * weight_decay * acc


def backward(params, o, a, mask, target_idx, eps=LABEL_SMOOTHING,
             weight_decay=WEIGHT_DECAY, progress_label=None,
             progress_weight=None, prog_lambda=PROG_LAMBDA):
    """整批梯度，与总损失「平滑CE + λ·进度L2 + ½wd‖W‖²」严格同链：
    g = p−y 是 softmax+CE 的标准余量；dh 沿 w_s⊙z 回传、dz 沿 w_s⊙h 回传，tanh 以
    (1−out²) 收口；进度头从 h 分叉共享主干（λ=PROG_LAMBDA 即进度 L2 的权重）。
    """
    o_arr, a_arr = _as64(o), _as64(a)
    o2 = o_arr[None] if o_arr.ndim == 1 else o_arr
    a2 = a_arr[None] if a_arr.ndim == 2 else a_arr
    mk = np.asarray(mask, dtype=bool)
    mk = mk[None] if mk.ndim == 1 else mk
    t = np.atleast_1d(_as64(target_idx).astype(int))
    wo, bo, wa, ba, ws = (_as64(params[k]) for k in ("wo", "bo", "wa", "ba", "ws"))
    wp, bp = _as64(params["wp"]), _as64(params["bp"])
    pre_h = o2 @ wo.T + bo
    h = np.tanh(pre_h)                                            # [B,H]
    zpre = a2.reshape(-1, wa.shape[1]) @ wa.T + ba
    z = np.tanh(zpre.reshape(o2.shape[0], a2.shape[1], -1))      # [B,M,H]
    p = softmax_masked((z * h[:, None, :]) @ ws, mk)              # [B,M]
    y = _y_from_mask(mk, t, eps)
    # CE 是 batch 均值，所以 g=(p−y) 要整链除以 B；进度损失按 Σw 归一、不除 B。
    g = (p - y) * mk / float(p.shape[0])                          # pad 位梯度恒零

    dws = np.einsum("bm,bmh,bh->h", g, z, h)
    dh = np.einsum("bm,bmh,h->bh", g, z, ws)
    dwp, dbp = np.zeros_like(wp), np.zeros_like(bp)
    if wp.size and progress_label is not None:
        w = _as64(progress_weight)
        scale = prog_lambda / max(1.0, float(w.sum()))
        coef = w * (h @ wp + bp[0] - _as64(progress_label)) * scale
        dh = dh + coef[:, None] * wp                             # 进度通道汇入主干
        dwp = (coef[:, None] * h).sum(axis=0)
        dbp = np.array([float(coef.sum())])
    dh_pre = dh * (1.0 - h ** 2)
    dz = g[:, :, None] * (ws * h)[:, None, :]                    # dz_i = g_i·(w_s⊙h)
    dz_pre = dz * (1.0 - z ** 2)
    dwo = dh_pre.T @ o2                                          # outer(dh⊙(1−h²), o) 批式
    dbo = dh_pre.sum(axis=0)
    dwa = dz_pre.reshape(-1, z.shape[-1]).T @ a2.reshape(-1, a2.shape[-1])
    dba = dz_pre.sum(axis=(0, 1))
    if weight_decay:
        dwo, dwa = dwo + weight_decay * wo, dwa + weight_decay * wa
        dws = dws + weight_decay * ws
        if dwp.size:
            dwp = dwp + weight_decay * wp
    return {"wo": dwo, "bo": dbo, "wa": dwa, "ba": dba, "ws": dws, "wp": dwp, "bp": dbp}


class Adam:
    """逐参数标准 Adam（beta1=0.9, beta2=0.999, eps=1e-8）；空张量跳过。"""

    def __init__(self, params):
        self.t = 0
        self.m = {k: np.zeros_like(_as64(v)) for k, v in params.items()}
        self.v = {k: np.zeros_like(_as64(v)) for k, v in params.items()}
    def step(self, params, grads, lr):
        self.t += 1
        for k, p in params.items():
            g = _as64(grads[k])
            if g.size == 0:
                continue
            self.m[k] = 0.9 * self.m[k] + 0.1 * g
            self.v[k] = 0.999 * self.v[k] + 0.001 * g * g
            mhat = self.m[k] / (1.0 - 0.9 ** self.t)
            vhat = self.v[k] / (1.0 - 0.999 ** self.t)
            p -= lr * mhat / (np.sqrt(vhat) + 1e-8)


def params_from_json(dims, seed=0):
    """dims（或完整 weights.json dict）→ 参数 dict；含 params 原样载入，否则随机初始化。

    均匀初始化带宽 1/√fan_in（tanh 饱和与梯度消失之间最平衡），bias 零起步。
    """
    d = dims.get("dims", dims) if isinstance(dims, dict) else None
    if d is None:
        raise ValueError("params_from_json: 既不是 dims 也不是 weights.json dict")
    obs_dim, act_dim, h = int(d["obsDim"]), int(d["actDim"]), int(d["h"])
    detached = d["head"] == "none"
    expect = {"wo": (h, obs_dim), "bo": (h,), "wa": (h, act_dim), "ba": (h,),
              "ws": (h,), "wp": (0,) if detached else (h,), "bp": (0,) if detached else (1,)}
    if "params" in dims:
        out = {}
        for k in PARAM_SHAPES:
            shape = tuple(dims["params"][k]["shape"])
            data = dims["params"][k]["data"]
            if shape != expect[k] or len(data) != int(np.prod(expect[k]) or 0):
                raise ValueError(f"params.{k} shape={shape}×{len(data)} 与 dims 推得的 {expect[k]} 不符")
            out[k] = np.asarray(data, dtype=np.float64).reshape(expect[k])
        return out
    rng = np.random.default_rng(seed)
    uni = lambda n, s: rng.uniform(-1.0 / math.sqrt(n), 1.0 / math.sqrt(n), size=s)
    return {"wo": uni(obs_dim, (h, obs_dim)), "bo": np.zeros(h), "wa": uni(act_dim, (h, act_dim)),
            "ba": np.zeros(h), "ws": uni(h, (h,)),
            "wp": np.zeros(0) if detached else uni(h, (h,)),
            "bp": np.zeros(0) if detached else np.zeros(1)}


def params_to_json(params, to_f32=True):
    """参数 dict → weights.json params 段（shape + 扁平数组；落盘逐值 cast float32）。"""
    out = {}
    for k in PARAM_SHAPES:
        arr = _as64(params[k])
        flat = arr.astype(np.float32).ravel() if (to_f32 and arr.size) else arr.ravel()
        out[k] = {"shape": list(arr.shape), "data": flat.tolist()}
    return out


def _total_loss(params, o, a, mask, target_idx, eps=LABEL_SMOOTHING, wd=WEIGHT_DECAY,
                progress_label=None, progress_weight=None, lam=PROG_LAMBDA):
    """数值梯度比对的参考标量损失（与 backward 的全链同式，但独立前向重算）。"""
    p = policy_forward(params, o, a, mask)
    loss = ce_loss_with_smoothing(p, target_idx, eps)
    h = forward_o(params["wo"], params["bo"], o)
    pl = progress_loss(h, params["wp"], params["bp"], progress_label, progress_weight)
    return loss + (lam * pl if pl is not None else 0.0) + weight_decay_loss(params, wd)


def check_numeric_gradient(seed=7, delta=1e-5, verbose=True):
    """逐条目中心差分梯度 vs 解析梯度：总相对范数差 <1e-5 判过，逐张量打印条目最大相对差。

    覆盖变长候选掩码（m=3 与 m=5 同批）、label smoothing、进度头分叉、权重衰减。
    2D 权重固定 (样本 b, 隐元 r) 把该行全部输入列打包成一批：线性层里 W[r,c] 的
    ±δ 扰动恰为 ±δ·input[c]，逐列走真实整链前向；其余样本贡献两侧同值相消。
    1D 张量条目标量差分；WD 精确二次式差分后恰为 wd·W，后置加上。
    """
    dims = {"obsDim": 867, "actDim": 83, "h": 128, "head": "progress"}  # 867=arch v4 lang 宽，与 train.py EXPECTED_OBS_DIM 对齐
    params = params_from_json(dims, seed)
    prng = np.random.default_rng(seed)
    B, M = 2, 5
    o = prng.standard_normal((B, 867))
    a = np.zeros((B, M, 83))
    mask = np.zeros((B, M), dtype=bool)
    for b, m in enumerate([3, 5]):
        a[b, :m] = prng.standard_normal((m, 83))
        mask[b, :m] = True
    t = np.array([2, 4])
    prog_label = prng.standard_normal(B) * 0.5
    prog_weight = np.array([1.0, 0.0])
    eps, wd, lam = LABEL_SMOOTHING, WEIGHT_DECAY, PROG_LAMBDA
    y_rows = _y_from_mask(mask, t, eps)
    pkw = dict(progress_label=prog_label, progress_weight=prog_weight)
    ana = backward(params, o, a, mask, t, weight_decay=wd, **pkw)
    num = {}
    for key in ("bo", "ba", "ws", "wp", "bp"):  # 1D 条目标量差分
        def one(sign, i):
            p2 = {k: params[k].copy() for k in PARAM_SHAPES}
            p2[key].reshape(-1)[i] += sign * delta
            return _total_loss(p2, o, a, mask, t, eps, wd, **pkw)
        n = np.zeros(params[key].size)
        for i in range(params[key].size):
            n[i] = (one(1.0, i) - one(-1.0, i)) / (2 * delta)
        num[key] = n.reshape(params[key].shape)
    pre_o0 = o @ params["wo"].T + params["bo"]
    pre_z0 = (a.reshape(-1, 83) @ params["wa"].T + params["ba"]).reshape(B, M, 128)
    h = forward_o(params["wo"], params["bo"], o)
    z = forward_z(params["wa"], params["ba"], a)

    def row_loss_vec(pK_vec, ghK, b):
        lp = np.where(pK_vec > 0, np.log(np.where(pK_vec > 0, pK_vec, 1.0)), 0.0)
        ce = -(y_rows[b] * lp).sum(axis=-1) / B
        aux = lam * 0.5 * float(prog_weight[b]) * (ghK - prog_label[b]) ** 2 / max(1.0, float(prog_weight.sum()))
        return ce + aux

    def loss_wo(b, r, sign):
        preK = np.broadcast_to(pre_o0[b], (867, 128)).copy()
        preK[:, r] += sign * delta * o[b]
        hK = np.tanh(preK)
        pK = softmax_masked((z[b] * hK[:, None, :]) @ params["ws"],
                            np.broadcast_to(mask[b], (867, M)))
        return row_loss_vec(pK, hK @ params["wp"] + float(params["bp"][0]), b)

    def loss_wa(b, r, sign):
        zK = np.broadcast_to(pre_z0[b], (83, M, 128)).copy()
        zK[:, :, r] += sign * delta * a[b].T  # [83(c), M] += δ·a[b,m,c]
        pK = softmax_masked((np.tanh(zK) * h[b][None, None, :]) @ params["ws"],
                            np.broadcast_to(mask[b], (83, M)))
        return row_loss_vec(pK, np.full(83, float(h[b] @ params["wp"] + params["bp"][0])), b)

    nwo = np.zeros_like(params["wo"])
    nwa = np.zeros_like(params["wa"])
    for b in range(B):
        for r in range(128):
            nwo[r] += (loss_wo(b, r, 1.0) - loss_wo(b, r, -1.0)) / (2 * delta)
            nwa[r] += (loss_wa(b, r, 1.0) - loss_wa(b, r, -1.0)) / (2 * delta)
    num["wo"] = nwo + wd * params["wo"]
    num["wa"] = nwa + wd * params["wa"]

    nf = np.concatenate([num[k].ravel() for k in PARAM_SHAPES if num[k].size])
    af = np.concatenate([np.asarray(ana[k]).ravel() for k in PARAM_SHAPES if np.asarray(ana[k]).size])
    rel_norm = float(np.linalg.norm(nf - af) / np.linalg.norm(nf))
    if verbose:
        for k in PARAM_SHAPES:
            nk, ak = num[k], np.asarray(ana[k])
            if nk.size:
                rel = np.abs(nk - ak) / (np.abs(nk) + 1e-12)
                print(f"check-grad {k}: 条目最大相对差 {float(rel.max()):.3e}")
        print(f"check-grad 总相对差 |g_num-g_ana|/|g_num| = {rel_norm:.3e}（门槛 1e-5）")
    return rel_norm < 1e-5


def memory_selftest(seed=0, batch=32, epochs_cap=4000, lr=3e-3, verbose=True):
    """记忆自检：32 例合成样本（随机稀疏 obs + 批内共享 one-hot 槽位动作表）整批多轮
    训练至 train acc ≥0.99——拟合链路（前向/反向/Adam）端到端证明。限制 60s 内。"""
    rng = random.Random(seed)
    prng = np.random.default_rng(seed)
    dims = {"obsDim": 867, "actDim": 83, "h": 128, "head": "none"}  # arch v4 口径，与 train.py EXPECTED_OBS_DIM 一致
    params = params_from_json(dims, seed)
    nslots = 8
    slots = np.zeros((nslots, 83))
    for j in range(nslots):
        slots[j, rng.randrange(83)] = 1.0
    o, t, Ms = np.zeros((batch, 867)), np.zeros(batch, dtype=int), []
    for i in range(batch):
        idx = np.sort(prng.choice(867, size=24, replace=False))
        o[i, idx] = prng.uniform(-1, 1, size=24)
        Ms.append(rng.randint(3, nslots))
        t[i] = rng.randrange(Ms[i])
    M = max(Ms)
    a = np.zeros((batch, M, 83))
    mask = np.zeros((batch, M), dtype=bool)
    for i, m in enumerate(Ms):
        a[i, :m] = slots[:m]
        mask[i, :m] = True
    opt = Adam(params)
    t0, acc, ep = time.perf_counter(), 0.0, 0
    for ep in range(1, epochs_cap + 1):
        opt.step(params, backward(params, o, a, mask, t), lr)
        p = policy_forward(params, o, a, mask)
        acc = float((np.argmax(p, axis=-1) == t).mean())
        if acc >= 0.99:
            break
    secs = time.perf_counter() - t0
    if verbose:
        print(f"selftest: train_acc={acc:.3f} epochs={ep} 用时 {secs:.1f}s（限时 60s）")
    return {"train_acc": acc, "epochs": ep, "seconds": secs}
