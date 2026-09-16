import asyncio
import sys
import os
import time
import subprocess
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from db import get_pending_job, complete_job
from config import MAX_CONCURRENT_JOBS

WORKER_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(WORKER_DIR)
REG_SCRIPT = os.path.join(PROJECT_DIR, "postman_enterprise_register.py")
ACCOUNT_FILE = os.path.join(PROJECT_DIR, "postman_accounts.jsonl")


def clear_account_file():
    if os.path.exists(ACCOUNT_FILE):
        try:
            os.remove(ACCOUNT_FILE)
        except Exception:
            pass


def run_registration_sync():
    clear_account_file()
    try:
        result = subprocess.run(
            [sys.executable, "-u", REG_SCRIPT, "1"],
            capture_output=True,
            text=True,
            timeout=300,
            cwd=PROJECT_DIR,
            encoding="utf-8",
            errors="replace",
        )

        output = (result.stdout or "") + (result.stderr or "")

        if os.path.exists(ACCOUNT_FILE):
            with open(ACCOUNT_FILE, "r", encoding="utf-8") as f:
                lines = [l.strip() for l in f if l.strip()]
            if lines:
                return json.loads(lines[-1]), None

        return None, "No account produced. Output: " + output[-500:] if output else "empty output"

    except subprocess.TimeoutExpired:
        return None, "Registration timed out (300s)"
    except Exception as e:
        return None, str(e)


async def process_job(job):
    print(f"  [WORKER] Processing job #{job['id']} for user {job['user_id']}")
    loop = asyncio.get_event_loop()
    try:
        account, error = await asyncio.wait_for(
            loop.run_in_executor(None, run_registration_sync),
            timeout=360
        )
    except asyncio.TimeoutError:
        account, error = None, "Job timed out (360s)"

    if account and "email" in account:
        complete_job(job["id"], "completed", account)
        print(f"  [WORKER] Job #{job['id']} DONE: {account.get('email')}")
    else:
        complete_job(job["id"], "failed", error=error or "Unknown error")
        print(f"  [WORKER] Job #{job['id']} FAILED: {error[:100] if error else 'unknown'}")


async def worker_loop():
    print("[WORKER] Background worker started")
    while True:
        try:
            job = get_pending_job()
            if job:
                await process_job(job)
            else:
                await asyncio.sleep(5)
        except Exception as e:
            print(f"[WORKER] Error: {e}")
            await asyncio.sleep(10)


if __name__ == "__main__":
    asyncio.run(worker_loop())
