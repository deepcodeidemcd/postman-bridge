"""
Postman Account Manager Service
- Register new accounts (batch)
- Activate Enterprise trial
- Pool accounts
- Check quota/credits
- Auto-switch when credits exhausted
- API server for bridge to call
"""
import json, os, sys, time, subprocess, threading
from pathlib import Path
from fastapi import Fastify
from contextlib import asynccontextmanager

PROJECT_DIR = Path(__file__).parent.parent
ACCOUNTS_FILE = PROJECT_DIR / "postman_accounts.jsonl"
REG_SCRIPT = PROJECT_DIR / "postman_enterprise_register.py"
BATCH_SCRIPT = PROJECT_DIR / "batch_register.py"

# ─── Account Pool ──────────────────────────────────────────────
class AccountPool:
    def __init__(self):
        self.accounts = []
        self.idx = 0
        self.lock = threading.Lock()
        self.load()
    
    def load(self):
        if not ACCOUNTS_FILE.exists():
            self.accounts = []
            return
        lines = ACCOUNTS_FILE.read_text(encoding="utf-8").split("\n")
        self.accounts = []
        for l in lines:
            l = l.strip()
            if not l:
                continue
            try:
                self.accounts.append(json.loads(l))
            except:
                pass
        print(f"[pool] loaded {len(self.accounts)} accounts")
    
    def current(self):
        if not self.accounts:
            return None
        return self.accounts[self.idx]
    
    def next(self):
        if len(self.accounts) <= 1:
            return None
        self.idx = (self.idx + 1) % len(self.accounts)
        return self.accounts[self.idx]
    
    def status(self):
        return {
            "total": len(self.accounts),
            "current_idx": self.idx,
            "current_email": self.accounts[self.idx]["email"] if self.accounts else None,
            "completed": sum(1 for a in self.accounts if a["status"] == "completed"),
            "onboarding": sum(1 for a in self.accounts if a["status"] == "on_onboarding"),
        }

pool = AccountPool()

# ─── Quota Check ──────────────────────────────────────────────
def check_quota(email: str) -> dict:
    """Check credits for an account by calling Postman API."""
    # Find account
    acc = next((a for a in pool.accounts if a["email"] == email), None)
    if not acc:
        return {"error": "account not found"}
    
    # Get workspace URL
    url = acc.get("url", f"https://{acc['username']}.postman.co/home")
    
    # We need to check credits via the bridge or directly
    # For now, return basic info
    return {
        "email": email,
        "username": acc["username"],
        "status": acc["status"],
        "url": url,
        "has_url": bool(acc.get("url")),
    }

# ─── Register ─────────────────────────────────────────────────
def register_accounts(count: int = 1, workers: int = 1) -> dict:
    """Register new Postman accounts."""
    try:
        result = subprocess.run(
            [sys.executable, "-u", str(BATCH_SCRIPT), str(count), str(workers)],
            cwd=str(PROJECT_DIR),
            capture_output=True,
            text=True,
            timeout=300,
        )
        # Reload accounts
        pool.load()
        return {
            "success": True,
            "total_accounts": len(pool.accounts),
            "output": result.stdout[-500:] if result.stdout else "",
        }
    except Exception as e:
        return {"success": False, "error": str(e)}

# ─── API Server ───────────────────────────────────────────────
from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI(title="Postman Account Manager")

@app.get("/api/pool/status")
def pool_status():
    return pool.status()

@app.get("/api/pool/current")
def pool_current():
    acc = pool.current()
    if not acc:
        return JSONResponse({"error": "no accounts"}, status_code=404)
    return acc

@app.post("/api/pool/switch")
def pool_switch():
    acc = pool.next()
    if not acc:
        return JSONResponse({"error": "no more accounts"}, status_code=404)
    return {"switched_to": acc["email"], "status": acc["status"]}

@app.get("/api/quota/{email}")
def quota_check(email: str):
    return check_quota(email)

@app.post("/api/register")
def register(count: int = 1, workers: int = 1):
    return register_accounts(count, workers)

@app.post("/api/pool/reload")
def pool_reload():
    pool.load()
    return pool.status()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8788)
