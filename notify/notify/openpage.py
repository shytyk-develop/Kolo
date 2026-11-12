from __future__ import annotations

import html
import json

from .texts import plain

STYLE = """
:root{color-scheme:light dark;--bg:#fff;--fg:#1c1c1e;--muted:#6e6e73;--btn:#1c1c1e;--btn-fg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#000;--fg:#f5f5f7;--muted:#a1a1a6;--btn:#f5f5f7;--btn-fg:#000}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:var(--bg);color:var(--fg);font:16px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{width:100%;max-width:420px;padding:32px 16px;text-align:center}
h1{font-size:22px;margin:0 0 8px}
p{margin:0 0 24px;color:var(--muted)}
a.btn{display:block;padding:16px;border-radius:14px;background:var(--btn);color:var(--btn-fg);
font-weight:600;font-size:17px;text-decoration:none}
.url{margin-top:16px;font-size:13px;color:var(--muted);word-break:break-all;user-select:all}
"""

# openLink may need a tap: try now, keep the buttons
SCRIPT = """
(function () {
  var url = %(url)s, label = %(label)s;
  var tg = window.Telegram && window.Telegram.WebApp;
  if (!tg || !tg.initData || typeof tg.openLink !== "function") return;
  tg.ready();
  function go(closeNow) {
    try { tg.openLink(url); } catch (e) { return false; }
    if (closeNow) setTimeout(function () { tg.close(); }, 300);
    return true;
  }
  // browser is up: close
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) setTimeout(function () { tg.close(); }, 300);
  });
  document.getElementById("open").addEventListener("click", function (e) {
    if (go(true)) e.preventDefault();
  });
  tg.MainButton.setParams({ text: label, is_visible: true });
  tg.MainButton.onClick(function () { go(true); });
  go(false);
})();
"""


def _js(value: str) -> str:
    # can't close the <script> tag
    return json.dumps(value).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def render(url: str | None, lang: str, nonce: str) -> str:
    # url=None: the link didn't verify
    if url is None:
        body = (
            f"<h1>{html.escape(plain(lang, 'open_bad_title'))}</h1>"
            f"<p>{html.escape(plain(lang, 'open_bad'))}</p>"
        )
        script = ""
    else:
        label = plain(lang, "open_btn")
        body = (
            f"<h1>{html.escape(plain(lang, 'open_title'))}</h1>"
            f"<p>{html.escape(plain(lang, 'open_hint'))}</p>"
            f'<a id="open" class="btn" href="{html.escape(url)}" target="_blank" rel="noopener noreferrer">'
            f"{html.escape(label)}</a>"
            f'<div class="url">{html.escape(url)}</div>'
        )
        script = (
            '<script src="https://telegram.org/js/telegram-web-app.js"></script>'
            f'<script nonce="{nonce}">{SCRIPT % {"url": _js(url), "label": _js(label)}}</script>'
        )
    return (
        f'<!doctype html><html lang="{html.escape(lang)}"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
        '<meta name="referrer" content="no-referrer"><title>Kolo</title>'
        f'<style nonce="{nonce}">{STYLE}</style></head>'
        f"<body><main>{body}</main>{script}</body></html>"
    )


def headers(nonce: str) -> dict[str, str]:
    csp = (
        "default-src 'none'; "
        f"script-src 'nonce-{nonce}' https://telegram.org; "
        f"style-src 'nonce-{nonce}'; "
        "base-uri 'none'; form-action 'none'"
    )
    return {
        "Content-Security-Policy": csp,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
    }
