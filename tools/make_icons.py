#!/usr/bin/env python3
"""Generate app icons for Trading Journal using only the standard library.

Draws a dark rounded square with ascending candlesticks and writes a valid
RGBA PNG (zlib + struct). Usage: python3 tools/make_icons.py
"""

import os
import struct
import zlib

BG = (13, 17, 23, 255)        # #0d1117
GREEN = (63, 185, 80, 255)    # #3fb950
RED = (248, 81, 73, 255)      # #f85149
TRANSPARENT = (0, 0, 0, 0)


def make_canvas(size):
    return bytearray(size * size * 4)


def set_px(buf, size, x, y, color):
    if 0 <= x < size and 0 <= y < size:
        i = (y * size + x) * 4
        buf[i:i + 4] = bytes(color)


def fill_rect(buf, size, x0, y0, x1, y1, color):
    for y in range(max(0, y0), min(size, y1)):
        for x in range(max(0, x0), min(size, x1)):
            set_px(buf, size, x, y, color)


def rounded_square(buf, size, color):
    """Fill a rounded square (radius ~20% of size); outside stays transparent."""
    r = size * 0.20
    for y in range(size):
        for x in range(size):
            # distance inside corner circles
            cx = min(max(x, r), size - r)
            cy = min(max(y, r), size - r)
            if (x - cx) ** 2 + (y - cy) ** 2 <= r * r or (r <= x < size - r) or (r <= y < size - r):
                set_px(buf, size, x, y, color)


def candle(buf, size, cx, body_top, body_bot, wick_top, wick_bot, color):
    """Draw one candlestick centered at cx; coords are fractions of size."""
    w = int(size * 0.09)              # body width
    wick = max(1, int(size * 0.015))  # wick half-width
    x = int(cx * size)
    fill_rect(buf, size,
              x - wick, int(wick_top * size),
              x + wick + 1, int(wick_bot * size), color)
    fill_rect(buf, size,
              x - w // 2, int(body_top * size),
              x + w // 2 + 1, int(body_bot * size), color)


def draw_icon(size, opaque=False):
    buf = make_canvas(size)
    rounded_square(buf, size, BG)
    if opaque:
        # apple-touch-icon: no transparency anywhere
        for i in range(3, len(buf), 4):
            if buf[i] == 0:
                buf[i - 3:i + 1] = bytes(BG)
    # ascending candles: (cx, body_top, body_bot, wick_top, wick_bot, color)
    candle(buf, size, 0.28, 0.62, 0.72, 0.55, 0.78, GREEN)
    candle(buf, size, 0.44, 0.50, 0.62, 0.44, 0.68, GREEN)
    candle(buf, size, 0.60, 0.46, 0.55, 0.40, 0.60, RED)
    candle(buf, size, 0.76, 0.28, 0.42, 0.20, 0.48, GREEN)
    return buf


def write_png(path, size, buf):
    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))

    raw = b''.join(
        b'\x00' + bytes(buf[y * size * 4:(y + 1) * size * 4])
        for y in range(size)
    )
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(here, '..', 'icons')
    os.makedirs(out, exist_ok=True)
    for size, name in [(192, 'icon-192.png'), (512, 'icon-512.png')]:
        write_png(os.path.join(out, name), size, draw_icon(size))
        print('wrote', name)
    write_png(os.path.join(out, 'apple-touch-icon.png'), 180, draw_icon(180, opaque=True))
    print('wrote apple-touch-icon.png')


if __name__ == '__main__':
    main()
