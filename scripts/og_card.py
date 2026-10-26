"""Build the link-preview card (og.png, 1200x630) from the ward map.

Usage: python3 scripts/og_card.py && open the printed HTML in headless Chrome (see README).
"""
import json, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
wards = json.load(open(root / 'wards.json'))
ramp = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#2a78d6', '#1c5cab', '#104281']
paths = ''.join(
    f'<path d="{w["d"]}" fill="{ramp[(int(k) * 5) % len(ramp)]}"/>'
    for k, w in sorted(wards['wards'].items(), key=lambda kv: int(kv[0]))
)
html = f'''<!doctype html><html><head><meta charset="utf-8"><style>
* {{ margin: 0; box-sizing: border-box; }}
body {{ width: 1200px; height: 630px; background: #f9f9f7; font-family: -apple-system, "SF Pro Display", "Helvetica Neue", sans-serif; color: #0b0b0b; position: relative; overflow: hidden; }}
.text {{ position: absolute; left: 72px; top: 0; bottom: 0; width: 520px; display: flex; flex-direction: column; justify-content: center; }}
.kicker {{ display: inline-flex; align-items: center; gap: 10px; font-size: 22px; font-weight: 600; color: #2a78d6; letter-spacing: 0.04em; text-transform: uppercase; }}
.kicker i {{ width: 12px; height: 12px; border-radius: 50%; background: #d03b3b; }}
h1 {{ font-size: 72px; line-height: 1.02; letter-spacing: -0.03em; font-weight: 750; margin: 18px 0 22px; }}
p {{ font-size: 27px; line-height: 1.35; color: #52514e; }}
.url {{ position: absolute; left: 72px; bottom: 44px; font-size: 20px; color: #898781; }}
svg {{ position: absolute; right: -10px; top: 40px; width: 640px; height: auto; }}
svg path {{ stroke: #f9f9f7; stroke-width: 2.2; stroke-linejoin: round; }}
</style></head><body>
<div class="text">
  <div class="kicker"><i></i>Live · October 26</div>
  <h1>Toronto 2026 election results</h1>
  <p>Mayor, council and school trustees, ward by ward, with live projections as polls report.</p>
</div>
<div class="url">ndroo.github.io/toronto-election-2026</div>
<svg viewBox="0 0 {wards["w"]} {wards["h"]}">{paths}</svg>
</body></html>'''
out = root / 'dev' / 'og.html'
out.parent.mkdir(exist_ok=True)
out.write_text(html)
print(out)
