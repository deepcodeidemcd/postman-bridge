# Hướng dẫn cài Codex + AI Gateway

## Kết nối Codex với gateway

### Bước 1: Đảm bảo gateway đang chạy

Trên máy host (máy chạy gateway), mở `start_bridge.bat` — cửa sổ Chrome + terminal hiện ra. Kiểm tra:

```
http://<IP-máy-host>:8787/health
```
→ hiện `{"ok":true}` là xong.

### Bước 2: Kết nối Codex

**Codex CLI** (OpenAI's coding CLI tool):

```bash
# Set base URL trỏ thẳng vào gateway — KHÔNG qua 9router
export OPENAI_BASE_URL=http://<IP-máy-host>:8787/v1
export OPENAI_API_KEY=sk-postman-local
codex
```

Hoặc trong `.env` của Codex / config file:
```json
{
  "baseURL": "http://<IP-máy-host>:8787/v1",
  "apiKey": "sk-postman-local"
}
```

### Bước 3: Test nhanh

Trong Codex, hỏi:
```
Create a Python function hello() that prints "hello world". 
Write it to a file called hello.py.
```

→ Codex sẽ gọi tool `apply_patch` / `shell` → gateway relay → model trả tool_calls → **Codex thực thi thật trên máy bạn** → file `hello.py` được tạo.

---

## Nếu vẫn muốn dùng 9router

9router là một gateway riêng kết nối thẳng Anthropic/OpenAI — KHÔNG đi qua bridge. Vấn đề tool calls cần fix ở cấu hình 9router.

**Cách đơn giản nhất:** bỏ qua 9router, Codex kết nối thẳng gateway (port 8787). Gateway xử lý hết: model selection, tool relay, SSE streaming, vision — không cần thêm lớp nào.

---

## Lưu ý quan trọng

| | Gateway trực tiếp (8787) | Qua 9router |
|---|---|---|
| Tool calls | ✅ relay đúng | ⚠️ phụ thuộc 9router |
| SSE streaming | ✅ hỗ trợ | ⚠️ có thể bị convert |
| /v1/responses | ✅ hỗ trợ | ⚠️ Codex có thể dùng endpoint này |
| Model selection | ✅ 11 models full | ✅ nhưng phải config đúng |
| Vision | ✅ hoạt động | ✅ nhưng không cần cho coding |

**Kết luận:** dùng gateway trực tiếp (8787) thay vì 9router để Codex có tool calls đúng chuẩn.
