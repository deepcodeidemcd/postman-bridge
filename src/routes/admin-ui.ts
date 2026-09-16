import { config } from '../config/env.js';

// The admin page needs one working key for its own fetch calls. Prefer the
// default user's key from BRIDGE_API_KEYS so the UI keeps working when only
// the multi-user map is configured (the legacy single key may not exist).
function uiApiKey(): string {
  const keys = config.server.apiKeys;
  return (
    keys[config.server.defaultUserId] ??
    Object.values(keys)[0] ??
    config.server.apiKey
  );
}

export function renderAdminPage(): string {
  const apiKey = uiApiKey();
  const baseUrl = `http://${config.server.host}:${config.server.port}/v1`;
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Postman OpenAI Bridge</title>
<style>
  :root {
    --bg: #262624; --panel: #30302e; --panel2: #3a3a38; --border: #4a4a46;
    --text: #f5f4ef; --muted: #b8b5ad; --accent: #d97757; --accent-hover: #c96a4c;
    --user-bubble: #393937; --ok: #7fb069; --bad: #e07a6a; --warn: #d9a05b;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }

  header { display: flex; align-items: center; gap: 16px; padding: 10px 20px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
  .logo { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 15px; }
  .logo .star { color: var(--accent); font-size: 18px; }
  nav { display: flex; gap: 4px; }
  nav button { background: transparent; color: var(--muted); border: 0; border-radius: 8px; padding: 6px 14px; font-size: 13px; cursor: pointer; }
  nav button:hover { color: var(--text); background: var(--panel2); }
  nav button.active { color: var(--text); background: var(--panel2); }
  .spacer { flex: 1; }
  .pill { padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .pill.ok { background: rgba(127,176,105,.15); color: var(--ok); }
  .pill.bad { background: rgba(224,122,106,.15); color: var(--bad); }
  .api-hint { font-size: 12px; color: var(--muted); }
  .api-hint code { background: var(--panel2); padding: 2px 6px; border-radius: 5px; }

  main { flex: 1; overflow: hidden; position: relative; }
  .view { position: absolute; inset: 0; display: none; flex-direction: column; overflow: hidden; }
  .view.active { display: flex; }

  /* ===== Chat view ===== */
  #chatScroll { flex: 1; overflow-y: auto; scroll-behavior: smooth; }
  #chatInner { max-width: 720px; margin: 0 auto; padding: 24px 16px 12px; display: flex; flex-direction: column; gap: 18px; min-height: 100%; justify-content: flex-end; }

  .greeting { text-align: center; margin: auto 0; padding-bottom: 12vh; }
  .greeting .big { font-size: 34px; font-weight: 700; letter-spacing: -.01em; }
  .greeting .big .star { color: var(--accent); }
  .greeting .small { color: var(--muted); margin-top: 8px; font-size: 14px; }

  .msg { display: flex; flex-direction: column; gap: 4px; }
  .msg.user { align-items: flex-end; }
  .msg.assistant { align-items: stretch; }
  .bubble-user { background: var(--user-bubble); border-radius: 16px; padding: 10px 16px; max-width: 85%; white-space: pre-wrap; word-break: break-word; font-size: 14px; line-height: 1.55; }
  .bubble-assistant { font-size: 14px; line-height: 1.65; white-space: pre-wrap; word-break: break-word; }
  .bubble-assistant.pending::after { content: "\\258D"; animation: blink 1s steps(2) infinite; color: var(--accent); }
  @keyframes blink { 50% { opacity: 0; } }
  .meta { font-size: 11px; color: var(--muted); }
  .msg.user .meta { text-align: right; }
  .bubble-assistant pre { background: #1e1e1c; border: 1px solid var(--border); border-radius: 10px; padding: 12px; overflow-x: auto; font-size: 13px; }
  .bubble-assistant code { background: #1e1e1c; border-radius: 4px; padding: 1px 5px; font-size: 13px; }
  .bubble-assistant pre code { background: none; padding: 0; }

  /* Composer */
  .composer-wrap { max-width: 720px; margin: 0 auto; width: 100%; padding: 8px 16px 18px; flex-shrink: 0; }
  .composer { background: var(--panel); border: 1px solid var(--border); border-radius: 18px; padding: 12px 14px 10px; transition: border-color .15s; }
  .composer:focus-within { border-color: #6a6a64; }
  .composer textarea { width: 100%; background: transparent; border: 0; outline: none; resize: none; color: var(--text); font: inherit; font-size: 15px; line-height: 1.5; max-height: 180px; }
  .composer textarea::placeholder { color: var(--muted); }
  .composer-bar { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--border); background: transparent; color: var(--muted); border-radius: 999px; padding: 5px 12px; font-size: 12.5px; cursor: pointer; user-select: none; }
  .chip:hover { color: var(--text); }
  .chip.on { background: rgba(217,119,87,.14); border-color: var(--accent); color: var(--accent); }
  .model-pick { position: relative; }
  .model-btn { display: inline-flex; align-items: center; gap: 6px; border: 0; background: transparent; color: var(--text); font-size: 13px; font-weight: 600; cursor: pointer; padding: 6px 10px; border-radius: 10px; }
  .model-btn:hover { background: var(--panel2); }
  .model-btn .chev { color: var(--muted); font-size: 11px; }
  .model-menu { display: none; position: absolute; bottom: calc(100% + 8px); right: 0; background: var(--panel); border: 1px solid var(--border); border-radius: 14px; min-width: 260px; max-height: 320px; overflow-y: auto; box-shadow: 0 8px 30px rgba(0,0,0,.45); z-index: 30; padding: 6px; }
  .model-menu.open { display: block; }
  .model-menu .mi { display: block; width: 100%; text-align: left; background: transparent; border: 0; color: var(--text); padding: 8px 12px; border-radius: 9px; font-size: 13.5px; cursor: pointer; }
  .model-menu .mi:hover { background: var(--panel2); }
  .model-menu .mi.sel { background: var(--panel2); }
  .model-menu .mi small { display: block; color: var(--muted); font-size: 11px; }
  .send-btn { margin-left: auto; width: 34px; height: 34px; border-radius: 50%; border: 0; background: var(--accent); color: #fff; font-size: 16px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
  .send-btn:hover { background: var(--accent-hover); }
  .send-btn:disabled { opacity: .4; cursor: not-allowed; }
  .err-line { color: var(--bad); font-size: 13px; margin-top: 6px; display: none; }

  /* ===== System view ===== */
  #sysScroll { flex: 1; overflow-y: auto; }
  .sys-wrap { max-width: 900px; margin: 0 auto; padding: 24px 16px 40px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; margin-bottom: 16px; }
  .card h2 { font-size: 14px; margin: 0 0 12px; color: var(--text); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }
  .stat { background: var(--panel2); border-radius: 10px; padding: 10px 12px; }
  .stat .label { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  .stat .value { font-size: 13.5px; margin-top: 4px; word-break: break-all; }
  .ok-t { color: var(--ok); font-weight: 600; } .bad-t { color: var(--bad); font-weight: 600; } .warn-t { color: var(--warn); font-weight: 600; }
  button.std { background: var(--accent); color: #fff; border: 0; border-radius: 8px; padding: 8px 14px; font-size: 13px; cursor: pointer; }
  button.std:hover { background: var(--accent-hover); }
  button.std:disabled { opacity: .5; cursor: not-allowed; }
  button.ghost { background: var(--panel2); color: var(--text); border: 0; border-radius: 8px; padding: 8px 14px; font-size: 13px; cursor: pointer; }
  button.ghost:hover { filter: brightness(1.15); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 600; font-size: 11.5px; text-transform: uppercase; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .muted { color: var(--muted); font-size: 12px; }
  input#newKeyUser { background: var(--panel2); border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 8px 10px; font-size: 13px; width: 200px; outline: none; }
  input#newKeyUser:focus { border-color: var(--accent); }
  td code { cursor: pointer; }
  #shotImg { max-width: 100%; border: 1px solid var(--border); border-radius: 10px; margin-top: 10px; }
</style>
</head>
<body>
<header>
  <div class="logo"><span class="star">✳</span> AI Gateway</div>
  <nav>
    <button id="tabChat" class="active">Chat</button>
    <button id="tabSys">Hệ thống</button>
  </nav>
  <div class="spacer"></div>
  <span class="api-hint"><code>${baseUrl}</code></span>
  <span id="healthPill" class="pill ok">…</span>
</header>

<main>
  <!-- ============ CHAT ============ -->
  <section id="viewChat" class="view active">
    <div id="chatScroll">
      <div id="chatInner">
        <div class="greeting" id="greeting">
          <div class="big"><span class="star">✳</span> Hôm nay cần tôi giúp gì?</div>
          <div class="small">Chat với các model AI — chọn model ở góc dưới.</div>
        </div>
      </div>
    </div>
    <div class="composer-wrap">
      <div class="composer">
        <textarea id="chatInput" rows="1" placeholder="Nhập tin nhắn… (Enter gửi · Shift+Enter xuống dòng)"></textarea>
        <div class="composer-bar">
          <button class="chip" id="clearChip" title="Xóa hội thoại này">🗑 Xóa</button>
          <button class="chip" id="thinkChip" title="Bật extended thinking của Postman cho lượt gửi này">🧠 Thinking</button>
          <div class="model-pick">
            <button class="model-btn" id="modelBtn"><span id="modelLabel">Auto</span> <span class="chev">▼</span></button>
            <div class="model-menu" id="modelMenu"></div>
          </div>
          <button class="send-btn" id="sendBtn" title="Gửi">↑</button>
        </div>
        <div class="err-line" id="chatErr"></div>
      </div>
    </div>
  </section>

  <!-- ============ SYSTEM ============ -->
  <section id="viewSys" class="view">
    <div id="sysScroll"><div class="sys-wrap">

      <div class="card">
        <h2>Trạng thái kết nối</h2>
        <div class="grid" id="statusGrid"><div class="stat"><div class="label">Đang tải</div></div></div>
      </div>

      <div class="card">
        <h2>Tab người dùng (multi-user)</h2>
        <div class="row" style="margin-bottom:10px"><span class="muted" id="tabsSummary">đang tải...</span></div>
        <table id="tabsTable">
          <thead><tr><th>User</th><th>Trạng thái</th><th>Idle</th></tr></thead>
          <tbody><tr><td colspan="3" class="muted">Chưa có user nào dùng tab.</td></tr></tbody>
        </table>
      </div>

      <div class="card">
        <h2>Models</h2>
        <div class="row" style="margin-bottom:10px">
          <button class="std" id="refreshBtn">Load models</button>
          <button class="ghost" id="refreshForceBtn">Refresh (bỏ cache)</button>
          <span class="muted" id="modelsHint"></span>
        </div>
        <table id="modelsTable">
          <thead><tr><th>ID</th><th>Hiển thị</th><th>Owned by</th></tr></thead>
          <tbody><tr><td colspan="3" class="muted">Chưa load</td></tr></tbody>
        </table>
      </div>

      <div class="card">
        <h2>Kết nối Cursor / API client</h2>
        <div class="row" style="margin-bottom:10px">
          <span class="muted">Base URL:</span>
          <code id="baseUrlTxt">…</code>
          <button class="ghost" id="copyUrlBtn">Copy</button>
        </div>
        <table id="keysTable">
          <thead><tr><th>User</th><th>API key (bấm để copy)</th><th></th></tr></thead>
          <tbody><tr><td colspan="3" class="muted">đang tải...</td></tr></tbody>
        </table>
        <div class="row" style="margin-top:10px">
          <input id="newKeyUser" placeholder="tên user, vd: cursor" />
          <button class="std" id="addKeyBtn">Tạo key</button>
          <span class="muted" id="keysHint"></span>
        </div>
        <div class="muted" style="margin-top:8px">Dán Base URL + API key vào phần model tùy chỉnh (OpenAI compatible) của Cursor.</div>
      </div>

      <div class="card">
        <h2>Screenshot debug</h2>
        <div class="row">
          <button class="std" id="shotBtn">Chụp screenshot</button>
          <span class="muted" id="shotOut"></span>
        </div>
        <img id="shotImg" hidden alt="screenshot" />
      </div>

    </div></div>
  </section>
</main>

<script>
"use strict";
var API_KEY = ${JSON.stringify(apiKey)};
var STATUS_URL = "/admin/status";
var MODELS_URL = "/v1/models";
var REFRESH_URL = "/admin/models/refresh";
var SHOT_URL = "/admin/screenshot";
var SHOT_FILE_URL = "/admin/screenshot/file";
var CHAT_URL = "/v1/chat/completions";

function hdr(withJsonBody) {
  var h = { "Authorization": "Bearer " + API_KEY };
  if (withJsonBody) h["Content-Type"] = "application/json";
  return h;
}
function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function fmtIdle(ms) {
  if (ms == null) return "-";
  if (ms < 60000) return Math.round(ms / 1000) + "s";
  if (ms < 3600000) return Math.round(ms / 60000) + "p";
  return (ms / 3600000).toFixed(1) + "h";
}

/* ---------- tabs ---------- */
$("tabChat").addEventListener("click", function () { switchView("chat"); });
$("tabSys").addEventListener("click", function () { switchView("sys"); });
function switchView(v) {
  $("tabChat").classList.toggle("active", v === "chat");
  $("tabSys").classList.toggle("active", v === "sys");
  $("viewChat").classList.toggle("active", v === "chat");
  $("viewSys").classList.toggle("active", v === "sys");
  if (v === "sys") { loadStatus(); if (!$("modelsTable").dataset.loaded) loadModels(false); loadKeys(); }
}

/* ---------- health ---------- */
async function pingHealth() {
  try {
    var h = await fetch("/health").then(function (r) { return r.json(); });
    $("healthPill").className = "pill " + (h && h.ok ? "ok" : "bad");
    $("healthPill").textContent = h && h.ok ? "Đang chạy" : "Lỗi";
  } catch (e) {
    $("healthPill").className = "pill bad";
    $("healthPill").textContent = "Mất kết nối";
  }
}

/* ---------- models ---------- */
var MODELS = [];            // [{id, display_name}]
var selectedModel = "";     // model id

async function fetchJson(url, options) {
  var res = await fetch(url, options);
  if (!res.ok) {
    var body = await res.text().catch(function () { return ""; });
    throw new Error("HTTP " + res.status + ": " + body.slice(0, 300));
  }
  return res.json();
}

function renderModelMenu() {
  var menu = $("modelMenu");
  menu.innerHTML = MODELS.map(function (m) {
    var sel = m.id === selectedModel ? " sel" : "";
    return "<button class='mi" + sel + "' data-id='" + esc(m.id) + "'>" + esc(m.display_name) +
      "<small>" + esc(m.id) + "</small></button>";
  }).join("");
  menu.querySelectorAll(".mi").forEach(function (btn) {
    btn.addEventListener("click", function () {
      selectedModel = btn.getAttribute("data-id");
      var m = MODELS.find(function (x) { return x.id === selectedModel; });
      $("modelLabel").textContent = m ? m.display_name : selectedModel;
      menu.classList.remove("open");
      renderModelMenu();
    });
  });
}

async function loadModels(force) {
  $("modelsHint").textContent = "đang load...";
  try {
    var resp;
    if (force) {
      await fetchJson(REFRESH_URL, { method: "POST", headers: hdr() });
      resp = await fetchJson(MODELS_URL, { headers: hdr() });
    } else {
      resp = await fetchJson(MODELS_URL, { headers: hdr() });
    }
    MODELS = resp.data || [];
    $("modelsTable").dataset.loaded = "1";
    $("modelsTable").querySelector("tbody").innerHTML = MODELS.length
      ? MODELS.map(function (m) {
          return "<tr><td><code>" + esc(m.id) + "</code></td><td>" + esc(m.display_name) + "</td><td>" + esc(m.owned_by || "") + "</td></tr>";
        }).join("")
      : "<tr><td colspan='3' class='muted'>Không có model nào.</td></tr>";
    $("modelsHint").textContent = MODELS.length + " models";

    if (!selectedModel || !MODELS.some(function (m) { return m.id === selectedModel; })) {
      var auto = MODELS.find(function (m) { return m.id === "auto"; });
      selectedModel = auto ? auto.id : (MODELS[0] ? MODELS[0].id : "");
      var mm = MODELS.find(function (x) { return x.id === selectedModel; });
      $("modelLabel").textContent = mm ? mm.display_name : "—";
    }
    renderModelMenu();
  } catch (e) {
    $("modelsHint").textContent = "Lỗi: " + e.message;
  }
}
$("refreshBtn").addEventListener("click", function () { loadModels(false); });
$("refreshForceBtn").addEventListener("click", function () { loadModels(true); });

$("modelBtn").addEventListener("click", function (ev) {
  ev.stopPropagation();
  $("modelMenu").classList.toggle("open");
});
document.addEventListener("click", function () { $("modelMenu").classList.remove("open"); });

$("thinkChip").addEventListener("click", function () {
  $("thinkChip").classList.toggle("on");
});

/* clear conversation */
$("clearChip").addEventListener("click", function () {
  if (busy) return;
  chatHistory = [];
  $("chatInner").querySelectorAll(".msg").forEach(function (n) { n.remove(); });
  $("greeting").style.display = "";
  showErr("");
});

/* ---------- chat ---------- */
// NOTE: do not name this "history" — assigning to window.history throws in
// strict mode and kills the whole script.
var chatHistory = []; // [{role, content}]
var busy = false;

function lightMarkdown(text) {
  var html = esc(text);
  html = html.replace(/\`\`\`([\\w-]*)\\n?([\\s\\S]*?)\`\`\`/g, function (_, lang, code) {
    return "<pre><code>" + code + "</code></pre>";
  });
  html = html.replace(/\`([^\`\\n]+)\`/g, "<code>$1</code>");
  return html;
}

function addMessage(role, content, metaText) {
  $("greeting").style.display = "none";
  var wrap = document.createElement("div");
  wrap.className = "msg " + role;
  var inner = role === "user"
    ? "<div class='bubble-user'>" + esc(content) + "</div>"
    : "<div class='bubble-assistant'>" + lightMarkdown(content) + "</div>";
  wrap.innerHTML = inner + (metaText ? "<div class='meta'>" + esc(metaText) + "</div>" : "");
  $("chatInner").appendChild(wrap);
  $("chatScroll").scrollTop = $("chatScroll").scrollHeight;
  return wrap;
}

function showErr(msg) {
  var el = $("chatErr");
  if (!msg) { el.style.display = "none"; el.textContent = ""; return; }
  el.textContent = msg;
  el.style.display = "block";
}

async function send() {
  if (busy) return;
  var input = $("chatInput");
  var text = input.value.trim();
  if (!text) return;
  if (!selectedModel) { showErr("Chưa có model — mở tab Hệ thống bấm Load models."); return; }

  showErr("");
  input.value = "";
  input.style.height = "auto";
  addMessage("user", text);
  chatHistory.push({ role: "user", content: text });

  busy = true;
  $("sendBtn").disabled = true;
  var pending = addMessage("assistant", "", "");
  var bubble = pending.querySelector(".bubble-assistant");
  bubble.classList.add("pending");

  var t0 = Date.now();
  try {
    var body = { model: selectedModel, messages: chatHistory.slice() };
    if ($("thinkChip").classList.contains("on")) body.thinking = true;
    var r = await fetchJson(CHAT_URL, { method: "POST", headers: hdr(true), body: JSON.stringify(body) });
    var elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    var content = "";
    if (r.choices && r.choices[0]) {
      var choice = r.choices[0];
      if (choice.message) content = choice.message.content || "";
      else if (choice.text) content = String(choice.text);
    }
    if (r.output_text) content = r.output_text;
    var finish = r.choices && r.choices[0] ? r.choices[0].finish_reason : "";

    bubble.classList.remove("pending");
    bubble.innerHTML = lightMarkdown(content || "(không có nội dung trả về)");
    var meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = elapsed + "s · " + (finish || "?") +
      (r.usage ? " · " + r.usage.total_tokens + " tokens" : "");
    pending.appendChild(meta);

    chatHistory.push({ role: "assistant", content: content });
  } catch (e) {
    bubble.classList.remove("pending");
    bubble.innerHTML = "<span style='color:var(--bad)'>Lỗi sau " +
      ((Date.now() - t0) / 1000).toFixed(1) + "s: " + esc(e.message) + "</span>";
    chatHistory.pop(); // remove the failed user turn so retry is clean
  } finally {
    busy = false;
    $("sendBtn").disabled = false;
    $("chatScroll").scrollTop = $("chatScroll").scrollHeight;
    $("chatInput").focus();
  }
}
$("sendBtn").addEventListener("click", send);
$("chatInput").addEventListener("keydown", function (ev) {
  if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); send(); }
});
$("chatInput").addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 180) + "px";
});

/* ---------- status (system view) ---------- */
async function loadStatus() {
  try {
    var s = await fetchJson(STATUS_URL, { headers: hdr() });
    var items = [
      { label: "Workspace", value: s.workspaceUrl },
      { label: "URL hiện tại", value: s.currentUrl },
      { label: "Đã đăng nhập", value: s.signedInLikely ? "Có" : "Chưa", cls: s.signedInLikely ? "ok-t" : "bad-t" },
      { label: "Composer", value: s.composerFound ? "Tìm thấy" : "Chưa thấy", cls: s.composerFound ? "ok-t" : "warn-t" },
      { label: "Nút model", value: s.modelButtonFound ? "Tìm thấy" : "Chưa thấy", cls: s.modelButtonFound ? "ok-t" : "warn-t" },
      { label: "Models cache", value: s.cachedModels },
      { label: "Tab đang mở", value: (s.userTabs != null ? s.userTabs : "?") + " / " + (s.maxTabs != null ? s.maxTabs : "?") },
    ];
    $("statusGrid").innerHTML = items.map(function (it) {
      var v = it.cls ? "<span class='" + it.cls + "'>" + esc(it.value) + "</span>" : esc(it.value);
      return "<div class='stat'><div class='label'>" + it.label + "</div><div class='value'>" + v + "</div></div>";
    }).join("");

    var perUser = s.perUser || {};
    var users = Object.keys(perUser);
    if (users.length === 0) {
      $("tabsSummary").textContent = "Chưa có user nào dùng tab.";
      $("tabsTable").querySelector("tbody").innerHTML =
        "<tr><td colspan='3' class='muted'>Chưa có user nào dùng tab.</td></tr>";
    } else {
      $("tabsSummary").textContent = users.length + " user đang có tab.";
      $("tabsTable").querySelector("tbody").innerHTML = users.map(function (u) {
        var st = perUser[u];
        var busyHtml = st.busy
          ? "<span class='pill' style='background:rgba(217,160,91,.15);color:var(--warn)'>đang xử lý</span>"
          : "<span class='pill' style='background:rgba(127,176,105,.15);color:var(--ok)'>rảnh</span>";
        return "<tr><td><code>" + esc(u) + "</code></td><td>" + busyHtml +
          "</td><td>" + fmtIdle(st.idleMs) + "</td></tr>";
      }).join("");
    }
  } catch (e) {
    $("statusGrid").innerHTML = "<div class='stat'><div class='label'>Lỗi</div><div class='value bad-t'>" + esc(e.message) + "</div></div>";
  }
}

/* ---------- api keys (Cursor setup) ---------- */
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });
  }
  fallbackCopy(text);
}
function fallbackCopy(text) {
  var ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } catch (e) { /* ignore */ }
  document.body.removeChild(ta);
}

async function loadKeys() {
  try {
    var k = await fetchJson("/admin/keys", { headers: hdr() });
    $("baseUrlTxt").textContent = k.baseUrl;
    var rows = (k.keys || []).map(function (it) {
      return "<tr><td><code>" + esc(it.user) + "</code></td>" +
        "<td><code class='key-copy' data-k='" + esc(it.key) + "' title='Bấm để copy'>" + esc(it.key) + "</code></td>" +
        "<td style='text-align:right'><button class='ghost del-key' data-u='" + esc(it.user) + "'>Xóa</button></td></tr>";
    }).join("");
    $("keysTable").querySelector("tbody").innerHTML = rows || "<tr><td colspan='3' class='muted'>Chưa có key.</td></tr>";
    $("keysTable").querySelectorAll(".key-copy").forEach(function (el) {
      el.addEventListener("click", function () {
        copyText(el.getAttribute("data-k"));
        $("keysHint").textContent = "Đã copy key vào clipboard.";
      });
    });
    $("keysTable").querySelectorAll(".del-key").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var u = btn.getAttribute("data-u");
        // Two-step confirm instead of window.confirm: Chrome auto-dismisses
        // JS dialogs in background tabs (breaks CDP-driven sessions).
        if (btn.getAttribute("data-armed") !== "1") {
          btn.setAttribute("data-armed", "1");
          btn.textContent = "Xác nhận?";
          setTimeout(function () {
            btn.setAttribute("data-armed", "");
            btn.textContent = "Xóa";
          }, 3000);
          return;
        }
        try {
          await fetchJson("/admin/keys/" + encodeURIComponent(u), { method: "DELETE", headers: hdr(false) });
          $("keysHint").textContent = "Đã xóa key '" + u + "'.";
          loadKeys();
        } catch (e) { $("keysHint").textContent = "Lỗi: " + e.message; }
      });
    });
  } catch (e) {
    $("keysHint").textContent = "Lỗi: " + e.message;
  }
}

$("copyUrlBtn").addEventListener("click", function () {
  copyText($("baseUrlTxt").textContent);
  $("keysHint").textContent = "Đã copy Base URL.";
});

$("addKeyBtn").addEventListener("click", async function () {
  var user = $("newKeyUser").value.trim();
  if (!user) { $("keysHint").textContent = "Nhập tên user trước."; return; }
  try {
    var created = await fetchJson("/admin/keys", { method: "POST", headers: hdr(true), body: JSON.stringify({ user: user }) });
    $("newKeyUser").value = "";
    $("keysHint").textContent = "Đã tạo key cho '" + created.user + "'.";
    loadKeys();
  } catch (e) {
    $("keysHint").textContent = "Lỗi: " + e.message;
  }
});

/* ---------- screenshot ---------- */
$("shotBtn").addEventListener("click", async function () {
  $("shotOut").textContent = "đang chụp...";
  $("shotImg").hidden = true;
  try {
    await fetchJson(SHOT_URL, { method: "POST", headers: hdr(true) });
    // <img src> cannot send Authorization headers, so fetch the PNG as a
    // blob with the key attached and use an object URL instead.
    var res = await fetch(SHOT_FILE_URL, { headers: hdr(false) });
    if (!res.ok) throw new Error("HTTP " + res.status);
    $("shotImg").src = URL.createObjectURL(await res.blob());
    $("shotImg").hidden = false;
    $("shotOut").textContent = "xong";
  } catch (e) {
    $("shotOut").textContent = "Lỗi: " + e.message;
  }
});

/* ---------- init ---------- */
(async function init() {
  await pingHealth();
  setInterval(pingHealth, 8000);
  await loadModels(false);
  $("chatInput").focus();
})();
</script>
</body>
</html>`;
}
