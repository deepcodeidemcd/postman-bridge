"""Read stored text from __vr3 div via runtime-eval."""
import json, urllib.request

BASE = "http://localhost:8787"
HEADERS = {"Content-Type": "application/json", "Authorization": "Bearer sk-postman-local"}

step = "JSON.stringify({stored: document.getElementById('__vr3')?.textContent?.substring(0, 500) || 'NOT FOUND'})"
body = json.dumps({"expression": step}).encode()
req = urllib.request.Request(f"{BASE}/admin/debug/runtime-eval", data=body, headers=HEADERS, method="POST")
resp = urllib.request.urlopen(req, timeout=60)
r = json.loads(resp.read().decode())
print(r.get("result"))
