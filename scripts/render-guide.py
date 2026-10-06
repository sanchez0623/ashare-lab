"""Render the project's authored Markdown subset as an offline user handbook.

Uses only Python's standard library. PDF is optional and published only when
its source fingerprint matches; the HTML always supports browser printing.
"""
import hashlib
import html
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'USER_GUIDE.md'
DEST = ROOT / 'dist'
source = SOURCE.read_text(encoding='utf-8')
fingerprint = hashlib.sha256(source.encode()).hexdigest()


def inline(value):
    # Parse before escaping so commands remain literal, including < and &.
    pattern = r'(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))'
    parts = []
    for part in re.split(pattern, value):
        if part.startswith('`') and part.endswith('`'):
            parts.append('<code>' + html.escape(part[1:-1]) + '</code>')
        elif part.startswith('**') and part.endswith('**'):
            parts.append('<strong>' + html.escape(part[2:-2]) + '</strong>')
        elif re.fullmatch(r'\[[^\]]+\]\([^)]+\)', part):
            label, target = re.fullmatch(r'\[([^\]]+)\]\(([^)]+)\)', part).groups()
            if target.startswith(('https://', 'http://', '#', './')):
                parts.append('<a href="' + html.escape(target, quote=True) + '">' + html.escape(label) + '</a>')
            else:
                parts.append(html.escape(label) + '（' + html.escape(target) + '）')
        else:
            parts.append(html.escape(part))
    return ''.join(parts)


lines = source.splitlines()
blocks, chapters, title = [], [], ''
i, subheading = 0, 0
while i < len(lines):
    line = lines[i]
    if not line.strip():
        i += 1
        continue
    if line.startswith('```'):
        lang = line[3:].strip()
        body = []
        i += 1
        while i < len(lines) and not lines[i].startswith('```'):
            body.append(lines[i])
            i += 1
        if i == len(lines):
            raise ValueError('Unclosed code fence')
        blocks.append('<pre><code data-language="' + html.escape(lang, quote=True) + '">' + html.escape('\n'.join(body)) + '</code></pre>')
        i += 1
        continue
    heading = re.match(r'^(#{1,3}) (.+)$', line)
    if heading:
        level, label = len(heading[1]), heading[2]
        if level == 1:
            title = label
            blocks.append('<h1>' + inline(label) + '</h1>')
        elif level == 2:
            anchor = 'chapter-' + str(len(chapters) + 1).zfill(2)
            chapters.append((anchor, label))
            blocks.append('<h2 id="' + anchor + '">' + inline(label) + '</h2>')
        else:
            subheading += 1
            blocks.append('<h3 id="section-' + str(subheading) + '">' + inline(label) + '</h3>')
        i += 1
        continue
    if line.startswith('|'):
        rows = []
        while i < len(lines) and lines[i].startswith('|'):
            cells = [cell.strip() for cell in lines[i].strip().strip('|').split('|')]
            if not all(re.fullmatch(r':?-+:?', cell) for cell in cells):
                rows.append(cells)
            i += 1
        if not rows or any(len(row) != len(rows[0]) for row in rows):
            raise ValueError('Invalid table')
        header = '<tr>' + ''.join('<th scope="col">' + inline(c) + '</th>' for c in rows[0]) + '</tr>'
        body = ''.join('<tr>' + ''.join('<td>' + inline(c) + '</td>' for c in row) + '</tr>' for row in rows[1:])
        blocks.append('<div class="table-scroll"><table><thead>' + header + '</thead><tbody>' + body + '</tbody></table></div>')
        continue
    marker = re.match(r'^(\d+\. |[-*] )(.+)$', line)
    if marker:
        ordered = marker[1][0].isdigit()
        tag = 'ol' if ordered else 'ul'
        items = []
        while i < len(lines):
            match = re.match(r'^(\d+\. |[-*] )(.+)$', lines[i])
            if not match or match[1][0].isdigit() != ordered:
                break
            items.append('<li>' + inline(match[2]) + '</li>')
            i += 1
        blocks.append('<' + tag + '>' + ''.join(items) + '</' + tag + '>')
        continue
    paragraph = [line]
    i += 1
    while i < len(lines) and lines[i].strip():
        if re.match(r'^(#{1,3} |```|\||\d+\. |[-*] )', lines[i]):
            break
        paragraph.append(lines[i])
        i += 1
    blocks.append('<p>' + inline('\n'.join(paragraph)) + '</p>')

if not title or len(chapters) != 19:
    raise ValueError('Expected a title and 19 handbook chapters')

pdf_meta = DEST / 'guide-pdf.json'
pdf_available = False
if pdf_meta.is_file() and (DEST / 'guide.pdf').is_file():
    try:
        pdf_available = json.loads(pdf_meta.read_text(encoding='utf-8')).get('sourceSha256') == fingerprint
    except (ValueError, OSError):
        pass
if not pdf_available:
    # A changed manual must not silently distribute an older PDF.
    (DEST / 'guide.pdf').unlink(missing_ok=True)
    pdf_meta.unlink(missing_ok=True)

contents = ''.join('<li><a href="#' + anchor + '">' + html.escape(label) + '</a></li>' for anchor, label in chapters)
pdf_link = '<a href="./guide.pdf" download="青衡详细操作说明书.pdf">下载PDF</a>' if pdf_available else ''
css = '''
:root{color-scheme:light;font-family:"Noto Sans CJK SC","Microsoft YaHei","PingFang SC",sans-serif;color:#24364b;background:#f4f6f9;font-size:15px;line-height:1.85}
*{box-sizing:border-box}body{margin:0}a{color:#08786e;text-decoration:none}a:hover{text-decoration:underline}a:focus-visible,button:focus-visible{outline:2px solid #08786e;outline-offset:4px}
.toolbar{display:flex;justify-content:space-between;gap:20px;padding:18px 32px;background:#14253b;color:white;align-items:center}.toolbar a{color:#b8eee3}.toolbar strong{letter-spacing:.1em}.actions{display:flex;flex-wrap:wrap;gap:18px;align-items:center}.actions button{font:inherit;background:none;border:0;color:#b8eee3;cursor:pointer;padding:0}
.page{display:grid;grid-template-columns:260px minmax(0,900px);gap:32px;justify-content:center;align-items:start;padding:32px}.toc{position:sticky;top:24px;max-height:calc(100vh - 48px);overflow:auto;background:white;border:1px solid #e1e8ee;border-radius:10px;padding:22px}.toc h2{font-size:16px;margin:0 0 12px}.toc ol{list-style:none;margin:0;padding:0}.toc li{margin:7px 0;font-size:13px;line-height:1.65}.toc a{display:block;padding:4px 0;color:#486174}
article{background:white;padding:42px 48px;border:1px solid #e1e8ee;border-radius:10px;min-width:0}h1{font-size:28px;line-height:1.5;margin:0 0 22px;letter-spacing:-.03em}h2{font-size:23px;line-height:1.55;margin:56px 0 20px;padding-top:24px;border-top:2px solid #deebe7;color:#08786e;scroll-margin-top:24px}h3{font-size:18px;margin:30px 0 12px;scroll-margin-top:24px}p{margin:12px 0}ol,ul{padding-left:24px;margin:14px 0}li{margin:5px 0}strong{font-weight:700}
code{font-family:"Noto Sans Mono CJK SC",Consolas,monospace;font-size:.88em;background:#f0f4f6;border-radius:3px;padding:1px 4px;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f0f4f6;border-left:3px solid #8fbaaf;border-radius:5px;padding:15px 18px;margin:18px 0;line-height:1.65}pre code{padding:0;background:none}.table-scroll{overflow-x:auto;margin:18px 0}table{width:100%;border-collapse:collapse;font-size:13px;line-height:1.7}th,td{text-align:left;vertical-align:top;border:1px solid #dce5eb;padding:10px 12px;overflow-wrap:anywhere}th{background:#edf5f2;font-weight:700}tbody tr:nth-child(even){background:#fafcfc}.print-toc{display:none}.end-note{margin-top:38px;padding-top:18px;border-top:1px solid #dce5eb;color:#63738b;font-size:13px}
@media(max-width:1000px){.page{grid-template-columns:210px minmax(0,1fr);gap:18px;padding:22px}article{padding:30px}.toolbar{padding:18px 22px}}
@media(max-width:700px){.toolbar{align-items:flex-start;flex-direction:column;padding:18px}.actions{gap:14px;font-size:13px}.page{display:block;padding:16px}.toc{position:static;max-height:none;margin-bottom:18px;padding:18px}.toc ol{columns:2;column-gap:20px}.toc li{break-inside:avoid;font-size:12px}article{padding:24px 20px}h1{font-size:23px}h2{font-size:21px}table{font-size:12px}th,td{padding:8px}pre{padding:12px}}
@page{size:A4;margin:16mm 14mm 17mm}
@media print{:root{font-size:10pt;line-height:1.75;background:white;color:#1a2e3b}.toolbar,.toc,.end-note{display:none}.page{display:block;padding:0}article{border:0;border-radius:0;padding:0;background:white}h1{font-size:23pt;margin:6mm 0 8mm}h2{font-size:17pt;break-before:page;margin:0 0 6mm;padding-top:0;border:0;line-height:1.5}h3{font-size:12pt;margin:7mm 0 3mm}h1,h2,h3{break-after:avoid}p{orphans:3;widows:3;margin:3mm 0}li{margin:1.5mm 0}table{font-size:8.5pt;line-height:1.6}th,td{padding:2.2mm 2.7mm}thead{display:table-header-group}tr{break-inside:avoid}.table-scroll{overflow:visible;margin:4mm 0}pre{font-size:9pt;padding:3mm 4mm;break-inside:avoid}a{color:inherit;text-decoration:none}.print-toc{display:block;break-before:page}.print-toc h2{break-before:auto}.print-toc ol{columns:2;column-gap:9mm;list-style:none;padding:0}.print-toc li{break-inside:avoid;margin:2.5mm 0;font-size:10pt}}
'''
document = '''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="青衡A股单标的回测系统详细操作说明，覆盖采集、回测、自动微调、方案比较与报告。"><meta name="handbook-source-sha256" content="''' + fingerprint + '''"><title>青衡 · 详细操作说明书</title><style>''' + css + '''</style></head><body>
<header class="toolbar"><strong>青衡 · 操作说明书</strong><nav class="actions" aria-label="说明书操作"><a href="./index.html">返回系统</a>''' + pdf_link + '''<a href="./USER_GUIDE.md" download="青衡详细操作说明书.md">下载Markdown</a><button type="button" id="print-guide">打印 / 另存为PDF</button></nav></header>
<div class="page"><nav class="toc" aria-label="章节目录"><h2>章节目录</h2><ol>''' + contents + '''</ol></nav><article>'''
# Place the print table of contents after the cover's introductory paragraphs.
first_chapter = next(n for n, block in enumerate(blocks) if block.startswith('<h2 '))
document += '\n'.join(blocks[:first_chapter])
document += '<section class="print-toc"><h2>章节目录</h2><ol>' + contents + '</ol></section>'
document += '\n'.join(blocks[first_chapter:])
document += '''<p class="end-note">手册与当前部署包配套。请保存数据、配置与报告，并按章节中的验证口径阅读结果。</p></article></div><script>document.getElementById('print-guide').addEventListener('click',()=>window.print());</script></body></html>'''
DEST.mkdir(parents=True, exist_ok=True)
(DEST / 'guide.html').write_text(document, encoding='utf-8')
(DEST / 'USER_GUIDE.md').write_bytes(SOURCE.read_bytes())
print(json.dumps({'handbook': 'dist/guide.html', 'chapters': len(chapters), 'sourceSha256': fingerprint, 'pdfAvailable': pdf_available}, ensure_ascii=False))
