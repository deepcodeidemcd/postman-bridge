"""Check recent conversation states to see if auto-run completed."""
import json, urllib.request

BASE = "http://localhost:8787"
HEADERS = {"Content-Type": "application/json", "Authorization": "Bearer sk-postman-local"}

expression = """
(async () => {
  const res = await fetch('/_gw/conversation?limit=5', {
    method: 'GET', headers: {'x-pstmn-req-service': 'agent-mode-service'},
    credentials: 'include',
  });
  const data = await res.json();
  const convs = data.data || [];
  return JSON.stringify(convs.map(c => ({id: c.id, name: (c.name||'').substring(0,50), state: c.state})));
})()
"""
body = json.dumps({"expression": expression}).encode()
req = urllib.request.Request(f"{BASE}/admin/debug/runtime-eval", data=body, headers=HEADERS, method="POST")
resp = urllib.request.urlopen(req, timeout=60)
r = json.loads(resp.read().decode())
val = json.loads(r.get("result") or "[]")
for c in val:
    print(f"{c['name']:50s} state={c['state']}")
