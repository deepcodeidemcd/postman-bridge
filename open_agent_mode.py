# -*- coding: utf-8 -*-
"""Open Postman Agent Mode in the bridge profile so doctor/bridge can find the composer."""
import asyncio, os, sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
import nodriver as uc

PROFILE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".postman-profile")
WORKSPACE = "https://pmkzqm7shd77-6336972.postman.co/home"

async def js(tab, script):
    try:
        r = await tab.evaluate(script)
        return "" if r is None else str(r)
    except Exception:
        return ""

async def main():
    browser = await uc.start(
        headless=False,
        browser_args=["--disable-gpu", f"--user-data-dir={PROFILE_DIR}", "--window-size=1280,900"],
    )
    tab = await browser.get(WORKSPACE)
    await asyncio.sleep(8)

    url = await js(tab, "window.location.href")
    print(f"URL: {url[:80]}")

    # Click the AI / Agent Mode button. Look for text "AI" or agent-related buttons.
    clicked = await js(tab, """
        (() => {
            const btns = document.querySelectorAll('button, a, [role="button"]');
            for (const b of btns) {
                if (!b.offsetParent) continue;
                const t = (b.textContent || '').trim().toLowerCase();
                if (t === 'ai' || t === 'agent mode' || (t.includes('ai') && t.length < 15)) {
                    b.click();
                    return 'clicked_ai:' + t;
                }
            }
            return 'no_ai_btn';
        })()
    """)
    print(f"click AI: {clicked}")

    await asyncio.sleep(6)

    # Try again with broader selector (Agent Mode is often an icon button)
    clicked2 = await js(tab, """
        (() => {
            const els = document.querySelectorAll('[aria-label*="agent" i], [aria-label*="ai" i], [title*="agent" i], [title*="ai" i], [data-testid*="agent" i]');
            for (const el of els) {
                if (el.offsetParent) { el.click(); return 'clicked_aria:' + (el.getAttribute('aria-label') || el.getAttribute('title') || ''); }
            }
            return 'none';
        })()
    """)
    print(f"click aria: {clicked2}")
    await asyncio.sleep(6)

    url2 = await js(tab, "window.location.href")
    print(f"URL after: {url2[:100]}")

    # Check composer presence
    comp = await js(tab, """
        (() => {
            const sel = ['textarea[placeholder*="Describe what you need" i]', 'textarea[placeholder*="message" i]', '[contenteditable="true"]', 'textarea'];
            for (const s of sel) {
                const el = document.querySelector(s);
                if (el && el.offsetParent) return 'found:' + s;
            }
            return 'no_composer';
        })()
    """)
    print(f"composer: {comp}")

    await tab.save_screenshot(r"D:\hoat_hinh\Grokpool\check\agent_mode.png")
    await asyncio.sleep(3)
    browser.stop()

asyncio.run(main())
