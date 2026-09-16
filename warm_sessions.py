"""
Warm pool sessions: nodriver (proven CF-passing) logs in each completed
account and exports a Playwright-compatible storageState JSON to .sessions/.
The bridge pool then skips interactive login entirely (fast path).

Usage:
  python warm_sessions.py <start> <end>     # process accounts [start,end)
  Env WARM_HEADLESS=1 to force headless test.
"""
import asyncio, json, os, re, sys, time
import nodriver as uc
import nodriver.cdp.network as net

PROJ = os.path.dirname(os.path.abspath(__file__))
ACCOUNTS = os.path.join(PROJ, "postman_accounts.jsonl")
SESS_DIR = os.path.join(PROJ, ".sessions")
DONE_LOG = os.path.join(PROJ, "warm_sessions_done.jsonl")
LOCK_DIR = os.path.join(PROJ, ".sessions", ".locks")
# PERSISTENT profile: cf_clearance survives restarts so Cloudflare does not
# re-challenge every warm_sessions run (fresh temp profile = new challenge).
WARM_PROFILE = os.path.join(PROJ, ".pm-warm-profile")


def safe_name(email: str) -> str:
    base = re.sub(r"[^a-z0-9]", "_", email.lower())[:40]
    h = 0
    for ch in email:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return f"{base}_{h:x}"


def try_claim(email: str) -> bool:
    """Lock file per email; stale locks (>20 min) are stolen. Keeps parallel
    shards from logging in the same account at once."""
    os.makedirs(LOCK_DIR, exist_ok=True)
    lp = os.path.join(LOCK_DIR, safe_name(email) + ".lock")
    try:
        if os.path.exists(lp):
            if time.time() - os.path.getmtime(lp) < 1200:
                return False
            os.remove(lp)
        fd = os.open(lp, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        return True
    except FileExistsError:
        return False


def release_claim(email: str):
    try:
        os.remove(os.path.join(LOCK_DIR, safe_name(email) + ".lock"))
    except Exception:
        pass


def load_done() -> set:
    """Emails with a SUCCESSFUL warm (ok:true). Failures stay retriable."""
    done = set()
    if os.path.exists(DONE_LOG):
        # last write per email wins
        latest = {}
        for line in open(DONE_LOG, encoding="utf-8"):
            try:
                rec = json.loads(line)
                latest[rec["email"]] = rec.get("ok")
            except Exception:
                pass
        done = {e for e, ok in latest.items() if ok}
    return done


def mark_done(email: str, ok: bool):
    with open(DONE_LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps({"email": email, "ok": ok, "ts": time.time()}) + "\n")


async def js(tab, script):
    try:
        r = await tab.evaluate(script)
        return "" if r is None else str(r)
    except Exception:
        return ""


async def fill_field(tab, selector, value):
    return await js(tab, f"""
        (() => {{
            const el = document.querySelector("{selector}");
            if (!el) return 'not_found';
            el.focus();
            el.value = '';
            el.dispatchEvent(new Event('input', {{bubbles: true}}));
            el.value = '{value}';
            el.dispatchEvent(new Event('input', {{bubbles: true}}));
            el.dispatchEvent(new Event('change', {{bubbles: true}}));
            el.blur();
            return 'ok:' + el.value.substring(0, 5);
        }})()
    """)


async def wait_cf(tab, max_wait=60):
    for i in range(max_wait // 3):
        await asyncio.sleep(3)
        body = await js(tab, "document.body.innerText") or ""
        url = await js(tab, "window.location.href") or ""
        if not ("Just a moment" in body or "Verify you are human" in body or "challenges.cloudflare" in url):
            return True
    return False


async def solve_cf(tab, max_wait=150):
    """CF interstitial: wait, and on later rounds click the challenge
    checkbox position (iframe is cross-origin, but a raw CDP mouse click at
    its visual location works)."""
    import random
    for i in range(max_wait // 5):
        body = await js(tab, "document.body.innerText") or ""
        url = await js(tab, "window.location.href") or ""
        challenged = ("Just a moment" in body or "Verify you are human" in body
                      or "Performing security verification" in body
                      or "challenges.cloudflare" in url)
        if not challenged:
            return True
        if i >= 2:  # auto-pass failed once -> try clicking the checkbox
            rect = await js(tab, """
                (() => {
                    const f = document.querySelector('iframe[src*="challenges.cloudflare"], iframe[title*="challenge"]');
                    if (!f) return 'null';
                    const r = f.getBoundingClientRect();
                    if (r.width < 10) return 'null';
                    return Math.round(r.x + 30) + ',' + Math.round(r.y + r.height / 2);
                })()
            """)
            if rect and "," in str(rect):
                try:
                    xs, ys = str(rect).split(",", 1)
                    await tab.mouse_click(int(float(xs)) + random.randint(-2, 2), int(float(ys)) + random.randint(-2, 2))
                except Exception:
                    pass
        await asyncio.sleep(5)
    return False


async def poll_form(tab, seconds=120):
    """Wait until #username+#password are present. While waiting: click the
    CF interstitial checkbox spot, dismiss account choosers. Proven flow:
    a prior www.postman.com visit makes CF pass automatically."""
    for i in range(seconds // 3):
        n = await js(tab, "document.querySelectorAll('#username,#password').length")
        if str(n) == "2":
            return True
        body = await js(tab, "document.body.innerText") or ""
        if "Just a moment" in body or "Verify you are human" in body:
            for dx, dy in [(0, 0), (2, -2), (-2, 2)]:
                try:
                    await tab.mouse_click(332 + dx, 460 + dy)
                except Exception:
                    pass
        elif "different account" in body.lower() or "use another" in body.lower():
            await js(tab, """(() => {
                const els = Array.from(document.querySelectorAll('a,button,[role=button]'));
                for (const el of els) {
                    const t=(el.textContent||'').trim().toLowerCase();
                    if (/different account|another account|use another/.test(t)) { el.click(); return; }
                }
            })()""")
        await asyncio.sleep(3)
    return False


async def login_one(browser, acc):
    email, pw = acc["email"], acc["password"]
    # PROVEN FLOW (test_warm2): warm the CF clearance on www.postman.com
    # FIRST, then go to the login form. No cookie clearing (that kills the
    # clearance and triggers a hard challenge).
    warm = await browser.get("https://www.postman.com/", new_tab=True)
    await asyncio.sleep(8)
    await warm.close()
    tab = await browser.get("https://identity.getpostman.com/login", new_tab=True)
    if not await poll_form(tab):
        cur = await js(tab, "window.location.href") or ""
        title = await js(tab, "document.title")
        await tab.close()
        return f"no_form url={cur[:70]} title={title[:30]}"

    r = await fill_field(tab, "#username", email)
    if not r.startswith("ok"):
        await tab.close()
        return f"fill_user:{r}"
    r = await fill_field(tab, "#password", pw)
    if not r.startswith("ok"):
        await tab.close()
        return f"fill_pass:{r}"
    # verify values stuck
    chk = await js(tab, """
        (() => {
            const u = document.querySelector('#username'), p = document.querySelector('#password');
            return JSON.stringify({u: u? u.value:'', p: p? p.value.length:0});
        })()
    """) or ""
    await js(tab, "(() => { const b=document.querySelector('button[type=submit]'); if(b) b.click(); })()")
    landed = False
    url = ""
    for i in range(45):
        await asyncio.sleep(2)
        url = await js(tab, "window.location.href") or ""
        low = url.lower()
        if ("postman.co" in low or "postman.com" in low) and "identity" not in low and "login" not in low and "sign" not in low:
            landed = True
            break
        # authFlowId pages bounce back to /login while the flow settles;
        # the re-rendered form may be empty — re-fill then submit ONCE.
        if i == 12 and "login" in low:
            await js(tab, "(() => { const u=document.querySelector('#username'); return u?2:0; })()")
            nf = await js(tab, "document.querySelectorAll('#username,#password').length")
            if str(nf) == "2":
                await fill_field(tab, "#username", email)
                await fill_field(tab, "#password", pw)
                await js(tab, "(() => { const b=document.querySelector('button[type=submit]'); if(b) b.click(); })()")
                print("   mid-wait re-submit", flush=True)
    if not landed:
        await tab.close()
        return f"land_fail:{url[:60]}"

    # let the app set its workspace cookies
    await asyncio.sleep(6)
    url = await js(tab, "window.location.href") or ""
    team = re.search(r"https://([a-z0-9-]+)\.postman\.co", url)
    if team:
        try:
            await tab.get(team.group(0) + "/home")
        except Exception:
            pass
        await asyncio.sleep(6)

    # IDENTITY CHECK (no /accounts page — CF-hostile): our registration flow
    # names each team after the account (team subdomain prefix == email
    # prefix or username in ~90% of the pool). If the landed team matches
    # this account, the jar is definitely THIS session; a stale/contaminated
    # login lands on another team and gets rejected (then retried).
    ep = email.split("@")[0]
    un = acc.get("username") or ""
    team_name = team.group(1) if team else ""
    team_prefix = re.sub(r"-\d+$", "", team_name)
    team_ok = bool(team) and (team_name in (ep, un) or team_prefix in (ep, un))
    if not team_ok:
        # Fallback for the ~10% with a differently-named team: check the
        # app's own cookie meta instead of a page navigation. postman.meta is
        # an account-bound opaque value; compare against the pool file: if we
        # have never exported this email before, trust a fresh login only when
        # we also see a session cookie issued just now.
        fresh = await js(tab, """
            (() => {
                const c = document.cookie;
                return /getpostmanlogin=yes/.test(c) ? 'yes' : 'no';
            })()
        """)
        if fresh != "yes" or not team:
            await tab.close()
            return f"identity_unverified team={(team.group(1) if team else 'none')}"
        # team exists but unknown name: verify it hosts THIS user's workspace
        # by checking the team URL loads without redirect back to /login.
        try:
            await tab.get(team.group(0) + "/home")
            await asyncio.sleep(5)
            after = await js(tab, "window.location.href") or ""
            if "login" in after.lower() or "identity" in after.lower():
                await tab.close()
                return "identity_redirect_login"
        except Exception:
            pass

    # collect cookies via the TAB's CDP session (browser-level send returns
    # empty — tab.send is the pattern proven by the registration script).
    cookie_urls = [
        "https://identity.getpostman.com",
        "https://www.getpostman.com",
        "https://www.postman.com",
        "https://www.postman.co",
    ]
    if team:
        cookie_urls.append(team.group(0))
    all_cookies = {}
    try:
        cs = await tab.send(net.get_cookies(urls=cookie_urls))
        for c in (cs or []):
            key = (c.name, c.domain, getattr(c, "path", "/") or "/")
            all_cookies[key] = c
    except Exception as e:
        print(f"   getCookies batch failed: {e}", flush=True)
    if not all_cookies:
        # last resort: nodriver's tracked cookie jar
        try:
            for c in (browser.cookies or []):
                key = (c.name, c.domain, getattr(c, "path", "/") or "/")
                all_cookies[key] = c
        except Exception:
            pass
    cookies = []
    for c in all_cookies.values():
        ss_raw = str(getattr(c, "same_site", "Lax") or "Lax")
        ss = {"nonesrestriction": "None", "no_restriction": "None", "lax": "Lax",
              "strict": "Strict", "none": "None"}.get(ss_raw.lower(), "Lax")
        exp = getattr(c, "expires", -1)
        try:
            exp = float(exp)
        except Exception:
            exp = -1
        if getattr(c, "session", False):
            exp = -1
        cookies.append({
            "name": c.name,
            "value": c.value,
            "domain": c.domain,
            "path": getattr(c, "path", "/") or "/",
            "expires": exp,
            "httpOnly": bool(getattr(c, "http_only", False)),
            "secure": bool(getattr(c, "secure", True)),
            "sameSite": ss,
        })

    # localStorage of the workspace origin
    origin = re.search(r"https://[a-z0-9-]+\.postman\.co", url)
    origins = []
    if origin:
        try:
            ls_raw = await js(tab, """
                (() => {
                    const out = [];
                    for (let i = 0; i < localStorage.length; i++) {
                        const k = localStorage.key(i);
                        out.push({ name: k, value: localStorage.getItem(k) });
                    }
                    return JSON.stringify(out);
                })()
            """)
            origins = [{"origin": origin.group(0), "localStorage": json.loads(ls_raw) if ls_raw else []}]
        except Exception:
            pass

    if len(cookies) < 3:
        await tab.close()
        return f"export_empty:{len(cookies)}cookies"

    state = {"cookies": cookies, "origins": origins}
    os.makedirs(SESS_DIR, exist_ok=True)
    path = os.path.join(SESS_DIR, safe_name(email) + ".json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(state, f)
    await tab.close()
    return f"OK:{len(cookies)}cookies"


async def main():
    # SHARD model: run N separate processes (each = own Chrome + own cookie
    # jar). Parallel TABS in one browser would share the jar and mix two
    # accounts' session cookies — unacceptable for a per-account export.
    workers = int(os.environ.get("WARM_WORKERS", "3"))
    shard = int(os.environ.get("WARM_SHARD", "0"))
    max_fail = int(os.environ.get("WARM_MAX_FAIL", "3"))
    accounts = [json.loads(l) for l in open(ACCOUNTS, encoding="utf-8") if l.strip()]
    done = load_done()
    fails = {}
    if os.path.exists(DONE_LOG):
        for line in open(DONE_LOG, encoding="utf-8"):
            try:
                rec = json.loads(line)
                if not rec.get("ok"):
                    fails[rec["email"]] = fails.get(rec["email"], 0) + 1
            except Exception:
                pass
    todo = []
    for a in accounts:
        if a.get("status") not in ("completed", "enterprise_trial_started"):
            continue
        if a["email"] in done:
            continue
        sp = os.path.join(SESS_DIR, safe_name(a["email"]) + ".json")
        if os.path.exists(sp):
            mark_done(a["email"], True)
            continue
        if fails.get(a["email"], 0) >= max_fail:
            continue  # give up after too many tries — avoid hot-looping
        todo.append(a)
    mine = [a for i, a in enumerate(todo) if i % workers == shard]
    print(f"warm shard {shard}/{workers}: {len(mine)} of {len(todo)} accounts", flush=True)
    headless = os.environ.get("WARM_HEADLESS", "1") == "1"
    browser = await uc.start(
        headless=headless,
        browser_args=["--disable-gpu", "--window-size=1280,900"],
    )
    ok = fail = 0
    try:
        # spread shard starts so logins interleave at ~40-50s spacing
        await asyncio.sleep(shard * int(os.environ.get("WARM_START_DELAY", "15")))
        for i, acc in enumerate(mine):
            email = acc["email"]
            if not try_claim(email):
                continue  # another shard owns this account right now
            try:
                r = await login_one(browser, acc)
                if r.startswith("OK"):
                    ok += 1
                    mark_done(email, True)
                    print(f"[S{shard}] {email}: {r} ({ok}ok/{fail}fail)", flush=True)
                else:
                    fail += 1
                    mark_done(email, False)
                    print(f"[S{shard}] {email}: FAIL {r[:160]}", flush=True)
            except Exception as e:
                fail += 1
                print(f"[S{shard}] {email}: ERR {e}", flush=True)
            finally:
                release_claim(email)
            await asyncio.sleep(3)
    finally:
        try:
            browser.stop()
        except Exception:
            pass
    print(f"DONE warm shard {shard}: {ok} ok, {fail} fail (of {len(mine)})", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
