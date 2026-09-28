#!/usr/bin/env python3
"""构造覆盖全部内嵌图片形态的最小合法 docx（v0.9.2 端到端验收夹具）

覆盖形态（mammoth 各自的漏网点）：
  image1  行内图 wp:inline            —— mammoth 正常捕获
  image2  行内图 wp:inline            —— mammoth 正常捕获
  image3  浮动锚定图 wp:anchor        —— mammoth 漏
  image4  文本框内图 w:txbxContent    —— mammoth 漏
  image5  VML 老格式 w:pict/v:imagedata —— mammoth 漏
  image6  AlternateContent 双写（Choice=DrawingML + Fallback=VML 同图）—— 只算一次
  image7  页眉图（word/header1.xml 引用，正文不引用）—— 追加文末并标注来源
  另含 1 个外部超链接、H1 标题
"""
import struct, sys, zipfile, zlib

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture'
V = 'urn:schemas-microsoft-com:vml'
MC = 'urn:schemas-microsoft-com:markup-compatibility-2006'
WPS = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape'

# 2x2 纯色 PNG（最小合法图，>64B 过噪声阈值），7 张内容互不相同
def png_2x2(rgb):
    def chunk(t, d):
        c = t + d
        return struct.pack('>I', len(d)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', 2, 2, 8, 2, 0, 0, 0)
    raw = zlib.compress(bytes([0, *rgb] * 2))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', raw) + chunk(b'IEND', b'')

IMAGES = {
    'image1.png': png_2x2((255, 0, 0)),
    'image2.png': png_2x2((0, 128, 0)),
    'image3.png': png_2x2((0, 0, 255)),
    'image4.png': png_2x2((255, 200, 0)),
    'image5.png': png_2x2((255, 0, 255)),
    'image6.png': png_2x2((0, 200, 200)),
    'image7.png': png_2x2((128, 128, 128)),
}


def blip_graphic(rid):
    return (f'<a:graphic><a:graphicData uri="{PIC}/picture">'
            f'<pic:pic><pic:nvPicPr><pic:cNvPr id="0" name=""/><pic:cNvPicPr/></pic:nvPicPr>'
            f'<pic:blipFill><a:blip r:embed="{rid}"/></pic:blipFill>'
            f'<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9525" cy="9525"/></a:xfrm>'
            f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>'
            f'</a:graphicData></a:graphic>')


def inline_drawing(rid):
    return (f'<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
            f'<wp:extent cx="9525" cy="9525"/><wp:docPr id="0" name=""/>'
            f'{blip_graphic(rid)}</wp:inline></w:drawing>')


def anchor_drawing(rid):
    return ('<w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" '
            'relativeHeight="251658240" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1">'
            '<wp:simplePos x="0" y="0"/>'
            '<wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH>'
            '<wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>'
            f'<wp:extent cx="9525" cy="9525"/><wp:wrapNone/><wp:docPr id="0" name=""/>'
            f'{blip_graphic(rid)}</wp:anchor></w:drawing>')


def textbox_drawing(rid):
    return ('<w:r><w:pict><v:shape id="txbx1" style="width:100pt;height:60pt">'
            '<v:textbox><w:txbxContent>'
            '<w:p><w:r><w:t>文本框内说明文字。</w:t></w:r></w:p>'
            f'<w:p><w:r>{inline_drawing(rid)}</w:r></w:p>'
            '</w:txbxContent></v:textbox></v:shape></w:pict></w:r>')


def vml_pict(rid):
    return ('<w:r><w:pict><v:shape id="vml1" style="width:10pt;height:10pt">'
            f'<v:imagedata r:id="{rid}"/></v:shape></w:pict></w:r>')


def alt_content(rid):
    return ('<w:r><mc:AlternateContent>'
            f'<mc:Choice Requires="wps">{inline_drawing(rid)}</mc:Choice>'
            f'<mc:Fallback><w:pict><v:shape id="fb1" style="width:10pt;height:10pt">'
            f'<v:imagedata r:id="{rid}"/></v:shape></w:pict></mc:Fallback>'
            '</mc:AlternateContent></w:r>')


CONTENT_TYPES = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
</Types>'''

RELS = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="{R}/officeDocument" Target="word/document.xml"/>
</Relationships>'''

DOC_RELS = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId10" Type="{R}/image" Target="media/image1.png"/>
<Relationship Id="rId11" Type="{R}/image" Target="media/image2.png"/>
<Relationship Id="rId12" Type="{R}/hyperlink" Target="https://example.com/fixture" TargetMode="External"/>
<Relationship Id="rId13" Type="{R}/image" Target="media/image3.png"/>
<Relationship Id="rId14" Type="{R}/image" Target="media/image4.png"/>
<Relationship Id="rId15" Type="{R}/image" Target="media/image5.png"/>
<Relationship Id="rId16" Type="{R}/image" Target="media/image6.png"/>
<Relationship Id="rId20" Type="{R}/header" Target="header1.xml"/>
</Relationships>'''

HEADER_RELS = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdH1" Type="{R}/image" Target="media/image7.png"/>
</Relationships>'''

HEADER = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="{W}" xmlns:r="{R}" xmlns:v="{V}">
<w:p><w:r><w:t>页眉文字</w:t></w:r><w:r><w:pict><v:shape id="hdr1" style="width:10pt;height:10pt"><v:imagedata r:id="rIdH1"/></v:shape></w:pict></w:r></w:p>
</w:hdr>'''

DOCUMENT = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="{W}" xmlns:r="{R}" xmlns:wp="{WP}" xmlns:a="{A}" xmlns:pic="{PIC}" xmlns:v="{V}" xmlns:mc="{MC}" xmlns:wps="{WPS}">
<w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>验收文档：内嵌图片全形态</w:t></w:r></w:p>
<w:p><w:r><w:t>第一段：行内图之前。</w:t></w:r><w:r>{inline_drawing("rId10")}</w:r><w:r><w:t>行内图之后。</w:t></w:r></w:p>
<w:p><w:r><w:t>第二段：下面是分镜截图。</w:t></w:r><w:r>{inline_drawing("rId11")}</w:r></w:p>
<w:p><w:r><w:t>第三段：浮动锚定图（衬于文字下方）。</w:t></w:r><w:r>{anchor_drawing("rId13")}</w:r></w:p>
<w:p><w:r><w:t>第四段：文本框内嵌图。</w:t></w:r>{textbox_drawing("rId14")}</w:p>
<w:p><w:r><w:t>第五段：VML 老格式图。</w:t></w:r>{vml_pict("rId15")}</w:p>
<w:p><w:r><w:t>第六段：兼容写法（Choice/Fallback 双写同一图，只算一次）。</w:t></w:r>{alt_content("rId16")}</w:p>
<w:p><w:r><w:t>参考资料见 </w:t></w:r><w:hyperlink r:id="rId12"><w:r><w:t>示例站点</w:t></w:r></w:hyperlink></w:p>
<w:sectPr><w:headerReference w:type="default" r:id="rId20"/><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
</w:body>
</w:document>'''

out = sys.argv[1] if len(sys.argv) > 1 else '/tmp/lv-fixture.docx'
with zipfile.ZipFile(out, 'w') as z:
    z.writestr('[Content_Types].xml', CONTENT_TYPES)
    z.writestr('_rels/.rels', RELS)
    z.writestr('word/document.xml', DOCUMENT)
    z.writestr('word/_rels/document.xml.rels', DOC_RELS)
    z.writestr('word/header1.xml', HEADER)
    z.writestr('word/_rels/header1.xml.rels', HEADER_RELS)
    for name, buf in IMAGES.items():
        z.writestr('word/media/' + name, buf)
print('FIXTURE_OK ' + out + ' (' + str(len(IMAGES)) + ' images)')
