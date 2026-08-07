# AgentDesk

多個 coding agent session 的桌面管控台。**每個 session 就是一個真的終端機**，
跑真的 `claude`（或 codex / gemini / aider），畫面跟你在 Terminal.app 裡開一模一樣 ——
同樣的 TUI、同樣的 `/` 選單、同樣的權限提示。App 不重繪、不重新詮釋任何東西。

App 提供的是終端機分頁給不了的：多 session 管理、跨重啟的清單、以及
**跟終端機一致的執行環境**（見下方）。

---

## 現況

- PTY session：真的 pseudo-terminal 跑真的 agent CLI，xterm.js 渲染
- login-shell 環境解析：agent 拿到的 PATH 跟你終端機一樣
- SQLite session 清單，跨重啟保留；重開會 `--continue` 接續該目錄的對話
- 多 session 分頁，各自保留 scrollback
- 任意 agent CLI + 任意啟動參數，原封不動傳過去
- **狀態偵測與通知**：靠 Claude Code hooks，不解析 ANSI。左上角會顯示
  「⚠ N 個等你」，被擋住的 session 會發系統通知

尚未做：git worktree 隔離、diff review、系統匣。

---

## 執行

需要 Node 20+、Rust stable，以及你要用的 agent CLI 已安裝並登入。

```bash
npm run setup
npm --prefix ui run dev &                       # vite on :5173
cargo run --manifest-path src-tauri/Cargo.toml
```

`cargo` 若不在 PATH，先 `source ~/.cargo/env`。要永久生效，把這行加進 `~/.zshrc`：

```sh
export PATH="$HOME/.cargo/bin:$PATH"
```

## 測試

```bash
cd src-tauri && cargo test      # 26 個：PTY、hooks、規則、儲存
npm --prefix ui run test:e2e    # 8 個：Playwright，前端 + xterm 渲染
```

macOS 的 WKWebView 沒有 WebDriver，所以 Playwright 是在 Chromium 裡跑同一份 React
樹、搭配 mock 的 Tauri IPC。它涵蓋 IPC 邊界以上的一切 —— session 清單、開新
session 的流程，以及 xterm 對**真實 PTY bytes** 的解碼與渲染。

測試驗的是會決定體驗真偽的性質，不是「有沒有輸出」：

- `tests/pty.rs` —— 子行程在 tty 上（所以 CLI 進互動模式，不是降級的
  non-interactive），以及它拿到的是 login shell 的 PATH 而不是 GUI stub
- `tests/hooks.rs` —— 完整鏈路：PTY → 真的 `claude` → plugin hook → curl →
  HTTP listener，且 session id 正確對應。不需要花錢的 API call
- `ui/tests/fixtures/claude-tui.json` —— 從 PTY 擷取的真實 Claude Code TUI 輸出，
  **刻意從一個多位元組字元中間切成兩塊**。有一個對照測試證明這份 fixture 用
  逐 chunk 解碼確實會壞掉，所以主測試不會「因為錯的理由而通過」

---

## 狀態偵測

多開 session 時你唯一真正需要的資訊是「哪一個在等我」。取得方式是請 Claude Code
自己回報，不是去解析畫面 —— 解析 ANSI 會在 TUI 改版時無聲壞掉。

App 啟動時做兩件事：在 loopback 開一個小 HTTP listener，以及把一份只含 hooks
的 plugin 寫到資料目錄。每個 session 用 `--plugin-dir` 載入它，並注入
`AGENTDESK_SESSION_ID` / `AGENTDESK_HOOK_URL`；hook 是一行 `curl`，把狀態回報回來。

| Hook 事件 | 回報狀態 |
|---|---|
| `SessionStart` / `UserPromptSubmit` / `PreToolUse` | 執行中 |
| `PermissionRequest`、`Notification`(permission_prompt) | **等你授權** |
| `Notification`(idle_prompt) | **等你回覆** |
| `Stop` | 待命 |
| `SessionEnd` | 結束 |

只有「等你授權 / 等你回覆」會發通知與計入徽章 —— 那是 agent 真的被擋住、
沒有你就無法繼續的兩種狀態。

三個實作上的地雷（都是實測出來的，文件沒寫）：

1. **不能用 `--settings` 塞 hooks。** 它會覆蓋同名 key，等於把你自己的 hooks
   整個關掉。plugin hooks 才是附加的。
2. **`"shell": "sh"` 會讓 hook 靜默不觸發** —— 沒有錯誤、沒有回報。`"bash"` 可以，
   不指定也可以。`tests` 有回歸測試釘住這點。
3. **hook 一定要 exit 0。** 退出碼 2 會**擋下**它所在的那個工具呼叫，所以每一行
   都以 `|| true` 結尾 —— app 掛掉絕不能連帶卡死 agent。

---

## 架構

```
Tauri 視窗 (React + xterm.js)
      │  invoke: term_write / term_resize
      │  event:  term:output
Rust 核心  ── PTY registry · session 清單 · SQLite
      │  portable-pty
  claude / codex / … × N
```

核心（`src-tauri/src/core.rs`）不依賴 Tauri，只透過 `UiSink` trait 對外，
之後要加 axum websocket 讓瀏覽器或遠端連進來不必重寫。

### 為什麼要 login-shell 環境解析

從 Finder 或 Dock 啟動的 GUI 程式拿到的是精簡環境：`PATH` 大約只有
`/usr/bin:/bin:/usr/sbin:/sbin`，沒有 nvm/mise/asdf 的 shim、沒有 Homebrew 前綴、
沒有你 export 的 API key。把這種環境交給 coding agent，`npx` 型的 MCP server 起不來，
常常連 agent 本身都找不到。

`shell_env.rs` 啟動時跑一次 `$SHELL -ilc 'env -0'`，用你自己 shell 的環境去生所有
session。左下角「環境」面板會顯示解析結果，降級時也會明講。

### 終端機輸出是 bytes，不是字串

PTY 的讀取邊界落在核心決定的位置。在 Rust 端對每個 chunk 做 UTF-8 解碼，
會把任何跨越邊界的多位元組字元換成 U+FFFD —— 而 TUI 滿是 3 bytes 的框線字元，
畫面就會沿著 chunk 邊界裂開。所以輸出以 base64 傳遞，交給 xterm 自己有狀態的
解碼器把邊界縫回去。

同理，`lineHeight` 必須正好是 1。大於 1 會在列與列之間留下空隙，框線字元
就接不起來。

### PTY 開始輸出的時間早於 pane 掛載

PTY 一 spawn 就開始吐 bytes，但顯示它的 pane 要等下一次 render 才存在。中間的
輸出 —— 對 Claude Code 來說是整個開場畫面 —— 就會發給沒有人，pane 一片空白。

所以 Rust 端為每個 session 保留一份有上限的 scrollback 與序號。pane 掛載時：
先訂閱（才不會漏），再取快照，然後寫入快照、接著只重播序號比快照新的即時 chunk。
順序反過來會漏掉中間的；不比對序號則會寫兩次。

### 為什麼是 PTY 而不是 Agent SDK

先做過 SDK 版本：結構化事件、原生訊息串與工具卡片、`canUseTool` 攔截權限請求
彈原生對話框。功能更多，但**畫面就不是終端機了**。既然目標是「跟終端機一樣」，
PTY 是唯一能保證這件事的做法 —— TUI 自己畫，我們只負責把 bytes 搬過去。

SDK 版本的程式碼收在 `src-tauri/parked/`（Node 那半在 `sidecar/`），沒有刪掉。
如果之後需要「攔截」而不只是「承載」工具呼叫 —— 例如無人值守的背景模式或政策層 ——
那份程式碼是可用的起點。

---

## 已知限制

- 狀態偵測只對 Claude Code 有效。其他 CLI 沒有等價的 hook 機制，會顯示為
  「執行中 / 已關閉」而已
- 第一次在某個目錄開 session 時，Claude Code 會問你信不信任這個資料夾 ——
  這是它原本的行為，刻意不繞過
- scrollback 不持久化 —— 跟真的終端機一樣。對話歷史由 agent 自己存
  （Claude Code 在 `~/.claude/projects/`），重開時靠 `--continue` 接回去
- 沒有 worktree 隔離：session 直接在你選的目錄上跑
