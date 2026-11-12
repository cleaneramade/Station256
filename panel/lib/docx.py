#!/usr/bin/env python3
"""Reads a Word .docx for Station 256's preview, using only Python's own tools.

  docx.py <file.docx>    prints one JSON object: {"blocks": [...], "notes": [...]}

Blocks: {"t":"p","level":0-6,"runs":[...],"list":"1."|"•"|null,"depth":n} or {"t":"table","rows":[[[blocks]]]}.
Runs: {"x":text,"b":1,"i":1,"u":1} or {"br":1} or {"img":"data:...","w":px,"h":px}.
Nothing in the file is run or fetched; it is only read as text and pictures. Sizes are capped.
"""
import base64
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

MAX_FILE = 100 * 1024 * 1024   # the .docx itself
MAX_XML = 40 * 1024 * 1024     # any one XML part, unpacked
MAX_IMAGES = 20 * 1024 * 1024  # all pictures together
MAX_BLOCKS = 20000
MAX_DEPTH = 6                  # tables inside tables
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
A = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
WP = '{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}'
V = '{urn:schemas-microsoft-com:vml}'
PICTURES = {'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'gif': 'image/gif', 'bmp': 'image/bmp', 'webp': 'image/webp'}


class Doc:
    def __init__(self, zf):
        self.zf = zf
        self.notes = []
        self.blocks = 0
        self.image_bytes = 0
        self.skipped_images = 0
        self.counters = {}
        self.rels = {}
        self.styles = {}
        self.numbers = {}
        self.truncated = False

    def xml(self, name, required=False):
        try:
            info = self.zf.getinfo(name)
        except KeyError:
            if required:
                raise ValueError('This isn\'t a Word document (word/document.xml is missing).')
            return None
        if info.file_size > MAX_XML:
            raise ValueError('This document is too big to show here.')
        data = self.zf.read(info)
        if b'<!DOCTYPE' in data[:4096] or b'<!ENTITY' in data[:4096]:
            raise ValueError('This document has something odd in it, so it isn\'t shown.')
        return ET.fromstring(data)

    def load_parts(self):
        rels = self.xml('word/_rels/document.xml.rels')
        for rel in (rels if rels is not None else []):
            if rel.get('TargetMode') != 'External':
                self.rels[rel.get('Id')] = rel.get('Target')
        styles = self.xml('word/styles.xml')
        for style in (styles if styles is not None else []):
            name = style.find(W + 'name')
            if name is not None:
                self.styles[style.get(W + 'styleId')] = name.get(W + 'val', '')
        numbering = self.xml('word/numbering.xml')
        if numbering is not None:
            abstract = {}
            for node in numbering.findall(W + 'abstractNum'):
                abstract[node.get(W + 'abstractNumId')] = {
                    lvl.get(W + 'ilvl'): (lvl.find(W + 'numFmt').get(W + 'val') if lvl.find(W + 'numFmt') is not None else 'decimal')
                    for lvl in node.findall(W + 'lvl')}
            for num in numbering.findall(W + 'num'):
                link = num.find(W + 'abstractNumId')
                if link is not None:
                    self.numbers[num.get(W + 'numId')] = abstract.get(link.get(W + 'val'), {})

    def heading_level(self, ppr):
        style = ppr.find(W + 'pStyle') if ppr is not None else None
        name = self.styles.get(style.get(W + 'val'), '') if style is not None else ''
        name = name.lower()
        if name == 'title':
            return 1
        found = re.match(r'heading (\d)', name)
        return min(int(found.group(1)) + 1, 6) if found else 0  # Heading 1 is the page's h2 under the Title

    def list_label(self, ppr):
        num = ppr.find(W + 'numPr') if ppr is not None else None
        if num is None or num.find(W + 'numId') is None:
            return None, 0
        num_id = num.find(W + 'numId').get(W + 'val')
        if num_id == '0':
            return None, 0
        level = num.find(W + 'ilvl')
        depth = int(level.get(W + 'val')) if level is not None else 0
        kind = self.numbers.get(num_id, {}).get(str(depth), 'decimal')
        if kind == 'bullet' or kind == 'none':
            return '•', depth
        # A number restarts when a shallower one comes up.
        for key in [k for k in self.counters if k[0] == num_id and k[1] > depth]:
            del self.counters[key]
        key = (num_id, depth)
        count = self.counters[key] = self.counters.get(key, 0) + 1
        if kind.endswith('Letter'):
            text = chr(ord('A' if kind.startswith('upper') else 'a') + (count - 1) % 26)
        else:
            text = str(count)
        return text + '.', depth

    def picture(self, rel_id, width, height):
        target = self.rels.get(rel_id)
        if not target:
            return None
        name = target.lstrip('/') if target.startswith('/') else 'word/' + target
        ext = name.rsplit('.', 1)[-1].lower()
        mime = PICTURES.get(ext)
        try:
            info = self.zf.getinfo(name)
        except KeyError:
            return None
        if not mime or self.image_bytes + info.file_size > MAX_IMAGES:
            self.skipped_images += 1
            return {'x': '[picture not shown]', 'i': 1}
        self.image_bytes += info.file_size
        data = base64.b64encode(self.zf.read(info)).decode('ascii')
        run = {'img': 'data:%s;base64,%s' % (mime, data)}
        if width and height:
            run['w'], run['h'] = width, height
        return run

    def run_items(self, run):
        props = run.find(W + 'rPr')
        flags = {}
        if props is not None:
            if props.find(W + 'webHidden') is not None or props.find(W + 'vanish') is not None:
                return []
            for tag, key in (('b', 'b'), ('i', 'i'), ('u', 'u')):
                node = props.find(W + tag)
                if node is not None and node.get(W + 'val') not in ('0', 'false', 'none'):
                    flags[key] = 1
        items = []
        for node in run:
            if node.tag == W + 't':
                if node.text:
                    items.append({'x': node.text, **flags})
            elif node.tag == W + 'tab':
                items.append({'x': '\t', **flags})
            elif node.tag in (W + 'br', W + 'cr'):
                items.append({'br': 2 if node.get(W + 'type') == 'page' else 1})
            elif node.tag == W + 'drawing':
                blip = node.find('.//' + A + 'blip')
                extent = node.find('.//' + WP + 'extent')
                width = round(int(extent.get('cx')) / 9525) if extent is not None else 0
                height = round(int(extent.get('cy')) / 9525) if extent is not None else 0
                item = self.picture(blip.get(R + 'embed'), width, height) if blip is not None else None
                if item:
                    items.append(item)
            elif node.tag == W + 'pict':
                image = node.find('.//' + V + 'imagedata')
                item = self.picture(image.get(R + 'id'), 0, 0) if image is not None else None
                if item:
                    items.append(item)
        return items

    def paragraph(self, node):
        ppr = node.find(W + 'pPr')
        runs = []
        for child in node.iter():
            if child.tag == W + 'r':
                runs.extend(self.run_items(child))
        label, depth = self.list_label(ppr)
        block = {'t': 'p', 'level': self.heading_level(ppr), 'runs': runs, 'list': label, 'depth': depth}
        jc = ppr.find(W + 'jc') if ppr is not None else None
        if jc is not None and jc.get(W + 'val') in ('center', 'right'):
            block['align'] = jc.get(W + 'val')
        return block

    def table(self, node, depth):
        rows = []
        for row in node.findall(W + 'tr'):
            cells = []
            for cell in row.findall(W + 'tc'):
                cells.append(self.blocks_in(cell, depth + 1))
            rows.append(cells)
        return {'t': 'table', 'rows': rows}

    def blocks_in(self, parent, depth=0):
        out = []
        for node in parent:
            if self.blocks >= MAX_BLOCKS:
                self.truncated = True
                break
            if node.tag == W + 'p':
                self.blocks += 1
                out.append(self.paragraph(node))
            elif node.tag == W + 'tbl' and depth < MAX_DEPTH:
                self.blocks += 1
                out.append(self.table(node, depth))
            elif node.tag in (W + 'sdt', W + 'sdtContent'):  # content controls (a table of contents is one)
                out.extend(self.blocks_in(node.find(W + 'sdtContent') if node.tag == W + 'sdt' else node, depth))
        return out


def read(path):
    with open(path, 'rb') as probe:
        probe.seek(0, 2)
        if probe.tell() > MAX_FILE:
            raise ValueError('This document is too big to show here.')
    with zipfile.ZipFile(path) as zf:
        doc = Doc(zf)
        root = doc.xml('word/document.xml', required=True)
        doc.load_parts()
        body = root.find(W + 'body')
        blocks = doc.blocks_in(body if body is not None else [])
        if doc.truncated:
            doc.notes.append('Only the first part of this document is shown.')
        if doc.skipped_images:
            doc.notes.append('%d picture(s) weren\'t shown (too many, or a kind that can\'t be shown here).' % doc.skipped_images)
        return {'blocks': blocks, 'notes': doc.notes}


if __name__ == '__main__':
    try:
        print(json.dumps({'result': read(sys.argv[1])}))
    except (zipfile.BadZipFile, ET.ParseError):
        print(json.dumps({'error': 'This isn\'t a Word document that can be read.'}))
    except (ValueError, OSError) as problem:
        print(json.dumps({'error': str(problem)}))
