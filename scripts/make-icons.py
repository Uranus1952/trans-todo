#!/usr/bin/env python3
"""
Onederz 图标生成器 —— 只用 Python 标准库（zlib + struct）手写 PNG，
不引入 Pillow 等依赖。3 倍超采样保证圆角与勾线平滑。

生成：icon-192.png / icon-512.png / icon-maskable.png
用法：python scripts/make-icons.py
"""
import math
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'app')
SS = 3  # 超采样倍数


def lerp(a, b, t):
    return a + (b - a) * t


def mix(c1, c2, t):
    return tuple(lerp(c1[i], c2[i], t) for i in range(3))


def rounded_rect_inside(x, y, w, h, r):
    """点 (x,y) 是否落在宽 w 高 h、圆角 r 的圆角矩形内（左上角为原点）。"""
    cx = min(max(x, r), w - r)
    cy = min(max(y, r), h - r)
    if r <= 0:
        return 0 <= x <= w and 0 <= y <= h
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    ln2 = dx * dx + dy * dy
    if ln2 == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / ln2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def render(size, maskable=False):
    """返回 RGBA bytes（未预乘）。"""
    S = size * SS
    px = bytearray(S * S * 4)
    pad = 0.0 if maskable else 0.055          # 非 maskable 留一点外边距给阴影感
    inset = S * pad
    w = h = S - inset * 2
    radius = 0.0 if maskable else w * 0.235

    # 勾线（单位坐标，相对于圆角矩形内部）
    ck = [(0.30, 0.535), (0.445, 0.678), (0.715, 0.345)]
    stroke = w * 0.085

    for y in range(S):
        for x in range(S):
            fx, fy = x - inset, y - inset
            inside = rounded_rect_inside(fx, fy, w, h, radius)
            if not inside:
                continue
            # 对角线渐变 + 左上柔光
            t = (fx / w + fy / h) / 2
            col = mix((0x5B, 0x6B, 0xFF), (0x93, 0x7B, 0xFF), t)
            glow = max(0.0, 1.0 - math.hypot(fx / w - 0.24, fy / h - 0.16) / 0.85) * 0.30
            col = tuple(min(255, c + 255 * glow) for c in col)

            ux, uy = fx / w, fy / h
            d = min(
                seg_dist(ux, uy, *ck[0], *ck[1]),
                seg_dist(ux, uy, *ck[1], *ck[2]),
            )
            if d < stroke / w / 2:
                col = (255, 255, 255)

            i = (y * S + x) * 4
            px[i] = int(col[0])
            px[i + 1] = int(col[1])
            px[i + 2] = int(col[2])
            px[i + 3] = 255

    # 盒式降采样（先预乘，避免边缘发黑）
    out = bytearray(size * size * 4)
    n = SS * SS
    for y in range(size):
        for x in range(size):
            r = g = b = a = 0
            for sy in range(SS):
                for sx in range(SS):
                    i = ((y * SS + sy) * S + (x * SS + sx)) * 4
                    al = px[i + 3]
                    r += px[i] * al
                    g += px[i + 1] * al
                    b += px[i + 2] * al
                    a += al
            o = (y * size + x) * 4
            if a:
                out[o] = min(255, round(r / a))
                out[o + 1] = min(255, round(g / a))
                out[o + 2] = min(255, round(b / a))
            out[o + 3] = round(a / n)
    return bytes(out)


def write_png(path, size, rgba):
    raw = b''.join(
        b'\x00' + bytes(rgba[y * size * 4:(y + 1) * size * 4]) for y in range(size)
    )

    def chunk(tag, data):
        return (
            struct.pack('>I', len(data))
            + tag
            + data
            + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)
    return len(png)


def main():
    jobs = [
        ('icon-192.png', 192, False),
        ('icon-512.png', 512, False),
        ('icon-maskable.png', 512, True),
    ]
    for name, size, maskable in jobs:
        data = render(size, maskable)
        path = os.path.join(OUT, name)
        n = write_png(path, size, data)
        print(f'  ✓ {name}  {size}×{size}  {n / 1024:.1f} KB')
    print('图标已生成到 app/')


if __name__ == '__main__':
    main()
