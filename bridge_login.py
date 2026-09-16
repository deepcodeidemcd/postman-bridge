# -*- coding: utf-8 -*-
"""
Login a registered Postman account into the bridge's Chrome profile (.postman-profile).
After this, the TS bridge (Playwright) can reuse the logged-in session.

Usage:
  python bridge_login.py [email] [password]
  (defaults: newest account from postman_accounts.jsonl)
"""
import asyncio
import json
import os
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
import nodriver as uc

PROFILE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".postman-profile")
ACCOUNTS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "postman_accounts.jsonl")
CHECK_DIR = r"D:\hoat_hinh\Grokpool\check"


def newest_account():
    if not os.path.exists(ACCOUNTS_FILE):
        return None
    with open(ACCOUNTS_FILE, "r", encoding="utf-8") as f:
        lines = [l.strip() for l in f if l.strip()]
    if not lines:
        return None
    # last line = newest
    return json.loads(lines[-1])


async def js(tab, script):
    try:
        r = await tab.evaluate(script)
        return "" if r is None else str(r)
    except Exception:
        return ""


async def wait_cf(tab, max_wait=60):
    for i in range(max_wait // 3):
        await asyncio.sleep(3)
        body = await js(tab, "document.body.innerText") or ""
        url = await js(tab, "window.location.href") or ""
        if not ("Performing security verification" in body or "Verify you are human" in body or "Just a moment" in body or "challenges.cloudflare" in url):
            return True
    return False


async def wait_turnstile(tab, max_wait=45):
    for i in range(max_wait // 2):
        await asyncio.sleep(2)
        v = await js(tab, "(() => { const r = document.querySelector(\"input[name='cf-turnstile-response']\"); return (r && r.value && r.value.length > 10) ? 'ready' : 'no'; })()")
        if v == "ready":
            return True
        body = await js(tab, "document.body.innerText") or ""
        if "Unable to verify" in body:
            return False
    return False


async def main():
    account = newest_account()
    if len(sys.argv) >= 3:
        account = {"email": sys.argv[1], "password": sys.argv[2]}
    if not account:
        print("no account found")
        return 1

    email = account["email"]
    password = account["password"]
    print(f"login: {email}")

    browser = await uc.start(
        headless=False,
        browser_args=[
            "--disable-gpu",
            f"--user-data-dir={PROFILE_DIR}",
            "--window-size=1280,900",
        ],
    )

    tab = await browser.get("https://identity.getpostman.com/login")

    # CF
    if not await wait_cf(tab):
        print("CF FAILED")
        return 1

    # DOM
    for i in range(20):
        await asyncio.sleep(2)
        n = await js(tab, "document.querySelectorAll('input:not([type=hidden]):not([type=checkbox])').length")
        if n.isdigit() and int(n) >= 2:
            break

    # Turnstile
    if not await wait_turnstile(tab):
        print("Turnstile FAILED")
        return 1

    # Fill
    await js(tab, f"""
        (() => {{
            const u = document.querySelector('#username');
            const p = document.querySelector('#password');
            if (u) {{ u.focus(); u.value = '{email}'; u.dispatchEvent(new Event('input', {{bubbles:true}})); }}
            if (p) {{ p.focus(); p.value = '{password}'; p.dispatchEvent(new Event('input', {{bubbles:true}})); }}
            return 'ok';
        }})()
    """)
    await asyncio.sleep(1)
    await js(tab, "document.querySelector('button[type=submit]').click()")
    print("submitted, waiting for redirect...")

    # Wait to land on postman workspace
    for i in range(40):
        await asyncio.sleep(3)
        url = await js(tab, "window.location.href") or ""
        body = await js(tab, "document.body.innerText") or ""
        if "postman.co" in url and "identity.getpostman.com" not in url:
            print(f"LOGGED IN: {url[:100]}")
            # Wait a bit for the app to save session cookies
            await asyncio.sleep(10)
            try:
                await tab.save_screenshot(os.path.join(CHECK_DIR, "bridge_login_ok.png"))
            except Exception:
                pass
            browser.stop()
            # save login url for .env
            with open(os.path.join(os.path.dirname(ACCOUNTS_FILE), "bridge_workspace_url.txt"), "w") as f:
                f.write(url)
            return 0
        if "incorrect" in body.lower() or "invalid" in body.lower():
            print(f"LOGIN ERROR: {body[:200]}")
            browser.stop()
            return 1
    print("login redirect timeout")
    browser.stop()
    return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
