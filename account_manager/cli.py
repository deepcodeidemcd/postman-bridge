"""
Account Manager CLI - Direct command line tool
Usage:
  python account_manager/cli.py status          # Show pool status
  python account_manager/cli.py register <n>    # Register n accounts
  python account_manager/cli.py switch          # Switch to next account
  python account_manager/cli.py quota <email>   # Check quota
  python account_manager/cli.py list            # List all accounts
"""
import json, sys, os, subprocess
from pathlib import Path

PROJECT_DIR = Path(__file__).parent.parent
ACCOUNTS_FILE = PROJECT_DIR / "postman_accounts.jsonl"
REG_SCRIPT = PROJECT_DIR / "postman_enterprise_register.py"
BATCH_SCRIPT = PROJECT_DIR / "batch_register.py"

def load_accounts():
    if not ACCOUNTS_FILE.exists():
        return []
    accounts = []
    for line in ACCOUNTS_FILE.read_text(encoding="utf-8").split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            accounts.append(json.loads(line))
        except:
            pass
    return accounts

def cmd_status():
    accounts = load_accounts()
    completed = [a for a in accounts if a["status"] == "completed"]
    onboarding = [a for a in accounts if a["status"] == "on_onboarding"]
    print(f"Pool: {len(accounts)} accounts ({len(completed)} completed, {len(onboarding)} onboarding)")
    for i, a in enumerate(accounts):
        print(f"  {i+1}. {a['username']}: {a['status']} {a['email']}")

def cmd_register(count=1):
    print(f"Registering {count} accounts...")
    result = subprocess.run(
        [sys.executable, "-u", str(BATCH_SCRIPT), str(count), "3"],
        cwd=str(PROJECT_DIR),
        timeout=300,
    )
    print(f"Done. Return code: {result.returncode}")

def cmd_list():
    accounts = load_accounts()
    for i, a in enumerate(accounts):
        print(f"{i+1}. {a['username']}: {a['status']} {a['email']} {a.get('url', 'no url')[:50]}")

def check_quota(email):
    accounts = load_accounts()
    acc = next((a for a in accounts if a["email"] == email), None)
    if not acc:
        return {"error": "account not found"}
    return {"email": email, "username": acc["username"], "status": acc["status"], "url": acc.get("url", "no url")}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    
    cmd = sys.argv[1]
    if cmd == "status":
        cmd_status()
    elif cmd == "register":
        count = int(sys.argv[2]) if len(sys.argv) > 2 else 1
        cmd_register(count)
    elif cmd == "list":
        cmd_list()
    elif cmd == "quota":
        email = sys.argv[2] if len(sys.argv) > 2 else None
        if email:
            result = check_quota(email)
            print(json.dumps(result, indent=2))
        else:
            print("Usage: python cli.py quota <email>")
    else:
        print(f"Unknown command: {cmd}")
        print(__doc__)
