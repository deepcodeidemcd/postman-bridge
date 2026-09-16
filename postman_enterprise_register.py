import asyncio, sys, json, random, string, time, os, re, requests
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
import nodriver as uc

OUT = os.environ.get("PM_OUT_FILE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "postman_accounts.jsonl"))
CHECK_DIR = r"D:\hoat_hinh\Grokpool\check"

def rnd_pw():
    return "Pm" + "".join(random.choices(string.ascii_letters + string.digits, k=12)) + "!"

def rnd_username():
    return "pm" + "".join(random.choices(string.ascii_lowercase + string.digits, k=10))

async def debug_page(tab, idx, label):
    # FAST mode (batch): skip screenshots entirely to save ~1-2s each.
    if os.environ.get("PM_FAST", "") == "1":
        return
    try:
        p = os.path.join(CHECK_DIR, f"{idx}_{label}.png")
        await tab.save_screenshot(p)
        print(f"   screenshot: {p}")
    except Exception as e:
        print(f"   debug err: {e}")

async def js(tab, script):
    try:
        result = await tab.evaluate(script)
        if result is None:
            return ""
        return str(result)
    except Exception as e:
        return ""

async def wait_for_inputs(tab, max_wait=45):
    """Wait until DOM form inputs appear (not just hidden turnstile)"""
    for i in range(max_wait // 2):
        await asyncio.sleep(2)
        # Check for actual form fields, not just hidden inputs
        has_form = await js(tab, """
            (() => {
                const formInputs = document.querySelectorAll('input:not([type="hidden"])');
                return formInputs.length;
            })()
        """)
        c = int(has_form) if str(has_form).isdigit() else 0
        if c >= 2:  # At least email + password fields
            print(f"   DOM ready ({(i+1)*2}s, {c} visible inputs)")
            return True
        if i % 5 == 0:
            print(f"   waiting for DOM... ({(i+1)*2}s, {c} inputs)")
    return False

async def wait_cf(tab, max_wait=60):
    """Wait for Cloudflare challenge to complete"""
    print("   waiting for Cloudflare...")
    for i in range(max_wait // 3):
        await asyncio.sleep(3)
        body = await js(tab, "document.body.innerText") or ""
        url = await js(tab, "window.location.href") or ""
        cf_active = ("Performing security verification" in body or 
                     "Verify you are human" in body or
                     "Just a moment" in body or
                     "challenges.cloudflare" in url)
        if not cf_active:
            print(f"   CF passed ({(i+1)*3}s)")
            return True
        if i % 3 == 0:
            print(f"   CF waiting... ({(i+1)*3}s)")
    print("   CF timeout")
    return False

async def wait_turnstile_success(tab, max_wait=30):
    """Wait for Turnstile to complete - checks both body text and hidden input"""
    clicked = False
    for i in range(max_wait // 2):
        await asyncio.sleep(2)
        # Method 1: Check hidden input value (most reliable)
        check = await js(tab, """
            (() => {
                const resp = document.querySelector("input[name='cf-turnstile-response']");
                if (resp && resp.value && resp.value.length > 10) return 'token_ready';
                if (document.body.innerText.includes('Success!')) return 'text_success';
                const widgets = document.querySelectorAll('[id*="turnstile"], [class*="turnstile"], .cf-turnstile');
                for (const w of widgets) {
                    if (w.innerText && w.innerText.includes('Success')) return 'widget_success';
                }
                return 'pending';
            })()
        """) or "pending"
        
        if check != "pending":
            print(f"   Turnstile done: {check} ({(i+1)*2}s)")
            return True
        
        body = await js(tab, "document.body.innerText") or ""
        
        if "Unable to verify" in body:
            if not clicked:
                print(f"   Turnstile failed, clicking checkbox to retry...")
                # Click Turnstile checkbox area to trigger retry
                await js(tab, """
                    (() => {
                        const iframes = document.querySelectorAll('iframe[src*="challenges.cloudflare"]');
                        for (const iframe of iframes) {
                            const rect = iframe.getBoundingClientRect();
                            if (rect.width > 0) {
                                // Dispatch click on iframe area
                                const evt = new MouseEvent('click', {clientX: rect.left + 25, clientY: rect.top + 25, bubbles: true});
                                iframe.dispatchEvent(evt);
                                return 'clicked_at:' + Math.round(rect.left) + ',' + Math.round(rect.top);
                            }
                        }
                        return 'no_iframe';
                    })()
                """)
                clicked = True
                await asyncio.sleep(3)
                continue
            else:
                print(f"   Turnstile FAILED (Unable to verify, already retried)")
                return False
        
        if i % 3 == 0:
            print(f"   waiting for Turnstile... ({(i+1)*2}s)")
    print("   Turnstile timeout")
    return False

async def fill_field(tab, selector, value):
    """Fill an input field by selector"""
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

class MailTmClient:
    BASE = "https://api.mail.tm"
    
    def __init__(self):
        self.token = None
        self.email = None
        self.password = None
    
    def get_domain(self):
        try:
            r = requests.get(f"{self.BASE}/domains", timeout=15)
            if r.status_code == 200:
                data = r.json()
                # API returns either {"hydra:member": [...]} or a plain list.
                members = data.get("hydra:member", data) if isinstance(data, dict) else data
                if isinstance(members, list):
                    for m in members:
                        if isinstance(m, dict) and m.get("isActive", True) and m.get("domain"):
                            return m["domain"]
                    if members and isinstance(members[0], dict) and members[0].get("domain"):
                        return members[0]["domain"]
        except Exception as e:
            print(f"   domain fetch error: {e}")
        return None
    
    def create_account(self, max_retries=5):
        import time as _time
        for attempt in range(max_retries):
            try:
                domain = self.get_domain()
                if not domain:
                    print(f"   email retry {attempt+1}/{max_retries}: no domain, waiting...")
                    _time.sleep(10 + attempt * 10)
                    continue
                username = "pm" + "".join(random.choices(string.ascii_lowercase + string.digits, k=10))
                self.password = "Pm" + "".join(random.choices(string.ascii_letters + string.digits, k=12)) + "!"
                self.email = f"{username}@{domain}"
                r = requests.post(f"{self.BASE}/accounts", json={
                    "address": self.email,
                    "password": self.password
                }, timeout=20)
                if r.status_code == 201:
                    self._login()
                    return True
                print(f"   email retry {attempt+1}/{max_retries}: HTTP {r.status_code}, waiting...")
            except Exception as e:
                print(f"   email retry {attempt+1}/{max_retries}: {str(e)[:60]}, waiting...")
            _time.sleep(10 + attempt * 10)
        return False
    
    def _login(self):
        r = requests.post(f"{self.BASE}/token", json={
            "address": self.email,
            "password": self.password
        })
        if r.status_code == 200:
            self.token = r.json().get("token")
        return self.token is not None
    
    def get_messages(self):
        if not self.token:
            return []
        try:
            r = requests.get(f"{self.BASE}/messages", headers={"Authorization": f"Bearer {self.token}"}, timeout=15)
            if r.status_code == 200:
                data = r.json()
                if isinstance(data, dict):
                    return data.get("hydra:member", [])
                return data if isinstance(data, list) else []
        except Exception:
            pass
        return []
    
    def get_message(self, msg_id):
        if not self.token:
            return None
        r = requests.get(f"{self.BASE}/messages/{msg_id}", headers={"Authorization": f"Bearer {self.token}"})
        if r.status_code == 200:
            return r.json()
        return None
    
    def wait_for_code(self, max_wait=120):
        print(f"[*] Waiting for verification email at {self.email}...")
        for i in range(max_wait // 5):
            time.sleep(5)
            msgs = self.get_messages()
            for msg in msgs:
                subject = msg.get("subject", "")
                print(f"   email subject: {subject[:50]}")
                full = self.get_message(msg["id"])
                if full:
                    body = full.get("text", "") or str(full.get("html", ""))
                    codes = re.findall(r'\b(\d{6})\b', body)
                    if codes:
                        print(f"   found code: {codes[0]}")
                        return codes[0]
            if i % 6 == 0:
                print(f"   waiting... ({i*5}s)")
        return None

async def retry_click_js(tab, js_code, max_tries=20, delay=3, label="button"):
    """Atomically find + click in one JS call, retry until success"""
    for i in range(max_tries):
        result = await js(tab, js_code)
        if result and "clicked" in str(result):
            print(f"   {label} clicked ({(i+1)*delay}s): {result}")
            return True
        if i % 5 == 0:
            print(f"   waiting for {label}... ({(i+1)*delay}s)")
        await asyncio.sleep(delay)
    # Single-line diagnosis: run_worker extracts 80 chars after "FAILED:"
    # so keep URL + button sample on the SAME line.
    try:
        diag = await js(tab, """
            (() => {
                const btns = Array.from(document.querySelectorAll('button, a')).filter(b => b.offsetParent !== null).map(b => (b.textContent || '').trim().slice(0, 18)).filter(t => t.length > 0).slice(0, 8).join('/');
                return document.title.slice(0,25) + '|' + window.location.href.slice(8,75) + '|btns:' + btns + '|body:' + (document.body.innerText || '').slice(0,60).replace(/\\n/g,' ');
            })()
        """) or "diag-unavailable"
    except Exception:
        diag = "diag-exception"
    print(f"   FAILED: {label} never clickable [{str(diag)[:220]}]")
    return False

async def check_cf_active(tab):
    """Check if Cloudflare challenge is currently active"""
    body = await js(tab, "document.body.innerText") or ""
    url = await js(tab, "window.location.href") or ""
    return ("Performing security verification" in body or 
            "Verify you are human" in body or
            "Just a moment" in body or
            "challenges.cloudflare" in url)

async def register_one(browser, idx):
    password = rnd_pw()
    username = rnd_username()
    print(f"\n{'='*50}")
    print(f"ACCOUNT {idx}")
    print(f"{'='*50}")
    
    # Use VipTempMail (browser-based) if env var set, else Mail.tm API
    mail_provider = os.environ.get("PM_MAIL_PROVIDER", "mailtm").strip().lower()
    
    if mail_provider == "viptemp":
        # Open viptempmail in a SEPARATE tab (new_tab=True keeps signup tab untouched)
        mail_tab = await browser.get("https://viptempmail.com", new_tab=True)
        # Wait for email to appear
        email = None
        for i in range(30):
            await asyncio.sleep(1)
            email = await js(mail_tab, """
                (() => {
                    const el = document.querySelector('#email_id');
                    if (el && el.textContent.includes('@')) return el.textContent.trim();
                    const m = document.documentElement.outerHTML.match(/const\\s+email\\s*=\\s*'([^']+@viptempmail\\.com)'/);
                    if (m) return m[1];
                    return '';
                })()
            """)
            if email and "@" in email:
                break
        if not email or "@" not in email:
            print("   FAILED: no email from viptempmail.com")
            return None
        print(f"   [VIPMAIL] email: {email}")
    else:
        mail = MailTmClient()
        if not mail.create_account():
            print("   FAILED: no temp email available")
            return None
        email = mail.email
    
    print(f"   email: {email}")
    print(f"   username: {username}")
    print(f"   password: {password}")
    
    # ===== STEP 1: SIGNUP =====
    print(f"\n--- Step 1: Signup ---")
    tab = await browser.get("https://identity.getpostman.com/signup", new_tab=True)
    
    # Wait for CF + DOM render
    cf_was_active = await check_cf_active(tab)
    if cf_was_active:
        print("   CF detected at signup")
        if not await wait_cf(tab):
            print("   CF FAILED at signup")
            return None
        await asyncio.sleep(2)
    
    if not await wait_for_inputs(tab):
        # Debug: capture what's on the page
        url = await js(tab, "window.location.href") or ""
        body = await js(tab, "document.body.innerText") or ""
        body_len = await js(tab, "document.body.innerHTML.length") or "0"
        print(f"   DEBUG: form never loaded")
        print(f"   DEBUG URL: {url[:120]}")
        print(f"   DEBUG body len: {body_len}, text: {body[:150]}")
        await debug_page(tab, idx, "01_form_never_loaded")
        
        # Retry once with reload
        print("   retrying with reload...")
        try:
            await tab.reload()
            await asyncio.sleep(5)
            if await check_cf_active(tab):
                await wait_cf(tab)
            if not await wait_for_inputs(tab, max_wait=30):
                print("   FAILED: signup form never loaded after retry")
                await debug_page(tab, idx, "01_form_never_loaded_2")
                return None
        except Exception as e:
            print(f"   reload failed: {e}")
            return None
    
    url = await js(tab, "window.location.href") or ""
    print(f"   URL: {url[:80]}")
    
    await debug_page(tab, idx, "01_signup_page")
    
    # Fill email
    r = await fill_field(tab, "#email", email)
    print(f"   email: {r}")
    
    # Fill username
    r = await fill_field(tab, "#username", username)
    print(f"   username: {r}")
    
    # Fill password
    r = await fill_field(tab, "#password", password)
    print(f"   password: {r}")
    
    # Verify all fields filled
    check = await js(tab, """
        (() => {
            const e = document.querySelector('#email');
            const u = document.querySelector('#username');
            const p = document.querySelector('#password');
            return JSON.stringify({
                email: e ? e.value : 'none',
                username: u ? u.value : 'none',
                password: p ? (p.value.length > 0 ? 'ok:' + p.value.length : 'empty') : 'none'
            });
        })()
    """)
    print(f"   verify: {check}")
    
    if '"email":"none"' in check or '"username":"none"' in check:
        print("   FAILED: form fields not found")
        return None
    
    # Wait for Turnstile on signup page (CRITICAL)
    print("   waiting for signup Turnstile...")
    turnstile_ok = await wait_turnstile_success(tab, max_wait=45)
    if not turnstile_ok:
        print("   Turnstile failed, retrying with page reload...")
        try:
            await tab.reload()
            if await check_cf_active(tab):
                await wait_cf(tab)
            if not await wait_for_inputs(tab):
                print("   FAILED: signup form never loaded after reload")
                return None
            await fill_field(tab, "#email", email)
            await fill_field(tab, "#username", username)
            await fill_field(tab, "#password", password)
            turnstile_ok = await wait_turnstile_success(tab, max_wait=45)
        except Exception as e:
            print(f"   reload failed: {e}")
            return None
    
    if not turnstile_ok:
        print("   FAILED: Turnstile never completed on signup")
        await debug_page(tab, idx, "01_turnstile_fail")
        return None
    
    # Click "Create Free Account"
    await js(tab, """
        (() => {
            const btn = document.querySelector('button[type="submit"]');
            if (btn) { btn.click(); return 'clicked'; }
            return 'not_found';
        })()
    """)
    print("   clicked Create Free Account")
    
    # Wait for navigation
    for i in range(30):
        await asyncio.sleep(2)
        url = await js(tab, "window.location.href") or ""
        body = await js(tab, "document.body.innerText") or ""
        
        # Check for CAPTCHA error
        if "Unable to verify" in body:
            print(f"   CAPTCHA error, retrying...")
            await asyncio.sleep(10)
            await js(tab, """
                (() => {
                    const btn = document.querySelector('button[type="submit"]');
                    if (btn) { btn.click(); return 'clicked'; }
                    return 'not_found';
                })()
            """)
            print("   retried submit")
            await asyncio.sleep(8)
            continue
        
        # Successfully navigated away from signup
        if "signup" not in url.lower():
            print(f"   navigated ({(i+1)*2}s): {url[:80]}")
            break
        
        # Check for specific error banner (not just body text)
        has_error = await js(tab, """
            (() => {
                const errorEls = document.querySelectorAll('.banner-critical, .pm-error, [role="alert"], .error-message, .notification-failure');
                for (const el of errorEls) {
                    if (el.offsetParent !== null && el.textContent.trim().length > 0) {
                        return el.textContent.trim().substring(0, 200);
                    }
                }
                return '';
            })()
        """) or ""
        if has_error:
            print(f"   ERROR: {has_error}")
            await debug_page(tab, idx, "02_signup_error")
            return None
        
        if i % 5 == 0:
            print(f"   waiting... ({(i+1)*2}s)")
    
    await debug_page(tab, idx, "02_after_signup")
    
    url = await js(tab, "window.location.href") or ""
    body = await js(tab, "document.body.innerText") or ""
    print(f"   after signup URL: {url[:100]}")
    print(f"   after signup body: {body[:200]}")
    
    # ===== STEP 2: EMAIL VERIFICATION =====
    if "verify" in url.lower() or "verify" in body.lower():
        print(f"\n--- Step 2: Email Verification ---")
        
        # Verify page has a single code input - wait for it specifically (fast check)
        code_input_ready = False
        for i in range(10):
            found = await js(tab, "document.querySelector('#verification-code') || document.querySelector('input[name=\"verification-code\"]') ? 'yes' : 'no'")
            if found == "yes":
                code_input_ready = True
                print(f"   code input ready ({(i+1)}s)")
                break
            await asyncio.sleep(1)
        
        await debug_page(tab, idx, "03_verify_page")
        
        # Wait for verification code (async for VipTemp, sync for Mail.tm)
        if mail_provider == "viptemp":
            # Poll viptempmail tab (separate tab, already open) for verification code
            code = None
            print(f"   [VIPMAIL] waiting for code at {email}...")
            for wi in range(24):
                await js(mail_tab, """
                    (() => {
                        const refresh = document.getElementById('refresh');
                        if (refresh) refresh.click();
                        if (window.Livewire) window.Livewire.emit('fetchMessages');
                    })()
                """)
                await asyncio.sleep(2)
                mbody = await js(mail_tab, "document.body.innerText") or ""
                if wi <= 2:
                    inbox_dump = mbody.replace("\n", " ")[:300]
                    print(f"   [VIPMAIL] inbox dump: {inbox_dump}")
                m2 = re.search(r'(\d{6})\s*(?:is your|verification|code)', mbody, re.I)
                if m2:
                    code = m2.group(1)
                    print(f"   [VIPMAIL] found code: {code} ({(wi+1)*7}s)")
                    break
                if wi % 3 == 0:
                    print(f"   [VIPMAIL] waiting... ({(wi+1)*7}s)")
                await asyncio.sleep(5)
        else:
            code = await asyncio.get_event_loop().run_in_executor(None, lambda: mail.wait_for_code(max_wait=120))
        if not code:
            print("   FAILED: no verification code received")
            return None
        
        # Find and fill verification code input
        filled = await js(tab, f"""
            (() => {{
                // Try single input first
                const inputs = document.querySelectorAll('input');
                for (const inp of inputs) {{
                    const ph = (inp.placeholder || '').toLowerCase();
                    const name = (inp.name || '').toLowerCase();
                    const id = (inp.id || '').toLowerCase();
                    if (ph.includes('digit') || ph.includes('code') || ph.includes('verif') || 
                        name.includes('code') || name.includes('otp') || id.includes('code') || id.includes('otp')) {{
                        inp.focus();
                        inp.value = '{code}';
                        inp.dispatchEvent(new Event('input', {{bubbles: true}}));
                        inp.dispatchEvent(new Event('change', {{bubbles: true}}));
                        return 'single:' + inp.id;
                    }}
                }}
                // Try individual digit inputs (6-digit code)
                const digitInputs = document.querySelectorAll('input[maxlength="1"]');
                if (digitInputs.length >= 6) {{
                    const digits = '{code}'.split('');
                    for (let i = 0; i < 6 && i < digitInputs.length; i++) {{
                        digitInputs[i].focus();
                        digitInputs[i].value = digits[i];
                        digitInputs[i].dispatchEvent(new Event('input', {{bubbles: true}}));
                        digitInputs[i].dispatchEvent(new Event('change', {{bubbles: true}}));
                    }}
                    return 'multi:' + digitInputs.length;
                }}
                return 'not_found';
            }})()
        """)
        print(f"   code fill: {filled}")
        
        if filled == "not_found":
            # Maybe there's a different UI - dump inputs
            inputs_info = await js(tab, """
                (() => {
                    const inputs = document.querySelectorAll('input');
                    return Array.from(inputs).map(i => i.id + ':' + i.type + ':' + i.name).join(', ');
                })()
            """)
            print(f"   available inputs: {inputs_info}")
            await debug_page(tab, idx, "03_verify_error")
            return None
        
        await asyncio.sleep(1)
        
        # Click verify/continue button
        await js(tab, """
            (() => {
                const btns = document.querySelectorAll('button');
                for (const btn of btns) {
                    const text = btn.textContent.toLowerCase().trim();
                    if (text.includes('verify') || text.includes('confirm') || text.includes('continue') || btn.type === 'submit') {
                        btn.click();
                        return 'clicked:' + text;
                    }
                }
                return 'not_found';
            })()
        """)
        print("   clicked verify button")
        
        # Wait for verification to complete. Postman now puts a captcha
        # wall on this submit under bot suspicion ("Unable to verify the
        # captcha") — detect it, clear the challenge, re-submit (up to 3x).
        verified_ok = False
        for vtry in range(3):
            captcha_wall = False
            for i in range(20):
                await asyncio.sleep(2)
                url = await js(tab, "window.location.href") or ""
                body = await js(tab, "document.body.innerText") or ""
                low_body = body.lower()
                if "unable to verify the captcha" in low_body:
                    print(f"   verify captcha wall (try {vtry+1}), clearing challenge...")
                    captcha_wall = True
                    break
                if "verify" not in url.lower() and "verify" not in low_body:
                    print(f"   verified ({(i+1)*2}s): {url[:80]}")
                    verified_ok = True
                    break
                if "error" in low_body or "invalid" in low_body:
                    print(f"   verification error")
                    await debug_page(tab, idx, "04_verify_error")
                    return None
                if i % 5 == 0:
                    print(f"   waiting... ({(i+1)*2}s)")
            if verified_ok:
                break
            if captcha_wall:
                if await check_cf_active(tab):
                    await wait_cf(tab)
                    await asyncio.sleep(3)
                # re-submit the verify form (code may still be filled)
                await js(tab, """
                    (() => {
                        const btns = document.querySelectorAll('button');
                        for (const btn of btns) {
                            const text = (btn.textContent || '').toLowerCase().trim();
                            if ((text.includes('verify') || text.includes('confirm') || text.includes('continue') || btn.type === 'submit') && btn.offsetParent !== null) {
                                btn.click();
                                return 'reclicked:' + text;
                            }
                        }
                        return 'not_found';
                    })()
                """)
                print(f"   re-submitted verify (try {vtry+2})")
                continue
            break
        if not verified_ok:
            # Still on verify page: do NOT proceed (wizard matchers would
            # false-positive on the code input + Verify buttons).
            print(f"   FAILED: stuck on verify page, failing fast")
            await debug_page(tab, idx, "04_verify_stuck")
            return None
        
        await debug_page(tab, idx, "04_after_verify")
    else:
        print("   no verification page detected")
    
    # ===== STEP 3: COMPLETE ONBOARDING =====
    # After verify, we are on the onboarding wizard. Complete it first.
    print(f"\n--- Step 3: Complete onboarding ---")

    current_url = await js(tab, "window.location.href") or ""
    body = await js(tab, "document.body.innerText") or ""
    print(f"   current URL: {current_url[:80]}")
    print(f"   body: {body[:150]}")

    # Wait for wizard SPA to render (it renders slowly)
    wizard_ready = False
    for i in range(30):
        await asyncio.sleep(2)
        info_raw = await js(tab, """
            (() => {
                const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"])')).filter(i => i.offsetParent !== null);
                const radios = Array.from(document.querySelectorAll('input[type="radio"]')).filter(r => r.offsetParent !== null);
                const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null && (b.textContent || '').trim().length > 0);
                const selects = Array.from(document.querySelectorAll('select')).filter(s => s.offsetParent !== null);
                return JSON.stringify({
                    inputs: inputs.length,
                    radios: radios.length,
                    selects: selects.length,
                    btnTexts: btns.map(b => (b.textContent || '').trim().substring(0, 40)).join(' | '),
                    title: document.title,
                    url: window.location.href.slice(0, 90),
                    // Wizard-specific markers: verify/signup pages also have
                    // inputs+buttons and must NOT count as "wizard rendered".
                    wizmark: (document.querySelector('[class*="dropdown__control"]') !== null)
                        || (document.body.innerText || '').includes('Welcome to Postman')
                        || (document.body.innerText || '').includes('What is your name?')
                });
            })()
        """) or "{}"
        try:
            info = json.loads(info_raw)
        except Exception:
            info = {}
        # Session bounce guard: after verify the tab may land on a Sign-in/
        # login page (session not yet propagated). Filling blindly there
        # wastes the whole wizard cycle — surface it immediately.
        low_url = (info.get("url") or "").lower()
        if "sign-in" in low_url or "/login" in low_url:
            print(f"   wizard wait: bounced to login page ({info.get('url','')[:80]}), session not propagated yet")
        if "verify" in low_url or "signup" in low_url or "identity.getpostman" in low_url:
            # Still on identity pages (verify wall?): never treat as wizard.
            if i % 5 == 0:
                print(f"   waiting for wizard... ({(i+1)*2}s) still on identity page")
        elif info.get("wizmark"):
            print(f"   wizard rendered ({(i+1)*2}s): {info_raw[:200]}")
            wizard_ready = True
            break
        elif info.get("inputs", 0) > 0 or info.get("selects", 0) > 0 or (info.get("btnTexts") or "").strip():
            # Elements but no wizard markers (wrong page variant?) — wait on.
            if i % 5 == 0:
                print(f"   waiting for wizard... ({(i+1)*2}s) elements without wizard markers title={info.get('title','?')}")
        if i % 5 == 0:
            print(f"   waiting for wizard... ({(i+1)*2}s) title={info.get('title','?')} url={(info.get('url','?'))[:70]}")

    # If wizard never rendered it is usually a CF challenge covering the
    # page or a slow SPA boot: clear challenge, reload once, then fill.
    # (Filling blindly guarantees a stuck wizard + a doomed upgrade hunt.)
    if not wizard_ready:
        print("   wizard not rendered, clearing challenge + reloading...")
        if await check_cf_active(tab):
            await wait_cf(tab)
        try:
            await tab.reload()
        except Exception:
            pass
        await asyncio.sleep(10)
        if await check_cf_active(tab):
            await wait_cf(tab)

    # Single-page wizard: fill all fields, click team size, click workspace button
    await debug_page(tab, idx, "07_onboarding_wizard")

    # Helper: TRUSTED CDP click at element center (nodriver Input.dispatchMouseEvent).
    # React-select and React inputs ignore synthetic (untrusted) JS events.
    async def trusted_click(selector_js: str, label: str) -> str:
        """selector_js is JS returning 'x,y' coords — OR an already-resolved
        'x,y' coords string (used directly, NOT re-evaluated: evaluating
        '634,323' as JS yields 323, silently breaking every click)."""
        coords_raw = ""
        if selector_js and re.match(r"^\s*\d+(\.\d+)?\s*,\s*\d+(\.\d+)?", selector_js):
            coords_raw = selector_js
        else:
            for _attempt in range(3):
                coords_raw = await js(tab, selector_js)
                if coords_raw and "," in coords_raw and not coords_raw.startswith(("JSERR", "ExceptionDetails")):
                    break
                await asyncio.sleep(2)
        if not coords_raw or "," not in coords_raw or coords_raw.startswith(("JSERR", "ExceptionDetails")):
            print(f"   trusted_click {label}: no coords ({str(coords_raw)[:100]})")
            return "no_coords"
        try:
            xs, ys = coords_raw.split(",", 1)
            x, y = int(float(xs)), int(float(ys))
        except Exception:
            print(f"   trusted_click {label}: bad coords ({coords_raw[:60]})")
            return "no_coords"
        await tab.mouse_click(x, y)
        print(f"   trusted_click {label}: ({x},{y})")
        await asyncio.sleep(0.4)
        return "clicked"

    # 1) Fill name via trusted keyboard: click input, type through CDP
    name_coords = await js(tab, """
        (() => {
            try {
                const inps = document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"])');
                let inp = null;
                for (const i2 of inps) { if (i2.offsetParent !== null) { inp = i2; break; } }
                if (!inp) return 'null';
                const r = inp.getBoundingClientRect();
                return Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2);
            } catch (e) { return 'JSERR: ' + e.message; }
        })()
    """)
    await trusted_click(name_coords, "name input")
    # Type the name with real key events (nodriver send -> Input.dispatchKeyEvent)
    for ch in "Auto User":
        await tab.send(uc.cdp.input_.dispatch_key_event(type_="keyDown", text=ch, key=ch, unmodified_text=ch))
        await tab.send(uc.cdp.input_.dispatch_key_event(type_="keyUp", key=ch))
    await asyncio.sleep(0.5)
    name_val = await js(tab, """
        (() => {
            const inp = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"])')).find(i => i.offsetParent !== null);
            return inp ? inp.value : 'no input';
        })()
    """)
    print(f"   name value now: {name_val}")
    # Fallback: CDP key events sometimes land nowhere (focus race). JS
    # native-setter bypasses focus entirely and is React-compatible.
    if (name_val or "") != "Auto User":
        print("   name empty after typing, JS fallback fill...")
        await js(tab, """
            (() => {
                try {
                    const inps = document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"])');
                    for (const i2 of inps) {
                        if (i2.offsetParent === null) continue;
                        if (i2.id.indexOf('react-select') === 0) continue;
                        const r = i2.getBoundingClientRect();
                        if (r.width < 50) continue;
                        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                        setter.call(i2, 'Auto User');
                        i2.dispatchEvent(new Event('input', {bubbles: true}));
                        i2.dispatchEvent(new Event('change', {bubbles: true}));
                        return 'filled';
                    }
                    return 'no_input';
                } catch (e) { return 'JSERR: ' + e.message; }
            })()
        """)
        await asyncio.sleep(0.5)
        name_val2 = await js(tab, """
            (() => {
                const inp = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"])')).find(i => i.offsetParent !== null && i.id.indexOf('react-select') !== 0);
                return inp ? inp.value : 'no input';
            })()
        """)
        print(f"   name value after fallback: {name_val2}")

    # 2) Open each aether-dropdown with a trusted click, pick option with trusted click.
    # Retry-until-clean (up to 4 rounds): a still-open menu from the previous
    # round can cover the next control, making its click a toggle-shut no-op.
    for d in range(4):
        # ensure no stale menu is open before querying placeholders
        await js(tab, """
            (() => {
                document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
                return 'esc';
            })()
        """)
        await asyncio.sleep(0.5)
        dd_state = await js(tab, """
            (() => {
                const phs = document.querySelectorAll('[class*="dropdown__placeholder"]');
                const left = [];
                for (const el of phs) {
                    if (!el.offsetParent) continue;
                    const t = (el.textContent || '').trim().toLowerCase();
                    if (t === 'select option' || t === 'select role') left.push(t);
                }
                return left.join(',');
            })()
        """)
        if not (dd_state or "").strip():
            print(f"   dropdowns complete (round {d+1})")
            break
        dd_coords = await js(tab, """
            (() => {
                try {
                    const phs = document.querySelectorAll('[class*="aether-dropdown__placeholder"]');
                    for (const el of phs) {
                        if (!el.offsetParent) continue;
                        const own = (el.textContent || '').trim().toLowerCase();
                        if (own === 'select option' || own === 'select role') {
                            const control = el.closest('[class*="aether-dropdown__control"]') || el;
                            const r = control.getBoundingClientRect();
                            return Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2);
                        }
                    }
                    return 'null';
                } catch (e) { return 'JSERR: ' + e.message; }
            })()
        """)
        res = await trusted_click(dd_coords, f"dropdown {d+1}")
        if res != "clicked":
            print(f"   dropdown click missed (round {d+1}), retrying...")
            await asyncio.sleep(1)
            continue
        await asyncio.sleep(2)

        # Menu options render after open; find visible option and trusted-click it
        opt_coords = await js(tab, """
            (() => {
                try {
                    const opts = document.querySelectorAll('[class*="aether-dropdown__option"]');
                    for (const o of opts) {
                        const r = o.getBoundingClientRect();
                        if (r.width > 0 && r.height > 0 && r.y >= 0 && r.y < window.innerHeight) {
                            return Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2);
                        }
                    }
                    return 'null';
                } catch (e) { return 'JSERR: ' + e.message; }
            })()
        """)
        res2 = await trusted_click(opt_coords, f"option {d+1}")
        if res2 != "clicked":
            menu_dump = await js(tab, """
                (() => {
                    try {
                        const menus = document.querySelectorAll('[class*="aether-dropdown__menu"], [role="listbox"]');
                        const out = [];
                        for (const m of menus) {
                            out.push((m.className || '').toString().slice(0, 40) + ' vis=' + (m.offsetParent !== null) + ' kids=' + m.children.length + ' txt=' + (m.textContent || '').trim().slice(0, 60));
                        }
                        return out.join(' || ') || 'no menus';
                    } catch (e) { return 'JSERR: ' + e.message; }
                })()
            """)
            print(f"   menu dump: {menu_dump[:250]}")
        # Ensure the menu closed after picking (an open menu covers the next
        # control and turns its click into a toggle-shut no-op).
        await js(tab, """
            (() => {
                document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
                return 'esc';
            })()
        """)
        await asyncio.sleep(1)

    # Click radio if present
    await js(tab, """
        (() => {
            const radios = Array.from(document.querySelectorAll('input[type="radio"]')).filter(r => r.offsetParent !== null);
            if (radios.length > 0) {
                radios[0].click();
                radios[0].dispatchEvent(new Event('change', {bubbles: true}));
                return 'selected';
            }
            return 'not_found';
        })()
    """)
    await asyncio.sleep(1)

    # Team size + workspace submit: trusted clicks by text match
    for label_pat, lbl in [("member", "team size"), ("take me", "workspace btn"), ("launch", "workspace btn (launch)")]:
        btn_coords = await js(tab, f"""
            (() => {{
                try {{
                    const btns = document.querySelectorAll('button');
                    for (const btn of btns) {{
                        if (btn.offsetParent === null) continue;
                        const t = (btn.textContent || '').trim().toLowerCase();
                        if (t.includes('{label_pat}')) {{
                            const r = btn.getBoundingClientRect();
                            return Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2) + ',' + t.slice(0, 30);
                        }}
                    }}
                    return 'null';
                }} catch (e) {{ return 'JSERR: ' + e.message; }}
            }})()
        """)
        if btn_coords and "," in btn_coords and not btn_coords.startswith(("JSERR", "ExceptionDetails", "null")):
            parts = btn_coords.split(",", 2)
            try:
                x, y = int(float(parts[0])), int(float(parts[1]))
                await tab.mouse_click(x, y)
                print(f"   trusted_click {lbl}: {parts[2] if len(parts) > 2 else ''} ({x},{y})")
                await asyncio.sleep(1.5)
            except Exception as e:
                print(f"   trusted_click {lbl}: bad coords {btn_coords[:50]}")
    await asyncio.sleep(5)
    # VERIFY onboarding actually completed (left /onboarding/). The workspace
    # button click is a no-op when required fields are empty (form validation),
    # and proceeding anyway guarantees upgrade failure later.
    onboarded = False
    url_now = ""
    for _ in range(6):
        url_now = await js(tab, "window.location.href") or ""
        low_now = url_now.lower()
        # Onboarded = on the TEAM domain workspace, not merely "not on
        # /onboarding/" (a stuck verify page also lacks that substring).
        if "/onboarding" not in low_now and re.search(r"https://[a-z0-9-]+\.postman\.co", url_now) and "verify" not in low_now and "signup" not in low_now:
            onboarded = True
            break
        await asyncio.sleep(5)
    if not onboarded:
        # Second-chance submit: fields may be filled but the Take-me click
        # missed (popup/overlay timing). Re-query + re-click once (~15s).
        # If fields are empty this is futile but harmless.
        print("   onboarding still on wizard, second-chance submit...")
        retry_clicked = await js(tab, """
            (() => {
                try {
                    const btns = document.querySelectorAll('button');
                    for (const btn of btns) {
                        if (btn.offsetParent === null) continue;
                        const t = (btn.textContent || '').trim().toLowerCase();
                        if (t.includes('take me') || t.includes('launch')) {
                            const r = btn.getBoundingClientRect();
                            return Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2);
                        }
                    }
                    return 'null';
                } catch (e) { return 'JSERR: ' + e.message; }
            })()
        """)
        if retry_clicked and "," in str(retry_clicked) and not str(retry_clicked).startswith(("JSERR", "ExceptionDetails", "null")):
            try:
                xs, ys = str(retry_clicked).split(",", 1)
                await tab.mouse_click(int(float(xs)), int(float(ys)))
                print(f"   second-chance workspace click ({xs},{ys})")
                await asyncio.sleep(8)
                url_now = await js(tab, "window.location.href") or ""
                low_now = url_now.lower()
                if "/onboarding" not in low_now and re.search(r"https://[a-z0-9-]+\.postman\.co", url_now) and "verify" not in low_now:
                    onboarded = True
            except Exception as e:
                print(f"   second-chance click failed: {e}")
    if onboarded:
        print(f"   onboarding verified: left wizard -> {(url_now[:70])}")
    else:
        # Fail fast: a stuck wizard guarantees upgrade failure. Burn no
        # more time on session-check + 20 upgrade retries (~3 min).
        print(f"   FAILED: still on onboarding wizard after submit, failing fast")
        await debug_page(tab, idx, "07_onboarding_stuck")
        return None
    print("   onboarding submitted")

    # ===== STEP 4: UPGRADE TO ENTERPRISE =====
    print(f"\n--- Step 4: Upgrade to Enterprise ---")

    # SESSION VERIFICATION FIRST: session cookies need time to propagate
    # across Postman subdomains after onboarding. STAY on the team
    # subdomain (workspace page already has an Upgrade button — proven via
    # CDP salvage). Navigating to www.postman.com drops the fresh session
    # (marketing homepage, no Upgrade button) — the #1 cause of
    # "Upgrade button never clickable". postman.com is last-resort only.
    team_url = None
    workspace_url = None
    try:
        cur = await js(tab, "window.location.href") or ""
        # STRIP query string: ?authFlowId=... is single-use; replaying it
        # on reload bounces to login and can invalidate the fresh session.
        clean = cur.split("?")[0].split("#")[0]
        workspace_url = clean
        m = re.search(r"(https://[a-z0-9-]+\.postman\.co)", cur)
        if m:
            team_url = m.group(1) + "/"
    except Exception:
        pass
    session_ok = False
    for attempt in range(4):
        if attempt == 0 and workspace_url and "/onboarding" not in workspace_url:
            check_url = workspace_url  # reload workspace in place
        elif team_url:
            check_url = team_url
        else:
            check_url = "https://www.postman.com/"
        await js(tab, f"window.location.href = '{check_url}'")
        await asyncio.sleep(8)
        if await check_cf_active(tab):
            await wait_cf(tab)
            await asyncio.sleep(2)
        body = await js(tab, "document.body.innerText") or ""
        url = await js(tab, "window.location.href") or ""
        low_body, low_url = body.lower(), url.lower()
        if "sign-in" in low_url or "/login" in low_url:
            print(f"   session check {attempt+1}: bounced to login, retrying...")
            await asyncio.sleep(10)
            continue
        # Logged in = has workspace/dashboard markers, NOT marketing page.
        is_marketing = ("sign up for free" in low_body and "ai-native api platform" in low_body)
        has_app = any(k in low_body for k in ("workspace", "my collection", "home", "collections", "overview"))
        if has_app and not is_marketing:
            print(f"   session verified (attempt {attempt+1}): logged in")
            session_ok = True
            break
        print(f"   session check {attempt+1}: not ready yet (marketing={is_marketing}), waiting...")
        await asyncio.sleep(12)
    if not session_ok:
        print("   FAILED: session never established after onboarding")
        await debug_page(tab, idx, "08_no_upgrade_btn")
        return None

    # Pin to the WORKSPACE url (stable, has Upgrade). Team root "/" may
    # SPA-redirect (workspace/login/marketing) and break the upgrade hunt.
    if workspace_url and "/onboarding" not in workspace_url:
        await js(tab, f"window.location.href = '{workspace_url}'")
        print(f"   pinned to workspace: {workspace_url[:70]}")
        await asyncio.sleep(8)
    else:
        print("   staying on team page, waiting for app to fully load...")
        await asyncio.sleep(5)
    if await check_cf_active(tab):
        if not await wait_cf(tab):
            print("   CF FAILED at postman.com")
            return None
        await asyncio.sleep(2)

    print("   waiting for dashboard to fully load...")
    # Wait for page to fully load (no spinner). FAST mode: shorter cap —
    # if not loaded in ~24s the session is bad, fail fast instead of burning 60s.
    max_load_iters = 12 if os.environ.get("PM_FAST", "") == "1" else 30
    for i in range(max_load_iters):
        await asyncio.sleep(2)
        body = await js(tab, "document.body.innerText") or ""
        spinner = await js(tab, "document.querySelector('.spinner, [class*=loading], [class*=skeleton]') !== null") or "false"
        url = await js(tab, "window.location.href") or ""
        if "sign-in" in url.lower() or "login" in url.lower():
            print("   FAILED: redirected to login, not authenticated")
            return None
        if spinner == "false" and len(body) > 100:
            print(f"   page loaded ({(i+1)*2}s, body len={len(body)})")
            break
        if i % 5 == 0:
            print(f"   waiting for load... ({(i+1)*2}s, spinner={spinner})")

    # Sanity: must be LOGGED IN (dashboard/home/workspace). The public
    # marketing homepage means the session died after onboarding — hunting
    # for an Upgrade button there wastes a full timeout cycle.
    login_check = await js(tab, """
        (() => {
            const body = (document.body.innerText || '').toLowerCase();
            const url = window.location.href.toLowerCase();
            const marketing = body.includes('sign up for free') && body.includes('ai-native api platform');
            const hasWorkspace = body.includes('workspace') || body.includes('my collection') || body.includes('home');
            return JSON.stringify({ marketing, hasWorkspace, url: url.slice(0, 80) });
        })()
    """)
    try:
        lc = json.loads(login_check) if login_check else {}
        if lc.get("marketing") and not lc.get("hasWorkspace"):
            print(f"   FAILED: on public homepage, session lost (not logged in). url={lc.get('url','')}")
            await debug_page(tab, idx, "08_no_upgrade_btn")
            return None
    except Exception:
        pass

    print("   looking for Upgrade button...")
    # Dismiss overlays FIRST (Spec Hub / Native Git popups can cover or
    # detach the header Upgrade button).
    await js(tab, """
        (() => {
            document.querySelectorAll('[aria-label="Close"], [class*="dismiss"], [class*="close-modal"], [class*="CloseButton"]').forEach(c => { if (c.offsetParent !== null) c.click(); });
            document.querySelectorAll('button').forEach(b => { const t=(b.textContent||'').trim().toLowerCase(); if ((t==='dismiss'||t==='skip'||t==='maybe later'||t==='not now') && b.offsetParent!==null) b.click(); });
            return 'ok';
        })()
    """)
    await asyncio.sleep(1)
    upgrade_clicked = await retry_click_js(tab, """
        (() => {
            const btns = document.querySelectorAll('button, a, [role="button"], [data-testid*="pgrade"], [data-testid*="billing"]');
            for (const btn of btns) {
                const text = ((btn.textContent || '') + ' ' + (btn.getAttribute('aria-label') || '')).trim().toLowerCase();
                if ((text === 'upgrade' || text.includes('upgrade plan') || text.includes('upgrade to') || text.includes('upgrade')) && btn.offsetParent !== null) {
                    const r = btn.getBoundingClientRect();
                    if (r.width < 2 || r.height < 2) continue;
                    btn.click();
                    return 'clicked:' + text.slice(0, 30);
                }
            }
            return 'not_found';
        })()
    """, max_tries=20, delay=3, label="Upgrade button")

    if not upgrade_clicked:
        await debug_page(tab, idx, "08_no_upgrade_btn")
        return None

    await asyncio.sleep(5)
    await debug_page(tab, idx, "09_upgrade_modal")

    await retry_click_js(tab, """
        (() => {
            // First try to click the radio input directly
            const radios = document.querySelectorAll('input[type="radio"]');
            for (const r of radios) {
                const parent = r.parentElement || r.closest('label') || r.closest('div');
                if (parent && (parent.textContent || '').toLowerCase().includes('enterprise')) {
                    r.click();
                    r.dispatchEvent(new Event('change', {bubbles: true}));
                    return 'clicked_radio_via_parent';
                }
            }
            // Fallback: find any element with enterprise text
            const candidates = document.querySelectorAll('label, div, span');
            for (const el of candidates) {
                const text = (el.textContent || '').toLowerCase();
                if (text.includes('enterprise') && el.offsetParent !== null) {
                    const radio = el.querySelector('input[type="radio"]');
                    if (radio) { radio.click(); radio.dispatchEvent(new Event('change', {bubbles: true})); return 'clicked_radio'; }
                    el.click();
                    return 'clicked:' + el.tagName;
                }
            }
            return 'not_found';
        })()
    """, max_tries=10, delay=2, label="Enterprise plan")

    await asyncio.sleep(2)

    # First dismiss any popups (Spec Hub, etc.)
    await js(tab, """
        (() => {
            // Close Spec Hub popup
            const closes = document.querySelectorAll('[aria-label="Close"], button[class*="close"], [class*="dismiss"]');
            for (const c of closes) {
                if (c.offsetParent !== null) { c.click(); }
            }
            // Also try clicking "Dismiss" button
            const btns = document.querySelectorAll('button');
            for (const btn of btns) {
                if ((btn.textContent || '').trim().toLowerCase() === 'dismiss' && btn.offsetParent !== null) {
                    btn.click();
                }
            }
        })()
    """)
    await asyncio.sleep(1)

    # Now select Enterprise radio
    await retry_click_js(tab, """
        (() => {
            // Find Enterprise radio button
            const radios = document.querySelectorAll('input[type="radio"]');
            for (const r of radios) {
                const parent = r.parentElement || r.closest('label') || r.closest('div');
                if (parent && (parent.textContent || '').toLowerCase().includes('enterprise')) {
                    r.click();
                    r.dispatchEvent(new Event('change', {bubbles: true}));
                    return 'clicked_enterprise';
                }
            }
            // Try clicking Enterprise text
            const candidates = document.querySelectorAll('label, div, span, p');
            for (const el of candidates) {
                const text = (el.textContent || '').toLowerCase();
                if (text.includes('enterprise') && el.offsetParent !== null && !text.includes('plan includes')) {
                    el.click();
                    return 'clicked_text:' + el.tagName;
                }
            }
            return 'not_found';
        })()
    """, max_tries=10, delay=2, label="Enterprise plan")

    await asyncio.sleep(2)
    await debug_page(tab, idx, "10_enterprise_selected")

    # Now click "Start Enterprise Trial" (or "Start Solo Trial" as fallback)
    trial_clicked = await retry_click_js(tab, """
        (() => {
            const btns = document.querySelectorAll('button, a');
            // Priority: Start Enterprise Trial first
            for (const btn of btns) {
                const text = (btn.textContent || '').trim().toLowerCase();
                if (text.includes('start enterprise trial')) {
                    btn.click();
                    return 'clicked_trial:' + (btn.textContent || '').trim().substring(0, 40);
                }
            }
            // Fallback: Start Solo Trial
            for (const btn of btns) {
                const text = (btn.textContent || '').trim().toLowerCase();
                if (text.includes('start solo trial') || text.includes('start trial')) {
                    btn.click();
                    return 'clicked_trial:' + (btn.textContent || '').trim().substring(0, 40);
                }
            }
            return 'not_found';
        })()
    """, max_tries=15, delay=2, label="Start Trial")

    if not trial_clicked:
        print("   no trial button found - dumping modal buttons...")
        modal_info = await js(tab, """
            (() => {
                const btns = Array.from(document.querySelectorAll('button, a')).filter(b => b.offsetParent !== null);
                return btns.map(b => (b.textContent || '').trim().substring(0, 50)).filter(t => t.length > 0).join(' | ');
            })()
        """) or ""
        print(f"   visible buttons: {modal_info[:400]}")
        await debug_page(tab, idx, "10_no_trial_button")

    for i in range(15):
        await asyncio.sleep(2)
        body_len = await js(tab, "document.body.innerText.length") or "0"
        try:
            if int(body_len) > 200:
                break
        except Exception:
            pass
    
    await debug_page(tab, idx, "10_final")
    
    url = await js(tab, "window.location.href") or ""
    body = await js(tab, "document.body.innerText") or ""
    
    print(f"   final URL: {url[:100]}")
    print(f"   final text: {body[:300]}")
    
    # Determine status - check for trial started FIRST
    has_trial = "trial started" in body.lower() or "congratulations" in body.lower() or "enterprise trial" in body.lower()
    status = "unknown"
    if has_trial:
        status = "completed"  # Trial started = account is usable
    elif "billing" in url.lower():
        status = "enterprise_trial_started"
    elif "settings" in url.lower():
        status = "on_settings_page"
    elif "sign-in" in url.lower() or "login" in url.lower():
        status = "login_failed"
    elif "onboarding" in url.lower():
        status = "on_onboarding"
    else:
        status = "completed"
    
    result = {
        "email": email,
        "username": username,
        "password": password,
        "url": url,
        "status": status,
        "ts": time.time()
    }
    with open(OUT, "a", encoding="utf-8") as f:
        f.write(json.dumps(result) + "\n")
    print(f"\n   SAVED (status: {status})")
    
    # Cleanup mail browser if viptemp
    if mail_provider == "viptemp":
        try:
            await mail.close()
        except Exception:
            pass
    
    return result

async def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    print(f"Postman Enterprise Registration - {n} account(s)")
    
    # Check for proxy in environment
    proxy = os.environ.get("PM_PROXY", "")
    browser_args = ["--disable-gpu", "--window-size=1280,900"]
    if proxy:
        browser_args.append(f"--proxy-server=http://{proxy}")
        print(f"Using proxy: {proxy}")
    
    browser = await uc.start(
        headless=False,
        browser_args=browser_args
    )
    
    results = []
    try:
        for i in range(1, n + 1):
            try:
                r = await register_one(browser, i)
                if r:
                    results.append(r)
            except Exception as e:
                print(f"   ERROR: {e}")
                import traceback
                traceback.print_exc()
            await asyncio.sleep(3)
    finally:
        # ALWAYS close browser, even on kill/timeout/failure — prevents
        # orphaned Chrome processes piling up and eating RAM.
        try:
            browser.stop()
        except Exception:
            pass
    
    print(f"\n{'='*50}")
    print(f"RESULTS: {len(results)}/{n} accounts registered")
    for r in results:
        print(f"  {r['email']} - {r['status']}")
    print(f"{'='*50}")

if __name__ == "__main__":
    asyncio.run(main())
