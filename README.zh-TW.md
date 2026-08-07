# AgentDesk

[English](README.md) · **繁體中文**

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
- **收尾與併發**（M4）：`合併回 base`、`push + 開 PR`、`丟棄` 三顆按鈕。
  同時執行數有上限（預設 3），超過的卡片排隊，額度一放出來自己起跑
- **檢視迴圈**（M5）：在變更抽屜裡點 diff 的某一行、附上意見，整批一次
  送回還開著的 session —— 走 session 自己的終端機（bracketed paste），
  所以多行意見是**一則**訊息，時間軸也記下實際問了什麼。沒實測過輸入慣例
  的 CLI 拿到的是「複製」而不是「送出」，跟首則 prompt 同一套誠實。
  另外：合併某個 attempt 時，同卡其他還開著的 attempt 自動標為「已被取代」，
  diff 凍結保留，方便事後比較兩個 agent 的做法
- **Workspace scripts**（M6）：新開的 worktree 只是個 checkout，不是能跑的
  工作區。repo 裡放 `.agentdesk/config.json` 就能讓它自己長成一個：`setup`
  在 agent 起跑前執行、跑在同一個終端機裡，輸出跟失敗都在你正在看的地方；
  `run` 的每一項變成抽屜裡的 ▶ 按鈕，在該 attempt 自己的 worktree 裡開
  dev server 或 test watcher，`$AGENTDESK_PORT` 帶一個沒人占用的埠；
  `archive` 在 worktree 被收回之前執行。每個 script 都看得到
  `$AGENTDESK_ROOT_PATH` —— worktree 是從哪個 repo 開出來的，`.env` 這類
  沒進版控但值得複製的檔案就在那。另外，一個看板本來就可以放多個 repo 的
  卡片，現在每張卡會標出自己的 repo 與 base 分支
- **權限模式**（M7）：每個 attempt 可以選 Claude Code 要照常詢問、自動接受
  檔案編輯（`--permission-mode acceptEdits`），或全自動不再詢問
  （`--dangerously-skip-permissions`）。安全論證就是 worktree —— attempt
  只花得掉自己的分支，碰不到你的 checkout —— 所以這個選項只存在於
  attempt，臨時 session 永遠沒有。模式在開始對話框核准一次，排隊與
  resume 都會沿用；session 全自動跑著的時候，卡片會掛 ⚡ 徽章
- **中英雙語**：跟隨系統語言，也可以在環境面板手動切換。系統原生通知會跟著一起換

尚未做：系統匣。

---

## 讓 worktree 開箱能跑

在 repo 放一個 `.agentdesk/config.json`，每個 attempt 的 worktree 就會自己
準備好：

```json
{
  "setup": "npm install && cp \"$AGENTDESK_ROOT_PATH/.env\" .env",
  "run": [
    { "name": "dev", "command": "npm run dev -- --port $AGENTDESK_PORT" },
    { "name": "test", "command": "npm test -- --watch" }
  ],
  "archive": "docker compose down"
}
```

Script 都走 `sh -c`，寫法跟在終端機打一行一樣。檔案格式錯誤會讓 attempt
在對話框裡就開不起來，而不是安靜地什麼都不做 —— 一個安靜失效的設定檔，
跟一個壞掉的 worktree 從外面看是分不出來的。（目前僅支援 POSIX 平台。）

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
cd src-tauri && cargo test      # 107 個：PTY、hooks、worktree、attempt、timeline、queue、migration、規則、儲存
npm --prefix ui run test:e2e    # 125 個：Playwright，前端 + 看板 + 檢視抽屜 + 佇列 + xterm 渲染
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
- `store.rs` 的 migration 段 —— 三條升級路徑各一個測試：**沒有版本號但已經有
  `completed` 的舊 DB**（這條沒處理好會讓每個既有安裝都開不起來）、更舊的沒有
  `completed`、以及從上一版正常升級且資料不掉
- `ui/tests/queue.spec.ts` —— 排隊的卡片會自己起跑（沒有人按任何東西），
  以及會弄丟工作的合併必須被擋下來並把原因講完
- `ui/tests/board.spec.ts` —— 兩軸真的成立：卡片留在原欄位不動，燈號自己從
  「等你確認資料夾」→「執行中」→「⚠ 等你授權」變化；點下去之後 **`document.
  activeElement` 真的落在那個 pane 裡面**，不只是 pane 有 focused class。
  拖曳測試把四個 drag 事件在同一個 tick 內送完，比真實拖曳更嚴格 ——
  這樣「靠 React state 剛好 render 完才會過」的實作會當場失敗
- `ui/tests/i18n.spec.ts` —— 沒選過語言時跟隨系統、選過就以選的為準、切換當下就
  重繪且重開仍在，以及語言確實有送到後端讓原生通知跟著換

兩個會去驅動真的 `claude` 的測試（`tests/hooks.rs` 與 `tests/prompt_injection.rs`）
在沒有登入好的 CLI 時會自己跳過。**只檢查 `PATH` 上有沒有是不夠的** —— 沒登入過的
CLI 會停在歡迎畫面、永遠不會開始一個 session，於是測試會把整個 timeout 燒完，只
證明了「這台機器沒登入」。所以改成去讀 Claude Code 自己的 `~/.claude.json` 裡的
`hasCompletedOnboarding`。那個 key 哪天換了位置的話，這些測試會變成「跳過」而不是
「錯誤地通過」，而且會在 stderr 說明原因。要強制跑就 `AGENTDESK_TEST_ASSUME_CLAUDE=1`。

---

## 發佈

三個平台的安裝檔由 GitHub Actions 產生（`.github/workflows/release.yml`）。

發版是一個按鈕加一個決定：**Actions → Release → Run workflow → 選 `bump`** ——
`patch` 修 bug、`minor` 加功能、`major` 破壞相容。run 會自己算下一版、寫進
`tauri.conf.json`、`Cargo.toml`、`Cargo.lock`、`package.json` 四個檔案、commit 回
`main`，再從那個 commit 建四平台並發佈。沒有人手動維護版本號，所以它每一版
**必然**會動。

接著：建 draft release → 四個平台平行 build → **全綠才把 release 轉正**。
有平台掛掉就停在 draft，不會出半套。版本號 guard 仍守著手動路徑：推 tag（或
dispatch 填明確的 `tag`）時，tag 跟 `tauri.conf.json` 不一致就直接失敗，免得
`v0.2.0` 的 release 裡掛著一堆 `AgentDesk_0.1.0_*`。明確 `tag` 也是失敗重跑的
路徑 —— bump commit 已經落地但發佈失敗時，用已經燒掉的那個 tag 重發，
不要再 bump 一次。

### nightly build

每次 push 到 `main` 都會跑同一套四平台 build，並發佈到一個 tag 為 `nightly` 的
滾動 prerelease，蓋掉上一份。所以 `main` 的最新版本永遠一個連結就拿得到，不用等
誰去發版：

    https://github.com/KCL1104/agents-desk/releases/tag/nightly

它是 prerelease，而且**永遠不會被標成 latest** —— 不會擠掉正式版在 repo 首頁與
release API 上的位置。有平台失敗的話，那份 draft 會被丟掉、上一份 nightly 留著，
不會出半套。build 途中又有新 commit 進來會直接取代它（只有最新的產物有意義），
但 tag 的 build 永遠不會被取消。

這也是為什麼 `ci.yml` 不再打包 —— 它以前每次 push 到 main 都建三個平台，然後
整包丟掉。

沒有任何發版路徑會用 git 推 tag：tag 一律由 GitHub 在 release 發佈時建在
build 的那個 commit 上，跟 nightly 的 tag 同一套機制。兩個輸入都留空則只 build：
產物掛在該次 run 的 artifacts 底下，不碰任何 release。其實每次 run 都會掛，
所以正式版與 nightly 的 build 也都能直接從 run 裡下載。

| 平台 | runner | 產物 |
| --- | --- | --- |
| Linux x86_64 | `ubuntu-22.04` | `.deb`、`.rpm`、`.AppImage` |
| macOS Apple Silicon | `macos-15` | `.dmg`、`.app` |
| macOS Intel | `macos-15-intel` | `.dmg`、`.app` |
| Windows x86_64 | `windows-latest` | `.msi`、NSIS `.exe` |

Linux 建在 22.04 而不是 24.04：glibc 與 WebKit 只往前相容，24.04 建出來的東西在
22.04 上跑不起來。`macos-15-intel` 是 Actions 最後一版 x86_64 的 macOS image，
2027 年 8 月退役 —— 到那時候 Intel 那一列就得拿掉。

`.deb` / `.rpm` 的相依只有一半會自己長出來：bundler 會去讀執行檔實際連到的 so，
把 `libwebkit2gtk-4.1-0`、`libgtk-3-0` 補進去。**但 `git` 不會** —— 它是用
`Command::new("git")` 在執行期叫的，不是連進去的函式庫，掃不到。所以那一條寫在
`tauri.conf.json` 的 `bundle.linux.deb.depends` 裡，漏了的話裝得起來、開下去
worktree 就爛掉。`gh` 放在 `recommends`（只有開 PR 那條路徑會用到）。

### 沒有簽章

repo 裡沒有任何簽章金鑰，所以三個平台的產物都是未簽章的。使用者第一次開會被系統擋：

- **macOS** —— Gatekeeper 會說「已損毀，無法打開」。不是真的壞掉，是 quarantine
  屬性：

  ```bash
  xattr -dr com.apple.quarantine /Applications/AgentDesk.app
  ```

- **Windows** —— SmartScreen 藍色視窗，「更多資訊」→「仍要執行」
- **Linux** —— 不擋

要正式簽章的話，把 `APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、
`APPLE_SIGNING_IDENTITY`、`APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID` 加進 repo
secrets，然後在 `release.yml` 的 build step 上把它們接成 `env` —— 那裡有註解標了位置。

**刻意不預先接好。** bundler 判斷「要不要簽」看的是 `APPLE_CERTIFICATE`
**存不存在**，空字串也算存在，它不會去檢查有沒有值。所以在一個沒有這些 secrets 的
repo 裡去引用它們，等於把變數設成 `""`，兩個 macOS job 就會死在
`failed codesign application: failed to import keychain certificate`。
要加就跟真正的 secrets 同一次加，不要提前。

### icon

`src-tauri/icons/` 底下的 `.ico`、`.icns` 與各尺寸 PNG 都是 commit 進來的，不是 CI
現產。Windows 要 `.ico`、macOS 要 `.icns`，少一個那個平台就打不出安裝檔。要換圖時：

```bash
npm run tauri -- icon path/to/new-icon.png
```

它的輸出目錄預設就是 `src-tauri/icons/`，而且**會連來源的 `icon.png` 一起覆寫**。
想留著原圖就先 `-o` 到別的地方，再把需要的檔案搬回來。

---

## CI

`.github/workflows/ci.yml`。push 到 main 與所有 PR 都會跑：Rust `cargo test`、
前端 typecheck + build + Playwright、sidecar typecheck + build。**只管正確性** ——
打包是 release.yml 的事，而且 push 到 main 那一輪會產出真的能下載的安裝檔，而不是
建完就刪掉。

`cargo fmt` 與 `clippy` **不擋 CI**，只把結果印出來 —— 現在這棵樹還不是
rustfmt-clean，把整棵樹重排是另一件事，不該跟接 CI 綁在一起。

`npm run smoke` 沒有進 CI：它會真的開一個 Claude Code session，需要憑證。

---

## 語言

介面有英文與繁體中文兩種。

開啟時跟隨系統語言 —— 任何 `zh*` 的 locale 給中文，其餘給英文 —— 左下角的環境面板
裡有切換器。在那裡選過之後，選擇一律蓋過系統設定，而且跨重啟保留。

決定權在 webview，並透過 `set_locale` 往下推給 Rust，所以那少數幾個由 OS 而不是
webview 繪製的字串 —— 原生通知的標題與內文 —— 會跟著一起換。與其讓兩套偵測規則
各自判斷、然後可能不一致，不如只留一套、另一邊照著做。

介面字串在 `ui/src/i18n/messages.ts`。**英文是真相來源**：它的 key 定義出
`MessageKey` 型別，中文那份被定成「對這個型別的全對映」，所以只加一邊、忘了另一邊
會直接 typecheck 失敗，而不是靜靜地在畫面上印出一個 raw key。Rust 自己要講的那幾句
在 `src-tauri/src/i18n.rs`。

程式碼註解**刻意留中文**。那是寫給維護的人看的，不是給使用者看的，而且裡面裝的
理由是這個 repo 最值錢的東西 —— 翻它跟「讓產品雙語」是兩件不同的事。

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

- 收尾就到「合併」與「開 PR」為止。PR 的 review、留言、CI 紅綠、合併按鈕都不做 ——
  那是另一個大得多的工具，硬做只會把這裡最深的東西稀釋掉

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
