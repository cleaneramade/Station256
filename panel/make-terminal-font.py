"""Makes Station Mono, the terminal font, from Cascadia Mono (the Windows Terminal font).

Windows Terminal draws block and line-drawing characters itself, so shapes like Claude's logo
touch with no gaps. The panel's terminal draws them with the font, and Cascadia's shapes stop
short of the top or bottom of the row, which leaves thin lines between rows. This stretches
those shapes past the row edges. The terminal cuts every row off at its edges, so the extra
never shows: the shapes just fill the row, the way Windows Terminal draws them.

Nothing else changes. It's renamed because Cascadia's license (SIL Open Font License 1.1)
keeps the name "Cascadia Code" for Microsoft's own unchanged font.

Source: CascadiaCode-2407.24.zip from https://github.com/microsoft/cascadia-code/releases
(sha256 e67a68ee3386db63f48b9054bd196ea752bc6a4ebb4df35adce6733da50c8474), file ttf/CascadiaMono.ttf.
Needs Python with fonttools and brotli (pip install fonttools brotli).

    python make-terminal-font.py CascadiaMono.ttf renderer/fonts
"""
import os
import sys

from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ASCENT, DESCENT = 1900, -480  # Cascadia's row, in font units (2048 to the em)
STRETCH = 520  # how far past the row each edge goes: about a quarter of the letter size
SIDE = 100  # blocks also reach a little into the next letter (about half a dot), so side by side they join
WIDTH = 1200
SHADES = range(0x2591, 0x2594)  # light, medium and dark shade are patterns, left as they are
BOX = range(0x2500, 0x2580)
BLOCKS = range(0x2580, 0x25A0)
WEIGHTS = {400: 'Regular', 700: 'Bold'}


def stretch(font, glyph_name, block):
    glyph_set = font.getGlyphSet()
    recording = DecomposingRecordingPen(glyph_set)
    glyph_set[glyph_name].draw(recording)
    pen = TTGlyphPen(None)
    recording.replay(pen)
    glyph = pen.glyph()
    if glyph.numberOfContours <= 0:
        return False
    coords = glyph.coordinates
    ys = [y for _, y in coords]
    top, bottom = max(ys), min(ys)
    changed = False
    for i, (x, y) in enumerate(coords):
        new_x, new_y = x, y
        if top >= ASCENT and y >= top - 1:
            new_y = ASCENT + STRETCH
        if bottom <= DESCENT and y <= bottom + 1:
            new_y = DESCENT - STRETCH
        if block and x <= 1:
            new_x = -SIDE
        if block and x >= WIDTH - 1:
            new_x = WIDTH + SIDE
        if (new_x, new_y) != (x, y):
            coords[i] = (new_x, new_y)
            changed = True
    if changed:
        glyph.recalcBounds(None)
        font['glyf'][glyph_name] = glyph
        # Keep the left side bearing in step with the new left edge.
        advance, _ = font['hmtx'][glyph_name]
        font['hmtx'][glyph_name] = (advance, glyph.xMin)
    return changed


def rename(font, weight):
    style = WEIGHTS[weight]
    names = {
        1: 'Station Mono',
        2: style,
        3: f'Station Mono {style}; based on Cascadia Mono 2407.24',
        4: f'Station Mono {style}',
        6: f'StationMono-{style}',
        10: 'Cascadia Mono with its block and line-drawing shapes stretched to fill each terminal row.',
        13: 'This Font Software is licensed under the SIL Open Font License, Version 1.1.',
        16: 'Station Mono',
        17: style,
    }
    table = font['name']
    table.names = [rec for rec in table.names if rec.nameID not in (1, 2, 3, 4, 6, 10, 13, 16, 17, 25) and rec.nameID < 256]
    for name_id, text in names.items():
        table.setName(text, name_id, 3, 1, 0x409)
    os2 = font['OS/2']
    os2.usWeightClass = weight
    if weight == 700:
        os2.fsSelection = (os2.fsSelection | 0x20) & ~0x40  # bold, not regular
        font['head'].macStyle |= 0x01
    else:
        os2.fsSelection = (os2.fsSelection | 0x40) & ~0x20
        font['head'].macStyle &= ~0x01
    for tag in ('STAT', 'fvar', 'avar', 'gvar', 'HVAR', 'MVAR', 'cvar'):
        if tag in font:
            del font[tag]


def main(source, out_dir):
    for weight in WEIGHTS:
        font = instancer.instantiateVariableFont(TTFont(source), {'wght': weight})
        cmap = font.getBestCmap()
        glyph_names = set(font.getGlyphOrder())
        changed = 0
        for code in list(BOX) + list(BLOCKS):
            if code in SHADES or code not in cmap:
                continue
            # Each shape has a second copy (".stypo") fitted to the font's row, and that's the one
            # the browser draws: the font swaps it in on its own. Both are stretched.
            for name in (cmap[code], f'{cmap[code]}.stypo'):
                if name in glyph_names:
                    changed += stretch(font, name, code in BLOCKS)
        rename(font, weight)
        font.flavor = 'woff2'
        out = os.path.join(out_dir, f'station-mono-{weight}.woff2')
        font.save(out)
        print(f'{out}: {changed} shapes stretched, {os.path.getsize(out)} bytes')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
