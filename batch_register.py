# -*- coding: utf-8 -*-
"""
Parallel batch registration runner.
Usage: python batch_register.py <num_accounts> <num_workers>

Each worker runs the registration script as a subprocess with its own browser.
Results append to postman_accounts.jsonl (unique emails per run via per-worker account file).
"""
import asyncio
import subprocess
import sys
import os
import time
import json
import tempfile
import shutil

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
REG_SCRIPT = os.path.join(PROJECT_DIR, "postman_enterprise_register.py")
FINAL_OUT = os.path.join(PROJECT_DIR, "postman_accounts.jsonl")

# Registration timeout per account (seconds)
TIMEOUT = 300


async def run_worker(worker_id: int, jobs: list, results: list):
    """One worker: sequential registrations, own temp account file."""
    env = os.environ.copy()
    env["WORKER_ID"] = str(worker_id)
    env["PM_FAST"] = "1"  # skip screenshots, shorter waits
    tmp_file = os.path.join(tempfile.gettempdir(), f"pm_worker_{worker_id}.jsonl")

    for job_idx, job_id in enumerate(jobs):
        t0 = time.time()
        print(f"[W{worker_id}] job {job_id} start", flush=True)

        # per-worker account file: clear it first
        if os.path.exists(tmp_file):
            os.remove(tmp_file)

        # Patch: registration script appends to its own OUT path
        # We pass the temp file via env var the script reads
        env["PM_OUT_FILE"] = tmp_file

        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-u", REG_SCRIPT, "1",
            cwd=PROJECT_DIR,
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )

        def snapshot_chromes():
            """PIDs of running chrome.exe (best effort)."""
            try:
                out = subprocess.run(
                    ["tasklist", "/FI", "IMAGENAME eq chrome.exe", "/FO", "CSV", "/NH"],
                    capture_output=True, timeout=15, text=True,
                ).stdout
                pids = set()
                for line in out.splitlines():
                    parts = [p.strip().strip('"') for p in line.split('","')]
                    if len(parts) >= 2 and parts[1].isdigit():
                        pids.add(int(parts[1]))
                return pids
            except Exception:
                return set()
        chromes_before = snapshot_chromes()

        def kill_tree():
            """Kill process + all children (Chrome spawned by nodriver survives
            plain proc.kill() on Windows and becomes an orphan eating RAM)."""
            try:
                if sys.platform == "win32" and proc.pid:
                    subprocess.run(
                        ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                        capture_output=True, timeout=15,
                    )
                else:
                    proc.kill()
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
            # Belt & suspenders: kill any batch-spawned chrome that appeared
            # during the job. SAFETY: never touch the bridge profile, the
            # user's normal browser (Default profile, no automation flags),
            # or anything we can't positively identify as ours (nodriver uses
            # temp profiles + remote-debugging-port).
            try:
                cmds = {}
                try:
                    out = subprocess.run(
                        ["wmic", "process", "where", "name='chrome.exe'",
                         "get", "ProcessId,CommandLine", "/format:csv"],
                        capture_output=True, timeout=20, text=True,
                    ).stdout
                    for line in out.splitlines()[1:]:
                        parts = [p.strip() for p in line.split(",", 2)]
                        if len(parts) == 3 and parts[1].isdigit():
                            cmds[int(parts[1])] = parts[2]
                except Exception:
                    pass
                for pid in snapshot_chromes() - chromes_before:
                    try:
                        low = cmds.get(pid, "").lower()
                        if "postman-profile" in low:
                            continue  # bridge browser — hands off
                        if "remote-debugging-port" not in low and "temp" not in low and "tmp" not in low and "uc-" not in low:
                            continue  # not recognizably ours — hands off
                        subprocess.run(["taskkill", "/F", "/PID", str(pid)],
                                       capture_output=True, timeout=10)
                    except Exception:
                        pass
            except Exception:
                pass
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=TIMEOUT)
        except asyncio.TimeoutError:
            kill_tree()
            try:
                await proc.wait()
            except Exception:
                pass
            print(f"[W{worker_id}] job {job_id} TIMEOUT ({TIMEOUT}s)", flush=True)
            results.append({"job": job_id, "worker": worker_id, "status": "timeout", "secs": time.time() - t0})
            continue

        output = out.decode("utf-8", errors="replace") if out else ""
        elapsed = time.time() - t0

        # Parse result
        account = None
        if os.path.exists(tmp_file):
            with open(tmp_file, "r", encoding="utf-8") as f:
                lines = [l.strip() for l in f if l.strip()]
            if lines:
                try:
                    account = json.loads(lines[-1])
                except Exception:
                    account = None

        if account and account.get("email"):
            results.append({
                "job": job_id, "worker": worker_id,
                "status": account.get("status", "completed"),
                "email": account.get("email"),
                "password": account.get("password"),
                "username": account.get("username"),
                "secs": round(elapsed, 1),
            })
            # Append to final output
            with open(FINAL_OUT, "a", encoding="utf-8") as f:
                f.write(json.dumps(account) + "\n")
            print(f"[W{worker_id}] job {job_id} DONE in {elapsed:.0f}s: {account.get('email')} [{account.get('status')}]", flush=True)
        else:
            # Extract failure reason from output
            reason = "unknown"
            for marker in ("CF FAILED", "Turnstile timeout", "Turnstile FAILED", "FAILED:", "CAPTCHA error"):
                if marker in output:
                    idx = output.index(marker)
                    reason = output[idx:idx + 80].replace("\n", " ")
                    break
            results.append({"job": job_id, "worker": worker_id, "status": "failed", "reason": reason, "secs": round(elapsed, 1)})
            print(f"[W{worker_id}] job {job_id} FAILED in {elapsed:.0f}s: {reason}", flush=True)

        # Pacing: Postman rate-limits verify attempts (~30/hour/IP).
        # PM_JOB_DELAY spaces jobs within a worker (seconds, default 0).
        job_delay = int(os.environ.get("PM_JOB_DELAY", "0"))
        if job_delay > 0 and job_idx < len(jobs) - 1:
            print(f"[W{worker_id}] pacing: sleeping {job_delay}s before next job", flush=True)
            await asyncio.sleep(job_delay)


def main():
    n_accounts = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    n_workers = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    n_workers = min(n_workers, n_accounts)

    print(f"BATCH: {n_accounts} accounts, {n_workers} parallel workers")
    print(f"Target: 1B tokens = {125} accounts | this run contributes {n_accounts * 8}M tokens")

    # Distribute jobs round-robin
    worker_jobs = [[] for _ in range(n_workers)]
    for j in range(n_accounts):
        worker_jobs[j % n_workers].append(j)

    t0 = time.time()
    results = []

    async def run_all():
        # STAGGER worker starts (default 45s apart) so their sensitive steps
        # (signup submit, upgrade click) don't hit Postman simultaneously
        # from the same IP — parallel bursts trigger silent session kills.
        # Override via PM_STAGGER env (seconds between worker starts).
        async def staggered(w):
            stagger = int(os.environ.get("PM_STAGGER", "45"))
            if w > 0:
                await asyncio.sleep(w * stagger)
            await run_worker(w, worker_jobs[w], results)
        tasks = [staggered(w) for w in range(n_workers)]
        await asyncio.gather(*tasks)

    asyncio.run(run_all())

    elapsed = time.time() - t0
    done = [r for r in results if r["status"] not in ("failed", "timeout")]
    failed = [r for r in results if r["status"] in ("failed", "timeout")]
    rate = len(done) / (elapsed / 60) if elapsed > 0 else 0

    print()
    print("=" * 60)
    print(f"FINISHED in {elapsed:.0f}s ({elapsed/60:.1f} min)")
    print(f"Success: {len(done)}/{n_accounts} | Failed: {len(failed)}")
    print(f"Throughput: {rate:.1f} acc/min | tokens this run: {len(done) * 8}M")
    print(f"Est. time for 125 acc at this rate: {125 / rate:.0f} min" if rate > 0 else "N/A")

    if failed:
        print("\nFailures:")
        for r in failed[:10]:
            print(f"  job {r['job']} [W{r['worker']}]: {r.get('reason', r['status'])}")

    # Save run summary
    summary = {
        "ts": time.time(),
        "accounts_requested": n_accounts,
        "workers": n_workers,
        "elapsed_secs": round(elapsed, 1),
        "success": len(done),
        "failed": len(failed),
        "acc_per_min": round(rate, 2),
        "results": results,
    }
    with open(os.path.join(PROJECT_DIR, "batch_summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
    print(f"\nSummary saved: batch_summary.json")


if __name__ == "__main__":
    main()
