# -*- coding: utf-8 -*-
from pathlib import Path
from playwright.sync_api import sync_playwright

# ★ 相对本文件（本脚本住在 preset-content/_meta/）
ROOT = Path(__file__).resolve().parent
HTML = ROOT / "rendered"
SHOT = ROOT / "shots"
ids = ["ai-definition", "ai-hierarchy", "computer-vision", "prog-loop"]

with sync_playwright() as p:
    browser = p.chromium.launch()
    for tid in ids:
        page = browser.new_page(viewport={"width": 720, "height": 520})
        page.goto((HTML / f"{tid}.html").as_uri(), wait_until="load")
        page.wait_for_timeout(2200)
        page.screenshot(path=str(SHOT / f"{tid}-fix.png"))
        print("shot", tid)
        page.close()
    browser.close()
