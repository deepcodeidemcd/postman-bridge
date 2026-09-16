"""
Overnight registration loop.
- Runs batches of 5 accounts
- Respects 30/hour rate limit (wait if needed)
- Logs all results
- Runs until manually stopped
"""
import asyncio, subprocess, sys, os, time, json

PROJECT_DIR = r"D:\hoat_hinh\postman-openai-bridge-v0.1.0"
REG_SCRIPT = os.path.join(PROJECT_DIR, "postman_enterprise_register.py")
LOG_FILE = os.path.join(PROXY_DIR := PROJECT_DIR, "reg_overnight.log")

def log(msg):
    ts = time.strftime("%H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")

def count_accounts():
    try:
        with open(os.path.join(PROJECT_DIR, "postman_accounts.jsonl"), encoding="utf-8") as f:
            lines = [l for l in f if l.strip()]
            done = sum(1 for l in lines if json.loads(l).get("status") in ("completed", "enterprise_trial_started"))
            return len(lines), done
    except:
        return 0, 0

async def run_batch(batch_size=5, worker_id=0):
    env = os.environ.copy()
    env["WORKER_ID"] = str(worker_id)
    env["PM_FAST"] = "1"
    tmp_file = os.path.join(PROJECT_DIR, f"pm_overnight_{worker_id}.jsonl")
    env["PM_OUT_FILE"] = tmp_file

    proc = await asyncio.create_subprocess_exec(
        sys.executable, "-u", REG_SCRIPT, str(batch_size),
        cwd=PROJECT_DIR, env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    stdout, _ = await asyncio.communicate(proc)
    output = stdout.decode("utf-8", errors="replace")
    
    done = output.count("[completed]")
    failed = output.count("FAILED")
    rate_limited = "rate limit" in output.lower() or "30 attempts" in output.lower()
    
    return done, failed, rate_limited

async def main():
    log("=" * 50)
    log("OVERNIGHT REGISTRATION STARTED")
    log("=" * 50)
    
    total, done = count_accounts()
    log(f"Starting accounts: {total} total, {done} completed")
    
    batch_num = 0
    total_registered = 0
    
    while True:
        batch_num += 1
        log(f"\n--- Batch {batch_num} ---")
        
        done, failed, rate_limited = await run_batch(batch_size=5, worker_id=batch_num % 3)
        total_registered += done
        
        log(f"Result: +{done} success, {failed} failed")
        
        total, done = count_accounts()
        log(f"Total: {total} accounts, {done} completed (+{total_registered} this session)")
        
        if rate_limited:
            log("Rate limited! Waiting 2 minutes...")
            await asyncio.sleep(120)
        else:
            log("Waiting 30s before next batch...")
            await asyncio.sleep(30)

if __name__ == "__main__":
    asyncio.run(main())
