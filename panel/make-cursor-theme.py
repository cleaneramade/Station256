#!/usr/bin/env python3
"""Makes the Linux cursor theme Station-Windows from the owner's own Windows cursors.

The mouse pointer over Station's window comes from Linux's cursor theme, so it was Adwaita's
black arrow while everything else on the PC showed Windows' pointer. The Windows helper copies
the cursor files the current Windows scheme uses (and cursors.json, which says which file is
which role) into ~/.local/share/station-256/windows-cursors. This turns them into an Xcursor
theme in ~/.local/share/icons/Station-Windows. The files are Microsoft's, so they are converted
on the owner's PC and never kept in this repo.

    python3 make-cursor-theme.py [--src DIR] [--out DIR]
    python3 make-cursor-theme.py --selftest

Only the Python standard library. Runs again only when the source files changed.
"""
import argparse
import json
import os
import struct
import sys
import tempfile

# Every name the browser or a program may ask for, per Windows role. The first one is the real
# file, the rest are links to it. Roles missing from cursors.json fall back to Adwaita.
NAMES = {
    'Arrow': ['left_ptr', 'default', 'arrow', 'top_left_arrow', 'context-menu'],
    'Hand': ['pointer', 'hand2', 'hand1', 'pointing_hand', 'grab', 'grabbing', 'openhand', 'closedhand'],
    'IBeam': ['text', 'xterm', 'ibeam'],
    'SizeWE': ['ew-resize', 'sb_h_double_arrow', 'h_double_arrow', 'col-resize', 'e-resize', 'w-resize'],
    'SizeNS': ['ns-resize', 'sb_v_double_arrow', 'v_double_arrow', 'row-resize', 'n-resize', 's-resize'],
    'SizeNWSE': ['nwse-resize', 'size_fdiag', 'nw-resize', 'se-resize'],
    'SizeNESW': ['nesw-resize', 'size_bdiag', 'ne-resize', 'sw-resize'],
    'SizeAll': ['move', 'fleur', 'all-scroll'],
    'Crosshair': ['crosshair', 'cross'],
    'Wait': ['wait', 'watch'],
    'AppStarting': ['progress', 'left_ptr_watch', 'half-busy'],
    'No': ['not-allowed', 'crossed_circle', 'no-drop', 'forbidden'],
    'Help': ['help', 'question_arrow', 'whats_this'],
}


def read_cur(data):
    """A .cur file as a list of (size, xhot, yhot, pixels). pixels are premultiplied B,G,R,A bytes."""
    images = []
    for i in range(struct.unpack_from('<H', data, 4)[0]):
        _, _, _, _, xhot, yhot, length, offset = struct.unpack_from('<BBBBHHII', data, 6 + 16 * i)
        dib = data[offset:offset + length]
        # shortcut: only plain bitmaps (32-bit colour, or 1-bit black and white); PNG-packed or other
        # depths are skipped. Upgrade when a custom cursor needs them.
        if dib[:4] == b'\x89PNG':
            continue
        header, width, height2, _, bits = struct.unpack_from('<IiiHH', dib, 0)
        height = height2 // 2  # the file stores the picture and the see-through mask on top of each other
        if header != 40 or bits not in (1, 32):
            continue
        if bits == 32:
            stride = width * 4
            pixels = bytearray()
            rows = [dib[40 + y * stride:40 + (y + 1) * stride] for y in range(height)]
            for row in reversed(rows):  # stored bottom row first
                for x in range(width):
                    b, g, r, a = row[x * 4:x * 4 + 4]
                    pixels += bytes((b * a // 255, g * a // 255, r * a // 255, a))
        else:
            # Black and white: the mask says see-through or not; where it isn't, the picture bit picks
            # black or white. See-through-and-white (Windows' "invert the background") has no Linux
            # equivalent, so it is drawn white, which sits well inside the black outline.
            palette = [dib[40 + 4 * k:43 + 4 * k] for k in range(2)]
            stride = (width + 31) // 32 * 4
            body = 40 + 8
            pixels = bytearray()
            for y in reversed(range(height)):
                for x in range(width):
                    bit = lambda base: dib[base + y * stride + x // 8] >> (7 - x % 8) & 1
                    cut, ink = bit(body + stride * height), bit(body)
                    if cut and not ink:
                        pixels += b'\0\0\0\0'
                    else:
                        pixels += palette[ink] + b'\xff'
        images.append((width, xhot, yhot, bytes(pixels)))
    return sorted(images)


def read_ani(data):
    """An animated .ani as (list of frames, delay in ms); each frame is read_cur's list."""
    frames, delay = [], 50
    stack = [(12, len(data))]  # the RIFF's contents, after its 12-byte head
    while stack:
        pos, end = stack.pop()
        while pos + 8 <= end:
            kind, length = struct.unpack_from('<4sI', data, pos)
            body = pos + 8
            if kind == b'LIST':
                stack.append((body + 4, body + length))
            elif kind == b'anih':
                delay = struct.unpack_from('<I', data, body + 28)[0] * 1000 // 60  # in 1/60 s
            elif kind == b'icon':
                frames.append(read_cur(data[body:body + length]))
            pos = body + length + length % 2
    # shortcut: frames play in file order at the one default speed; the optional 'seq ' and 'rate'
    # chunks are ignored. Upgrade if a cursor shows the wrong timing.
    return frames, delay


def load(path):
    data = open(path, 'rb').read()
    frames, delay = read_ani(data) if data[:4] == b'RIFF' else ([read_cur(data)], 0)
    return [f for f in frames if f], delay


def xcursor(frames, delay):
    """The bytes of an Xcursor file. Several frames with the same size make it animated."""
    chunks = []
    for frame in frames:
        for size, xhot, yhot, pixels in frame:
            chunks.append((size, struct.pack('<9I', 36, 0xfffd0002, size, 1, size, len(pixels) // 4 // size, xhot, yhot, delay) + pixels))
    toc, pos = b'', 16 + 12 * len(chunks)
    for size, chunk in chunks:
        toc += struct.pack('<3I', 0xfffd0002, size, pos)
        pos += len(chunk)
    return struct.pack('<4s3I', b'Xcur', 16, 0x10000, len(chunks)) + toc + b''.join(chunk for _, chunk in chunks)


def put(path, content):
    with open(path + '.tmp', 'wb') as file:
        file.write(content)
    os.replace(path + '.tmp', path)


def build(src, out):
    config_file = os.path.join(src, 'cursors.json')
    if not os.path.isdir(src) or not os.path.exists(config_file):
        return 'No Windows cursors copied yet: nothing to do.'
    config = json.load(open(config_file))
    files = sorted(set(config['roles'].values()))
    # A change in any file's size or time rebuilds; a missing file is just left out.
    stamp = json.dumps([config, [(f, os.path.getsize(os.path.join(src, f)), os.stat(os.path.join(src, f)).st_mtime_ns) for f in files if os.path.exists(os.path.join(src, f))]])
    stamp_file = os.path.join(out, '.stamp')
    if os.path.exists(stamp_file) and open(stamp_file).read() == stamp:
        return 'Cursor theme is up to date.'
    os.makedirs(os.path.join(out, 'cursors'), exist_ok=True)
    made = 0
    for role, names in NAMES.items():
        try:
            frames, delay = load(os.path.join(src, config['roles'][role]))
        except (KeyError, OSError, struct.error):
            continue
        if not frames:
            continue
        put(os.path.join(out, 'cursors', names[0]), xcursor(frames, delay))
        for name in names[1:]:
            link = os.path.join(out, 'cursors', name + '.tmp')
            if os.path.lexists(link):
                os.unlink(link)
            os.symlink(names[0], link)
            os.replace(link, os.path.join(out, 'cursors', name))
        made += 1
    put(os.path.join(out, 'index.theme'), b'[Icon Theme]\nName=Station-Windows\nComment=Your Windows cursors\nInherits=Adwaita\n')
    put(stamp_file, stamp.encode())
    return f'Cursor theme made: {made} cursors.'


def selftest():
    """Builds a cursor from a made-up .cur, then reads the Xcursor back."""
    with tempfile.TemporaryDirectory() as tmp:
        w = 2  # 2x2: top-left red (half see-through), the rest clear. Hotspot (1, 0).
        rows = [bytes([0, 0, 200, 128]) + bytes(4), bytes(8)]  # B,G,R,A per pixel, top row first
        dib = struct.pack('<IiiHHIIiiII', 40, w, w * 2, 1, 32, 0, 0, 0, 0, 0, 0)
        dib += b''.join(reversed(rows)) + bytes(8)  # picture bottom row first, then an unused mask
        cur = struct.pack('<HHH', 0, 2, 1) + struct.pack('<BBBBHHII', w, w, 0, 0, 1, 0, len(dib), 22) + dib
        os.mkdir(os.path.join(tmp, 'src'))
        open(os.path.join(tmp, 'src', 'a.cur'), 'wb').write(cur)
        json.dump({'baseSize': 32, 'roles': {'Arrow': 'a.cur', 'Hand': 'missing.cur'}}, open(os.path.join(tmp, 'src', 'cursors.json'), 'w'))
        out = os.path.join(tmp, 'out')
        assert build(os.path.join(tmp, 'src'), out) == 'Cursor theme made: 1 cursors.'
        assert build(os.path.join(tmp, 'src'), out) == 'Cursor theme is up to date.'
        assert os.readlink(os.path.join(out, 'cursors', 'default')) == 'left_ptr'
        assert not os.path.lexists(os.path.join(out, 'cursors', 'pointer'))  # missing file: left to Adwaita
        data = open(os.path.join(out, 'cursors', 'left_ptr'), 'rb').read()
        magic, head, _, count = struct.unpack_from('<4s3I', data)
        assert (magic, head, count) == (b'Xcur', 16, 1)
        kind, nominal, pos = struct.unpack_from('<3I', data, 16)
        assert (kind, nominal) == (0xfffd0002, w)
        _, _, _, _, width, height, xhot, yhot, _ = struct.unpack_from('<9I', data, pos)
        assert (width, height, xhot, yhot) == (2, 2, 1, 0)
        assert data[pos + 36:pos + 40] == bytes([0, 0, 100, 128])  # premultiplied: 200 * 128 / 255
        assert data[pos + 40:] == bytes(12)
        assert build(os.path.join(tmp, 'nothing'), out).startswith('No Windows cursors')
    print('PASS make-cursor-theme selftest')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    home = os.path.expanduser('~')
    parser.add_argument('--src', default=os.path.join(home, '.local/share/station-256/windows-cursors'))
    parser.add_argument('--out', default=os.path.join(home, '.local/share/icons/Station-Windows'))
    parser.add_argument('--selftest', action='store_true')
    args = parser.parse_args()
    if args.selftest:
        selftest()
    else:
        print(build(args.src, args.out))
