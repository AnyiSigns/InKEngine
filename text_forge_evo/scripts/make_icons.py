"""生成 Forge 桌面壳图标（PNG + ICO，纯标准库栅格化）。

图案取自 lite 的 favicon.svg：圆角矩形框 + 文形线段（currentColor
描边）。栅格化：线段距离场 + 圆角矩形边框环带，4x4 超采样抗锯齿；
背景透明，描边浅色（深色界面/任务栏均可见）。产物写入
src-tauri/icons/（icon.png 32/128、icon.ico 32）。
"""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

SIZE = 32
STROKE = 1.1  # svg stroke-width 2.2 的一半
FG = (232, 232, 236, 255)  # 浅色描边（currentColor 的栅格化落点）
TRANSPARENT = (0, 0, 0, 0)

# svg 线段（笔画：文形）
LINES = (
    (11, 9, 19, 9),
    (15, 9, 15, 23),
    (17, 14, 22, 14),
    (17, 19, 21, 19),
)

# svg 圆角矩形外框（3,3,29,29 rx=7）
FRAME = (3.0, 3.0, 29.0, 29.0)
FRAME_RX = 7.0


def dist_point_segment(px: float, py: float, x1: float, y1: float, x2: float, y2: float) -> float:
    """点到线段距离（标准几何，无外部依赖）。"""
    dx, dy = x2 - x1, y2 - y1
    length_sq = dx * dx + dy * dy
    if length_sq == 0:
        return math.hypot(px - x1, py - y1)
    t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / length_sq))
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


def inside_rounded_rect(px: float, py: float, x0: float, y0: float, x1: float, y1: float, rx: float) -> bool:
    """点是否在圆角矩形内（含四角圆弧判定）。"""
    if px < x0 or px > x1 or py < y0 or py > y1:
        return False
    if px < x0 + rx and py < y0 + ry(rx):
        return (px - (x0 + rx)) ** 2 + (py - (y0 + rx)) ** 2 <= rx * rx
    if px > x1 - rx and py < y0 + rx:
        return (px - (x1 - rx)) ** 2 + (py - (y0 + rx)) ** 2 <= rx * rx
    if px < x0 + rx and py > y1 - rx:
        return (px - (x0 + rx)) ** 2 + (py - (y1 - rx)) ** 2 <= rx * rx
    if px > x1 - rx and py > y1 - rx:
        return (px - (x1 - rx)) ** 2 + (py - (y1 - rx)) ** 2 <= rx * rx
    return True


def ry(rx: float) -> float:
    return rx  # 圆角矩形横竖圆角一致


def in_frame(px: float, py: float) -> bool:
    """点落在圆角矩形边框环带内（外框内 + 内缩描边框外）。"""
    if not inside_rounded_rect(px, py, *FRAME, FRAME_RX):
        return False
    inset = STROKE
    inner = (FRAME[0] + inset, FRAME[1] + inset, FRAME[2] - inset, FRAME[3] - inset)
    return not inside_rounded_rect(px, py, *inner, FRAME_RX - inset)


def pixel(x: int, y: int) -> tuple[int, int, int, int]:
    """像素着色：4x4 超采样平均（抗锯齿）。"""
    cover = 0.0
    for sy in range(4):
        for sx in range(4):
            px, py = x + (sx + 0.5) / 4.0, y + (sy + 0.5) / 4.0
            if in_frame(px, py):
                cover += 1.0
                continue
            for (x1, y1, x2, y2) in LINES:
                if dist_point_segment(px, py, x1, y1, x2, y2) <= STROKE:
                    cover += 1.0
                    break
    alpha = int(round(cover / 16.0 * 255))
    if alpha == 0:
        return TRANSPARENT
    return (FG[0], FG[1], FG[2], alpha)


def make_png(size: int) -> bytes:
    rows = b""
    for y in range(size):
        rows += b"\x00" + b"".join(struct.pack("4B", *pixel(x, y)) for x in range(size))

    def chunk(tag: bytes, data: bytes) -> bytes:
        block = tag + data
        return (
            struct.pack(">I", len(data))
            + block
            + struct.pack(">I", zlib.crc32(block) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(rows))
        + chunk(b"IEND", b"")
    )


def make_ico(png_bytes: bytes) -> bytes:
    header = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack("<BBBBHHII", 32, 32, 0, 0, 1, 32, len(png_bytes), 22)
    return header + entry + png_bytes


def main() -> None:
    icons_dir = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"
    icons_dir.mkdir(parents=True, exist_ok=True)
    png_32 = make_png(32)
    png_128 = make_png(128)
    (icons_dir / "icon.png").write_bytes(png_128)
    (icons_dir / "icon.ico").write_bytes(make_ico(png_32))
    print(f"已生成: {icons_dir / 'icon.png'} / {icons_dir / 'icon.ico'}")


if __name__ == "__main__":
    main()
