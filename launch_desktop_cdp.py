"""Launch Postman Desktop with CDP enabled, then explore its internal APIs.
Desktop AgentWorker runs in Node with full network access - no CORS limits."""
import subprocess, json, urllib.request, time

# Kill existing Postman first
subprocess.run(["taskkill", "/F", "/IM", "Postman.exe"], capture_output=True)
import time
time.sleep(3)

# Launch with remote debugging
subprocess.Popen([
    r"C:\Users\Windows\AppData\Local\Postman\Postman.exe",
    "--remote-debugging-port=9223",
], creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)

time.sleep(15)

# Check CDP
try:
    r = urllib.request.urlopen("http://127.0.0.1:9223/json/version", timeout=10)
    print("CDP:", r.read().decode()[:300])
except Exception as e:
    print(f"CDP error: {e}")

# List pages
try:
    r = urllib.request.urlopen("http://127.0.0.1:9223/json", timeout=10)
    pages = json.loads(r.read().decode())
    print(f"\nPages: {len(pages)}")
    for p in pages[:15]:
        print(f"  {p.get('type')}: {p.get('title', '')[:60]} | {p.get('url', '')[:80]}")
except Exception as e:
    print(f"Pages error: {e}")