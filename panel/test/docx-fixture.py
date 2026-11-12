#!/usr/bin/env python3
"""Makes a tiny Word file for the docx tests: a heading, a bold word, a 2x2 table, a bullet, a picture.
   docx-fixture.py <out.docx>"""
import base64
import sys
import zipfile

W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
cell = lambda t: '<w:tc><w:p><w:r><w:t>%s</w:t></w:r></w:p></w:tc>' % t
body = (
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Fixture Heading</w:t></w:r></w:p>'
    '<w:p><w:r><w:t xml:space="preserve">Plain then </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>BoldWord</w:t></w:r></w:p>'
    '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>BulletOne</w:t></w:r></w:p>'
    '<w:tbl><w:tr>' + cell('A1') + cell('B1') + '</w:tr><w:tr>' + cell('A2') + cell('B2') + '</w:tr></w:tbl>'
    '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="95250" cy="95250"/><a:graphic><a:graphicData><a:pic><a:blipFill><a:blip r:embed="rId5"/></a:blipFill></a:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
)
parts = {
    'word/document.xml': '<w:document %s><w:body>%s</w:body></w:document>' % (W, body),
    'word/styles.xml': '<w:styles %s><w:style w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>' % W,
    'word/numbering.xml': '<w:numbering %s><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>' % W,
    'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId5" Type="image" Target="media/dot.png"/></Relationships>',
}
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as zf:
    for name, text in parts.items():
        zf.writestr(name, text)
    zf.writestr('word/media/dot.png', PNG)
