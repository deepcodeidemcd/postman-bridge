"""Get conversation detail for the completed one (WAITING_FOR_USER state)."""
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
  const completed = convs.find(c => c.state === 'WAITING_FOR_USER');
  if (!completed) return JSON.stringify({error: 'no completed conversation'});
  
  // Try to get conversation detail (messages, interactions)
  const detail = await fetch('/_gw/conversation/' + completed.id, {
    method: 'GET', headers: {'x-pstmn-req-service': 'agent-mode-service'},
    credentials: 'include',
  });
  const detailText = await detail.text();
  return JSON.stringify({convName: completed.name, convId: completed.id, detail: detailText.substring(0, 3000)});
})()
"""
body = json.dumps({"expression": expression}).encode()
req = urllib.request.Request(f"{BASE}/admin/debug/runtime-eval", data=body, headers=HEADERS, method="POST")
resp = urllib.request.urlopen(req, timeout=120)
r = json.loads(resp.read().decode())
val = json.loads(r.get("result") or "{}")
print(f"Conversation: {val.get('convName')}")
print(f"ID: {val.get('convId')}")
print(f"\nDetail:\n{val.get('detail', '')[:2500]}")