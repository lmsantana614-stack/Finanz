"""Baut tradingbot.html: eine einzelne Datei mit allem CSS/JS, die man direkt im Browser öffnen kann."""
import re, pathlib
root = pathlib.Path(__file__).parent
html = (root / 'index.html').read_text(encoding='utf-8')
css = (root / 'css/style.css').read_text(encoding='utf-8')
html = html.replace('<link rel="stylesheet" href="css/style.css">', f'<style>\n{css}</style>')
def inline(m):
    js = (root / m.group(1)).read_text(encoding='utf-8')
    return f'<script>\n{js}</script>'
html = re.sub(r'<script src="(js/[^"]+)"></script>', inline, html)
(root / 'tradingbot.html').write_text(html, encoding='utf-8')
print('tradingbot.html', len(html), 'Bytes')
