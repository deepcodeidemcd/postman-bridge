"""Autonomous registration supervisor.

Runs detached. Every 2 minutes:
- count completed accounts in postman_accounts.jsonl
- if < 125 and no batch_register.py running -> relaunch batch (remaining + buffer)
- if >= 125 -> kill batch tree, POST /admin/pool/reload on bridge,
  write 1B_DONE.marker, exit.

Log: supervisor.log (project dir).
"""
import csv
import io
import json
import os
import subprocess
import sys
import time
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

PROJ = r"D:\hoat_hinh\postman-openai-bridge-v0.1.0"
OUT = os.path.join(PROJ, "postman_accounts.jsonl")
MARKER = os.path.join(PROJ, "1B_DONE.marker")
TARGET = 125
BRIDGE = "http://localhost:8787"
TOKEN = "sk-postman-local"

def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)

def done_count():
    try:
        n = 0
        with open(OUT, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                if r.get("status") in ("completed", "enterprise_trial_started"):
                    n += 1
        return n
    except FileNotFoundError:
        return 0

import psutil

def batch_running():
    # psutil is reliable; wmic CSV parsing was flaky and caused
    # duplicate batches (two parents burning the verify rate limit).
    for p in psutil.process_iter(["name", "cmdline"]):
        try:
            if p.info["name"] and p.info["name"].lower() == "python.exe":
                cl = " ".join(p.info["cmdline"] or [])
                if "batch_register.py" in cl:
                    return True
        except Exception:
            continue
    return False

def kill_batch():
    for p in psutil.process_iter(["name", "cmdline"]):
        try:
            if p.info["name"] and p.info["name"].lower() == "python.exe":
                cl = " ".join(p.info["cmdline"] or [])
                if "batch_register.py" in cl:
                    subprocess.run(["taskkill", "/F", "/T", "/PID", str(p.pid)],
                                   capture_output=True, timeout=30)
                    log(f"killed batch pid {p.pid}")
        except Exception:
            continue

def launch_batch(n):
    cmd = (f"cmd /c cd /d {PROJ} && set PM_STAGGER=90 && "
           f"set PM_JOB_DELAY=240 && python -u batch_register.py {n} 3 "
           f">> {PROJ}\\reg_1b_batch_auto.log 2>&1")
    subprocess.run(["wmic", "process", "call", "create", cmd],
                   capture_output=True, timeout=30)
    log(f"launched batch of {n}")

def reload_pool():
    req = urllib.request.Request(
        f"{BRIDGE}/admin/pool/reload", method="POST",
        headers={"Authorization": f"Bearer {TOKEN}"})
    return json.loads(urllib.request.urlopen(req, timeout=30).read())

def pool_total():
    req = urllib.request.Request(
        f"{BRIDGE}/admin/pool/status",
        headers={"Authorization": f"Bearer {TOKEN}"})
    return json.loads(urllib.request.urlopen(req, timeout=15).read()).get("total", 0)

log("supervisor start")
while True:
    try:
        n = done_count()
        log(f"done={n}/{TARGET}")
        if n >= TARGET:
            kill_batch()
            try:
                r = reload_pool()
                total = pool_total()
                log(f"pool reload ok: {r} total={total}")
                if total >= TARGET:
                    with open(MARKER, "w", encoding="utf-8") as f:
                        f.write(f"done={n} pool={total} at {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
                    log("ALL DONE")
                    break
                log("pool total below target, retrying reload in 60s")
            except Exception as e:
                log(f"reload err: {e}, retry in 60s")
            time.sleep(60)
            continue
        if not batch_running():
            need = TARGET - n + 5  # small buffer for fails
            log(f"batch dead, launching {need}")
            launch_batch(need)
            time.sleep(180)  # let it fully spawn before trusting the check
        time.sleep(120)
    except Exception as e:
        log(f"loop err: {e}")
        time.sleep(60)
