#!/usr/bin/env python3
"""Regenera los iconos de launcher de Android desde public/logo-symbol.png.

Uso:  python3 scripts/gen-android-icons.py
Requiere Pillow (pip install pillow). Hay que ejecutarlo tras
`cap add android` porque la carpeta android/ es generada y gitignored.

Genera en android/app/src/main/res/:
- ic_launcher.png / ic_launcher_round.png (48dp legacy, 5 densidades)
- ic_launcher_foreground.png (108dp adaptive icon, transparente)
- fija ic_launcher_background al color de marca #010007
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / 'android/app/src/main/res'
SYMBOL = ROOT / 'public/logo-symbol.png'
BG = (1, 0, 7, 255)  # #010007


def compose(symbol, size, scale=0.78):
    canvas = Image.new('RGBA', (size, size), BG)
    h = int(size * scale)
    w = int(h * symbol.width / symbol.height)
    canvas.alpha_composite(symbol.resize((w, h), Image.LANCZOS),
                           ((size - w) // 2, (size - h) // 2))
    return canvas


def round_mask(img):
    s = img.size[0] * 4
    big = img.resize((s, s), Image.LANCZOS)
    mask = Image.new('L', (s, s), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, s - 1, s - 1), fill=255)
    out = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    out.paste(big, (0, 0), mask)
    return out.resize(img.size, Image.LANCZOS)


def main():
    symbol = Image.open(SYMBOL).convert('RGBA')
    densities = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
    for d, m in densities.items():
        out = RES / f'mipmap-{d}'
        out.mkdir(parents=True, exist_ok=True)
        sq = compose(symbol, int(48 * m))
        sq.save(out / 'ic_launcher.png')
        round_mask(sq).save(out / 'ic_launcher_round.png')
        fg = int(108 * m)
        fgimg = Image.new('RGBA', (fg, fg), (0, 0, 0, 0))
        h = int(fg * 0.62)  # zona segura del adaptive icon (~66%)
        w = int(h * symbol.width / symbol.height)
        fgimg.alpha_composite(symbol.resize((w, h), Image.LANCZOS),
                              ((fg - w) // 2, (fg - h) // 2))
        fgimg.save(out / 'ic_launcher_foreground.png')
        print(f'mipmap-{d}: ok')

    bg_xml = RES / 'values/ic_launcher_background.xml'
    bg_xml.parent.mkdir(parents=True, exist_ok=True)
    bg_xml.write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<resources>\n'
        '    <color name="ic_launcher_background">#010007</color>\n'
        '</resources>\n')
    print('background: #010007')


if __name__ == '__main__':
    main()
