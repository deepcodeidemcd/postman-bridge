# AI Gateway — Handoff

## Endpoint
```
Base URL : http://<server-ip>:8787/v1
Auth     : Authorization: Bearer <API key>
Protocol : OpenAI-compatible (chat/completions, models)
```

## Quick start
```python
import requests

BASE = "http://<server-ip>:8787/v1"
KEY  = "<API key>"

r = requests.post(f"{BASE}/chat/completions",
    headers={"Authorization": f"Bearer {KEY}"},
    json={
        "model": "claude-sonnet-4-5",
        "messages": [
            {"role": "system", "content": "You are a helpful coding assistant."},
            {"role": "user", "content": "Write a function that parses ISO dates."},
        ],
    }, timeout=300)
print(r.json()["choices"][0]["message"]["content"])
```

## Models
`auto` (default) · `claude-sonnet-4-5` · `claude-sonnet-4-6` · `claude-opus-4-5` ·
`claude-haiku-4-5` · `gpt-5.5` · `gpt-5.4`

## Options
| Field | Values | Ghi chú |
|---|---|---|
| `reasoning_effort` | `low` / `medium` / `high` / `ultra` | ultra = 3-pass draft→review→final, ~3x thời gian, dùng cho code khó |
| `stream` | `true/false` | SSE chuẩn OpenAI |
| images | `image_url` với data-URL hoặc http URL | tự nén; latency ~30-60s/ảnh |

## Context model (quan trọng)
- **Stateless**: client gửi full `messages[]` mỗi request (chuẩn OpenAI). Server KHÔNG giữ context giữa các request — client quản lý conversation của mình.
- Input mỗi request nên ≤ ~8K ký tự phần text gần nhất (giới hạn upstream). Với context lớn, client chỉ gửi phần liên quan (Cursor/IDE đã tự làm sẵn).
- Multi-turn được verify: model nhớ chính xác facts từ history client gửi.

## Limits & lưu ý vận hành
- Latency: ~15-25s/request text; vision ~30-60s; ultra ~90-150s.
- Thỉnh thoảng vision flake (~10-20%) — client nên retry 1 lần; hoặc thêm hệ thống retry sẵn.
- Quota theo cụm: khi cạn, gateway tự chuyển sang tài khoản dự phòng — client không gián đoạn.
- Reset context client-side bất cứ lúc nào, không cần gọi gì server.

## Endpoints phụ
- `GET /v1/models` — danh sách model
- `POST /v1/conversations/reset` — no-op (stateless), giữ cho tương thích
- `GET /health` — kiểm tra gateway sống
- `GET /admin` — dashboard quản trị (chat thử, keys, status)

## Khuyến nghị client
- Timeout ≥ 120s cho text, ≥ 300s cho vision/ultra.
- Retry 1 lần khi gặp 502 (flake hiếm) — hầu hết lần 2 thành công.
- Đặt `reasoning_effort: "medium"` cho code thường; `"ultra"` cho task critical.
