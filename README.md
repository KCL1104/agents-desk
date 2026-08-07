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
- **任務與 attempt**（M1）：一張卡可以開多個 attempt，每個 attempt 有自己的
  git worktree 與分支，同一個 repo 上的兩個 agent 互不干擾。收尾時 diff 先
  凍結進資料庫，再把 worktree 還回去
- **看板**（M2）：四欄、卡片可拖曳。卡片會自己呼吸 —— 待在「進行中」欄位裡
  亮起「⚠ 等你授權」，點下去直接進那個 session 的 TUI 且游標已在裡面。
  另有臨時 session 區（看板之外，沒有 worktree 也沒有生命週期）
- **變更與活動**（M3）：TUI **旁邊**的抽屜，不進終端機就能說出這個 attempt
  改了什麼（含未 commit 與新建檔）、做了什麼（工具名 + 參數的時間軸）。
  hook 事件從「算完徽章就丟掉」改成落進 `attempt_events`

尚未做：merge / PR 按鈕、併發佇列、系統匣。

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
cd src-tauri && cargo test      # 92 個：PTY、hooks、worktree、attempt、timeline、migration、規則、儲存
npm --prefix ui run test:e2e    # 112 個：Playwright，前端 + 看板 + 檢視抽屜 + xterm 渲染
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
- `tests/prompt_injection.rs` —— 在一個真的、沒被信任過的新 worktree 裡跑真的
  `claude`，數 `UserPromptSubmit` hook 觸發幾次。多行 prompt 必須是**一則**訊息，
  不是一行一則
- `tests/worktree.rs` —— 對真的 git：兩個 attempt 看不到彼此的檔案、各自的
  base_sha 不會互相飄移、worktree 收得回來、分支留著
- `tests/attempts.rs` —— 整條 core 流程，agent 用替身而不是真的模型：驗的是
  AgentDesk 做了什麼（開哪個 worktree、命令列長什麼樣、記了什麼、還了什麼），
  這些都不需要模型回答。替身的 log 是 NUL 分隔的 —— 用一行一個參數會分不出
  「一個含換行的參數」和「好幾個參數」，而那正是這裡要驗的東西
- `tests/attempts.rs` 的時間軸段 —— 完整鏈路：hook listener → router → channel →
  writer thread → SQLite。同時釘住「不該記的不要記」：連續三次 `running` 只留
  工具呼叫，不留三行狀態
- `ui/tests/board.spec.ts` —— 兩軸真的成立：卡片留在原欄位不動，燈號自己從
  「等你確認資料夾」→「執行中」→「⚠ 等你授權」變化；點下去之後 **`document.
  activeElement` 真的落在那個 pane 裡面**，不只是 pane 有 focused class。
  拖曳測試把四個 drag 事件在同一個 tick 內送完，比真實拖曳更嚴格 ——
  這樣「靠 React state 剛好 render 完才會過」的實作會當場失敗

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

（另外三個關於 worktree 與首則 prompt 的實測結果，見下面「任務與 attempt」。）

---

## 任務與 attempt

`Task 1 ─ N Attempt 1 ─ 1 Session`。Attempt 是「用某個 agent 試做這張卡的一次
嘗試」，帶自己的 worktree 與分支；換 agent 重跑就是開新的 attempt。

狀態分兩軸，而且**軸二絕不自動驅動軸一**：

| 軸 | 內容 | 誰決定 |
|---|---|---|
| 一・任務生命週期 | `backlog → running → review → done` / `abandoned` | 只有人，用拖的 |
| 二・session 即時狀態 | 執行中 / ⚠等你授權 / ⚠等你回覆 / ⚠等你確認資料夾 / 待命 / 結束 | hook 回報 |

沿用 `store.rs` 既有的 `completed` 立場：`Stop` 只代表這一輪結束，不代表事情
做完了，所以沒有任何 hook 能搬動卡片。

worktree 放在 `~/.agentdesk/worktrees/<repo>-<hash>/<slug>-<n>/`，**不放在 repo
旁邊** —— repo 的上層目錄很常自己也是一個 repo（傘狀 workspace），worktree 放
進去就變成巢狀 repo，所有往上找 `.git` 的工具都會開始給出不一樣的答案。也不放
在 application support 底下：這是人會想 `cd` 進去、用編輯器打開、在裡面跑 build
的工作目錄，「打得出來的路徑」比「整齊」值錢。

又三個實測出來、文件沒寫的事實（`tests/prompt_injection.rs` 釘住）：

4. **位置參數傳 prompt 不會退化成 print 模式**，`-p` 才會。多行字串經 argv 傳
   進去是**一則**訊息 —— argv 裡的換行是文字，不是 Enter。
5. **新 worktree 一定會撞信任對話框，而且在答完之前什麼都不會跑，`SessionStart`
   也不會。** 所以沒有任何 hook 能回報這個狀態；core 直接標成
   `AwaitingTrust`，它有資格這樣做，因為那個目錄是它前一刻自己建的。少了這個，
   徽章就會漏掉每個 attempt 的第一個狀態。prompt 本身能活過對話框，答完就送出。
6. **`$SHELL -ilc` 會繼承 AgentDesk 自己的環境。** 從 Finder 啟動時那是乾淨的，
   從 Claude Code session 裡的終端機啟動就不是 —— `CLAUDE_CODE_CHILD_SESSION`
   會關掉 transcript 儲存，於是 `--continue` 沒有東西可以接，重開 attempt 會
   無聲地從頭開始。`shell_env` 會把這類 session marker 拿掉，但**只拿掉明確列出
   的那幾個**：`CLAUDE_CODE_*` 底下也住著 `CLAUDE_CODE_USE_BEDROCK` 這種真的使用者
   設定，用前綴一律砍會把別人的環境弄壞。

首則 prompt 只注入 agent 自己發現不了的事：這是為這張卡開的 worktree、分支是
哪個、從哪個 base 開出、commit 在這個分支上。CLAUDE.md / skills / MCP 都會原生
載入，不重複塞。模板在 `<data_dir>/prompt-template.md`，可以改，升級不會蓋掉。
開 attempt 的對話框顯示完整 prompt 且可編輯，送出什麼就記什麼。

非 Claude 的 agent 不自動送 prompt：那些 CLI 的參數慣例沒有實測過，而在某個 CLI
裡代表「這是你的 prompt」的參數，在另一個裡可能代表「印出來然後結束」。猜錯比
不猜更糟，所以 UI 顯示組好的 prompt 讓人一鍵複製。

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
  「執行中 / 已關閉」而已。首則 prompt 也只對 Claude Code 自動送出，其他 agent
  會把組好的 prompt 顯示出來讓你自己貼（見下）
- 第一次在某個目錄開 session 時，Claude Code 會問你信不信任這個資料夾 ——
  這是它原本的行為，刻意不繞過。**每個 attempt 都是新目錄，所以每個 attempt
  都會遇到一次**
- scrollback 不持久化 —— 跟真的終端機一樣。對話歷史由 agent 自己存
  （Claude Code 在 `~/.claude/projects/`），重開時靠 `--continue` 接回去
- **設定 outcome 是終局動作**：worktree 會被移除，所以那個 attempt 不再有活的
  TUI。留下來的是時間軸與一份凍結的 diff。superseded 的 attempt 也一樣 ——
  「保留可回看」指的是唯讀回看，不是還能跳進去打字
- app 一關，所有 PTY 都會死。重啟後 `running` 欄位裡的卡片軸二會是「未執行」，
  要按 resume 才會回來（走 `--continue`，不重送 prompt）
