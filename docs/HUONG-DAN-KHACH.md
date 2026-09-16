# Hướng dẫn cài đặt & sử dụng Postman OpenAI Bridge

Bridge chuyển **Postman Agent Mode** (web) thành API chuẩn `OpenAI-compatible` — dùng được với Cursor, Claude Code, hay bất kỳ client nào hỗ trợ đổi Base URL + API key.

---

## 1. Yêu cầu hệ thống

- Windows 10/11
- Node.js 20+ (khuyến nghị 20 LTS hoặc mới hơn)
- Google Chrome (bản mới nhất)
- Tài khoản Postman **đã đăng ký được dùng Agent Mode** và các model cần dùng

> Bridge **không** lấy token/cookie của bạn. Bạn tự đăng nhập Postman một lần trong cửa sổ Chrome riêng, bridge chỉ thao tác trên giao diện như người dùng bình thường.

---

## 2. Cài đặt

Giải nén thư mục dự án, mở **CMD trong thư mục đó**:

```bat
npm install
copy .env.example .env
```

Mở file `.env` bằng Notepad và sửa:

```env
# Bắt buộc: dán URL workspace Postman của bạn (có Agent Mode)
POSTMAN_WORKSPACE_URL=https://ten-team.postman.co/workspace/xxxxxxxx.../overview

# API key (1 user) hoặc map key cho nhiều user (xem mục 7)
BRIDGE_API_KEYS={"default":"sk-postman-local"}
```

---

## 3. Mở Chrome đặc biệt (bắt buộc với Chrome 136+)

Chrome bản mới **chặn cổng debug** khi dùng profile mặc định, nên cần mở **một cửa sổ Chrome riêng** bằng profile riêng. Cửa sổ này **chạy song song**, không ảnh hưởng Chrome bạn vẫn dùng hằng ngày:

```bat
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="D:\duong-dan\thu-muc-du-an\.chrome-cdp-profile"
```

Chạy lệnh trên **mỗi lần bật máy** (hoặc để bridge tự mở — xem chú thích bên dưới).

> **Chú thích:** Chrome này sẽ tự đăng nhập bằng tài khoản Google của máy nếu có. Nếu nó hiện giao diện tài khoản, cứ để yên — bạn chỉ cần đăng nhập **Postman** trong cửa sổ này, không phải Google.

---

## 4. Đăng nhập Postman & chạy bridge

1. Trong cửa sổ Chrome đặc biệt (mục 3), mở `https://www.postman.com` và đăng nhập tài khoản Postman của bạn.
2. Nếu được hỏi, mở workspace đích và **bật Agent Mode** một lần (bấm nút **"AI"** trên thanh công cụ).
3. Chạy bridge:

```bat
npm start
```

Chờ đến khi thấy dòng: `server listening on http://127.0.0.1:8787`

> **Đăng nhập chỉ cần 1 lần duy nhất.** Lần sau chỉ cần bật Chrome + `npm start` là dùng được.

---

## 5. Kiểm tra hoạt động

Mở cửa sổ CMD thứ hai (hoặc dùng PowerShell):

```powershell
# 1. Danh sách model
Invoke-RestMethod http://127.0.0.1:8787/v1/models -Headers @{ Authorization = "Bearer sk-postman-local" }

# 2. Test chat
$body = @{ model = "claude-opus-4-8"; messages = @(@{ role = "user"; content = "Chào bạn" }) } | ConvertTo-Json -Depth 6
Invoke-RestMethod http://127.0.0.1:8787/v1/chat/completions -Method Post -Headers @{ Authorization = "Bearer sk-postman-local" } -ContentType "application/json" -Body $body
```

Kết quả tốt: HTTP **200**, `finish_reason: stop`, model trả lời đúng nội dung.

### Model đặc biệt: `auto` và chế độ Thinking

- Model `auto` = bật toggle **Auto** trong UI (backend tự chọn model phù hợp).
- Thêm `"thinking": true` vào body để bật **extended thinking** cho lượt gửi đó (suy luận sâu hơn với câu khó):

```powershell
$body = @{
  model    = "auto"
  thinking = $true
  messages = @(@{ role = "user"; content = "Giải thích REST API là gì" })
} | ConvertTo-Json -Depth 6
```

- Không gửi trường `thinking` → giữ nguyên trạng thái đang có.
- Cũng hỗ trợ trường chuẩn OpenAI `reasoning_effort` (`"none"` = tắt thinking).

Chạy kiểm tra toàn diện:

```bat
npm run doctor
```

Nếu có gì lỗi, doctor tự chụp ảnh màn hình lưu ở `.runtime/` để debug.

---

## 6. Kết nối với Cursor (hoặc client tương tự)

Trong phần cấu hình OpenAI custom của Cursor:

```text
Base URL: http://127.0.0.1:8787/v1
API key:  sk-postman-local
Model:    claude-opus-4-8   (lấy ID trong kết quả GET /v1/models)
```

Dùng đúng model ID bridge trả về — không tự nhập bừa.

---

## 7. Nhiều user dùng chung (tùy chọn)

Mỗi user cần **một tab Postman riêng** (ngữ cảnh hội thoại cách ly hoàn toàn). Cấu hình trong `.env`:

```env
# Map <tên-user> -> <api key>
BRIDGE_API_KEYS={"default":"sk-postman-local","guest":"sk-guest","nhanvien":"sk-nv1"}

# Giới hạn số tab mở đồng thời (vượt quá sẽ trả HTTP 429)
POSTMAN_MAX_TABS=5

# Giữ tab của user sống bao lâu sau request cuối (1 giờ = không phải mở tab mới liên tục)
POSTMAN_TAB_IDLE_TTL_MS=3600000
```

Mỗi user dùng key của mình làm `Authorization`; số tab đang chạy xem tại `/admin/status`.

---

## 8. Các endpoint quản trị

| Endpoint | Chức năng |
|---|---|
| `GET /health` | Kiểm tra server sống (không cần key) |
| `GET /v1/models` | Liệt kê model Postman hiển thị (có cache) |
| `POST /v1/chat/completions` | Chat completion chuẩn OpenAI |
| `GET /admin/status` | Trạng thái: tab của từng user, cache model, trình duyệt |
| `POST /admin/models/refresh` | Ép quét lại danh sách model |
| `POST /admin/screenshot` | Chụp màn hình Postman để debug UI |

---

## 9. Khi gặp sự cố

| Hiện tượng | Cách xử lý |
|---|---|
| Cửa sổ Chrome đặc biệt bị đóng | Bridge sẽ **tự mở lại** khi có request — chỉ cần chờ ~20 giây đầu tiên |
| Request trả 500/không có reply | Chạy `npm run doctor`, xem ảnh chụp ở `.runtime/` — thường do Postman đổi giao diện |
| Bị 429 `too_many_concurrent_tabs` | Tăng `POSTMAN_MAX_TABS` hoặc giảm số user dùng đồng thời |
| Cần xem log chi tiết | File `.runtime/server.out.log` |
| Postman đổi UI làm hỏng thao tác | Đặt selector ghi đè trong `.env` (xem `.env.example` phần `POSTMAN_SELECTOR_*`) |

---

## 10. Lưu ý bảo mật

- Bridge chạy ở `127.0.0.1` — **chỉ máy cài nó gọi được**. Không mở ra mạng ngoài nếu chưa có khóa mạnh + proxy/TLS.
- Không commit `.env` và thư mục `.postman-profile/` / `.chrome-cdp-profile/` (chứa phiên đăng nhập).
- Không dùng đúng key → request bị từ chối `401`.
- Bridge không đọc/trích xuất token đăng nhập Postman của bạn.

---

*Hỗ trợ: liên hệ người triển khai khi gặp lỗi kèm nội dung file `.runtime/server.out.log`.*