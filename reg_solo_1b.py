"""Standalone registration — 1 process, sequential, no workers.
Registers remaining accounts to hit 125 total, reloads bridge pool,
writes 1B_DONE.marker when complete.
"""
import json, os, subprocess, sys, time, urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

PROJ = r"D:\hoat_hinh\postman-openai-bridge-v0.1.0"
OUT = os.path.join(PROJ, "postman_accounts.jsonl")
REG = os.path.join(PROJ, "postman_enterprise_register.py")
MARKER = os.path.join(PROJ, "1B_DONE.marker")
TARGET = 125

def done_count():
    n = 0
    try:
        with open(OUT, encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    try:
                        r = json.loads(line)
                        if r.get("status") in ("completed", "enterprise_trial_started"):
                            n += 1
                    except: pass
    except: pass
    return n

def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)

def reload_pool():
    req = urllib.request.Request("http://localhost:8787/admin/pool/reload",
        method="POST", headers={"Authorization": "Bearer sk-postman-local"})
    return json.loads(urllib.request.urlopen(req, timeout=30).read())

def pool_total():
    req = urllib.request.Request("http://localhost:8787/admin/pool/status",
        headers={"Authorization": "Bearer sk-postman-local"})
    return json.loads(urllib.request.urlopen(req, timeout=15).read()).get("total", 0)

def reg_one(idx):
    """Register one account synchronously. Returns True on success."""
    env = os.environ.copy()
    env["PM_FAST"] = "1"
    env["PM_MAIL_PROVIDER"] = "mailtm"
    tmp = os.path.join(os.environ.get("TEMP", "/tmp"), f"reg_solo_{idx}.jsonl")
    env["PM_OUT_FILE"] = tmp
    try:
        proc = subprocess.run(
            [sys.executable, "-u", REG, "1"],
            cwd=PROJ, env=env,
            capture_output=True, timeout=300,
        )
        if proc.returncode == 0 and os.path.exists(tmp):
            with open(tmp, encoding="utf-8") as f:
                lines = [l.strip() for l in f if l.strip()]
            if lines:
                rec = json.loads(lines[-1])
                if rec.get("email"):
                    with open(OUT, "a", encoding="utf-8") as out:
                        out.write(json.dumps(rec) + "\n")
                    return True
        return False
    except Exception as e:
        log(f"  err: {e}")
        return False
    finally:
        try: os.remove(tmp)
        except: pass

# ── main ──
start = done_count()
log(f"starting: {start}/{TARGET} done, need {TARGET - start}")
attempt = 0
while done_count() < TARGET:
    attempt += 1
    now = done_count()
    log(f"attempt {attempt}: {now}/{TARGET}")
    ok = reg_one(attempt)
    if ok:
        log(f"  OK → {done_count()}/{TARGET}")
    else:
        log(f"  FAIL (will retry)")
    # small pause between attempts (no heavy pacing — single worker is safe)
    time.sleep(10)

final = done_count()
log(f"TARGET REACHED: {final}/{TARGET}")
log("reloading bridge pool...")
try:
    r = reload_pool()
    total = pool_total()
    log(f"pool: {r}, total={total}")
except Exception as e:
    log(f"pool reload err: {e}")
    # retry once
    time.sleep(30)
    try:
        r = reload_pool()
        log(f"pool retry ok: {r}, total={pool_total()}")
    except Exception as e2:
        log(f"pool retry failed: {e2}")

with open(MARKER, "w", encoding="utf-8") as f:
    f.write(f"done={final} at {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
log("ALL DONE — 1B_DONE.marker written")
