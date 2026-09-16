# AI Gateway — Hướng dẫn chạy (README)

Gateway API tương thích OpenAI, dùng cho coding. Client bất kỳ (Cursor, OpenCode, script Python/JS…) trỏ vào là dùng được — không cần biết backend là gì.

---

## 1. Yêu cầu máy chủ

- **Windows 10/11** (đã test trên Windows)
- **Node.js ≥ 20** — tải tại https://nodejs.org (bản LTS)
- **Google Chrome** — tải tại https://www.google.com/chrome
- Kết nối internet

Kiểm tra đã đủ:

```bat
node --version
```
→ phải hiện `v20.x` trở lên.

---

## 2. Lần đầu chạy (cấu hình 1 lần)

### 2.1. Mở thư mục project

Mở **File Explorer**, vào thư mục chứa project (ví dụ `D:\hoat_hinh\postman-openai-bridge-v0.1.0`). Trong thư mục phải có:

```
src\               ← mã nguồn
node_modules\      ← thư viện (đã cài sẵn)
.env               ← cấu hình
start_bridge.bat   ← file khởi động
```

> Nếu `node_modules` chưa có (mới copy project sang máy khác), mở **Command Prompt** trong thư mục project rồi chạy:
> ```bat
> npm install
> ```

### 2.2. Kiểm tra file `.env`

Mở file `.env` bằng Notepad, các dòng quan trọng:

```ini
BRIDGE_HOST=127.0.0.1        ← IP lắng nghe. Để 0.0.0.0 nếu cho máy khác kết nối vào
BRIDGE_PORT=8787             ← cổng API
BRIDGE_API_KEYS={"default":"sk-postman-local"}   ← API key cho client
```

**Muốn client từ máy khác kết nối được**: đổi `BRIDGE_HOST=0.0.0.0` và mở port 8787 trên Windows Firewall:

```bat
netsh advfirewall firewall add rule name="AI Gateway" dir=in action=allow protocol=TCP localport=8787
```

**Muốn tạo thêm API key cho từng khách** (tùy chọn): sau khi gateway chạy, mở `http://localhost:8787/admin` → tab **Hệ thống** → mục **API Keys** → thêm user mới.

---

## 3. Chạy gateway

**Double-click `start_bridge.bat`** — xong. Một cửa sổ sẽ hiện ra và tự chạy.

Lần đầu chạy, gateway sẽ:
1. Tự mở một cửa sổ **Chrome** riêng (đây là trình duyệt làm việc ngầm của gateway — **đừng tắt nó**, thu nhỏ được)
2. Tự đăng nhập và vào workspace
3. Hiện dòng `Server listening` trong cửa sổ đen — lúc đó API đã sẵn sàng

> Cửa sổ Chrome này **phải luôn mở** khi gateway hoạt động. Nếu lỡ tay tắt, gateway tự mở lại ở request tiếp theo.

### Chạy ngầm (không hiện cửa sổ đen)

Nếu muốn chạy ẩn sau khi đã đăng nhập Chrome lần đầu: dùng Task Scheduler trỏ tới `start_bridge.bat`, hoặc cứ để cửa sổ đen chạy nền cũng được.

---

## 4. Kiểm tra gateway đang sống

Mở trình duyệt, vào:

```
http://localhost:8787/health
```

→ hiện `{"ok":true,...}` là OK.

Hoặc thử gọi API thật bằng Command Prompt:

```bat
curl http://localhost:8787/v1/models -H "Authorization: Bearer sk-postman-local"
```

→ hiện danh sách model dạng JSON.

---

## 5. Dùng từ client (bên khách)

### 5.1. Thông số kết nối

| | |
|---|---|
| Base URL | `http://<IP-may-chu>:8787/v1` |
| API Key | `sk-postman-local` (hoặc key riêng đã cấp) |
| Protocol | OpenAI-compatible |

### 5.2. Ví dụ Python

```python
import requests

BASE = "http://<IP-may-chu>:8787/v1"
KEY  = "sk-postman-local"

r = requests.post(f"{BASE}/chat/completions",
    headers={"Authorization": f"Bearer {KEY}"},
    json={
        "model": "claude-sonnet-4-5",
        "messages": [
            {"role": "user", "content": "Viết hàm Python đọc file CSV."},
        ],
        "reasoning_effort": "medium",
    }, timeout=300)

print(r.json()["choices"][0]["message"]["content"])
```

### 5.3. Ví dụ OpenAI SDK (chuẩn)

```python
from openai import OpenAI

client = OpenAI(base_url="http://<IP-may-chu>:8787/v1",
                api_key="sk-postman-local")

resp = client.chat.completions.create(
    model="claude-sonnet-4-5",
    messages=[{"role": "user", "content": "Explain big-O of quicksort"}],
)
print(resp.choices[0].message.content)
```

### 5.4. Trỏ Cursor / OpenCode / tool khác

Chỉ cần set trong cấu hình tool:

```
Base URL: http://<IP-may-chu>:8787/v1
API Key:  sk-postman-local
```

### 5.5. Danh sách model

| Model | Dùng khi |
|---|---|
| `auto` | để gateway tự chọn (mặc định) |
| `claude-sonnet-4-5` | code hằng ngày — nhanh, mạnh |
| `claude-sonnet-4-6` | bản mới hơn |
| `claude-opus-4-5` | code khó nhất, chậm hơn |
| `claude-haiku-4-5` | nhanh nhất, việc nhẹ |
| `gpt-5.5` / `gpt-5.4` | phong cách GPT |

### 5.6. Tùy chọn hay dùng

```json
{
  "model": "claude-sonnet-4-5",
  "messages": [...],
  "reasoning_effort": "medium"     ← "low" | "medium" | "high" | "ultra"
}
```

- `medium` — mặc định, code thường
- `high` — bài khó
- `ultra` — 3 lớp: viết → tự review → viết lại. Chậm ~3 lần nhưng sâu nhất. Dùng cho code production

**Gửi ảnh** (vision):

```json
{
  "messages": [{
    "role": "user",
    "content": [
      {"type": "text", "text": "Ảnh này là gì?"},
      {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}
    ]
  }]
}
```

### 5.7. Context & multi-turn (QUAN TRỌNG)

Gateway là **stateless** — như API OpenAI thật:

- Client phải gửi **đầy đủ `messages[]`** (toàn bộ hội thoại) ở **mỗi request**
- Server không nhớ gì giữa 2 request — client tự quản lịch sử
- Muốn hội thoại mới → chỉ cần gửi `messages[]` mới

```python
messages = []
messages.append({"role": "user", "content": "Tôi dùng biến tên APP_SECRET_X7. Nhớ nhé."})
# ... gọi API, nhận answer ...
messages.append({"role": "assistant", "content": answer})
messages.append({"role": "user", "content": "Viết hàm dùng biến APP_SECRET_X7."})
# ... gọi lại với FULL messages → model nhớ APP_SECRET_X7
```

### 5.8. Timeout khuyến nghị

| Loại request | Timeout |
|---|---|
| Text thường | ≥ 120s |
| Có ảnh | ≥ 300s |
| `reasoning_effort: "ultra"` | ≥ 300s |

Retry 1 lần khi gặp lỗi 502 (hiếm) — gần như luôn thành công ở lần 2.

---

## 6. Vận hành hằng ngày

| Việc | Cách |
|---|---|
| **Khởi động** | Double-click `start_bridge.bat` |
| **Dừng** | Đóng cửa sổ đen (hoặc Ctrl+C trong nó) + đóng cửa sổ Chrome của gateway |
| **Kiểm tra sống** | Mở `http://localhost:8787/health` |
| **Xem log** | Mở file `bridge_run.log` trong thư mục project |
| **Gateway tự chết?** | `start_bridge.bat` tự khởi động lại trong 3 giây — không cần làm gì |
| **Hết lượt dùng?** | Gateway tự chuyển sang tài khoản dự phòng — client không bị gián đoạn |

---

## 7. Xử lý sự cố

| Triệu chứng | Cách xử lý |
|---|---|
| `EADDRINUSE` khi chạy | Cổng 8787 bị chiếm — đóng hết cửa sổ `start_bridge.bat` cũ (Task Manager → tìm `cmd.exe`/`node.exe`), chạy lại |
| Chrome không mở / login trắng | Xóa các file `Singleton*` trong thư mục `.postman-profile` rồi chạy lại bat |
| Client báo connection refused | Chưa chạy bat, hoặc `BRIDGE_HOST=127.0.0.1` nhưng client từ máy khác — đổi thành `0.0.0.0` + mở firewall |
| Lỗi 401 Invalid API key | Sai key — kiểm tra `BRIDGE_API_KEYS` trong `.env` |
| Lỗi 502 thỉnh thoảng | Retry 1 lần là được; nếu liên tục → xem `bridge_run.log` |
| Trả lời chậm | Bình thường với ảnh/ultra; text thường ~15-25s |
| Log hiện "quota exhausted, switching" | Đang tự đổi tài khoản dự phòng — không lỗi, cứ để chạy |

---

## 8. Bảo mật

- `.env` chứa API keys — **không chia sẻ file này** ngoài nhóm
- Key mặc định `sk-postman-local` chỉ dùng nội bộ/máy local. Cho khách: tạo key riêng qua `/admin`
- Khi expose ra internet: đặt sau reverse proxy (nginx/caddy) + HTTPS, hoặc VPN/tunnel (Cloudflare Tunnel, Tailscale)
- Không public port 8787 trực tiếp không mật khẩu — key là lớp bảo vệ duy nhất

---

## 9. File quan trọng trong project

```
.env                     ← cấu hình (host, port, keys)
start_bridge.bat         ← khởi động gateway (chạy file này)
bridge_run.log           ← log runtime
HANDOFF.md               ← tài liệu bàn giao cho khách (bản EN ngắn)
postman_accounts.jsonl   ← pool tài khoản (tự quản, không đụng vào)
.postman-profile\        ← trình duyệt làm việc của gateway (đừng xóa)
src\                     ← mã nguồn
```
