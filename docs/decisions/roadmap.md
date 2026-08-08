# 路線圖:研究落地的收尾與 Tier 3

> 2026-08 · 本文件是跨 session 的續作錨點:現況、剩餘工作、每項的關鍵技術事實。
> 完成一項就把該節的狀態改掉;新的決策寫進對應的決策文件,不寫這裡。

## 現況

- main = 研究報告 + 六批實作 + checkpoints 決策文件(至 `5b6d3ad`),工作分支 `claude/research-popular-tool-frontend-fax4cb` 與 main 同步。
- 驗證基線:Playwright 262 passed(沙箱跑法:`npx playwright test --config playwright.local.config.ts`,指向預裝 Chromium)、cargo 331 全綠(容器已裝 GTK/WebKit dev 套件)、`npm run build` 乾淨。
- 慣例備忘:i18n 是雙語 typed catalog,兩語相同的字串要進 `i18n.spec.ts` 的 SHARED 豁免;每個新 Tauri 指令都要在 `tests/mock-tauri.ts` 補 handler;凡動 agent 看得到的 git 狀態(index、worktree、分支)一律禁止。

## 第八批:收尾(狀態:**完成**)

報告 Tier 1/2 的漏網項,一次清完:

1. **#13 側欄重分組**:等你(=NEEDS_YOU,與 ⚠ 徽章同義)/ 開發中 / 待命(idle 獨立成區)/ 已完成——修掉「idle 在等待輸入區卻不進徽章」的矛盾;等你區排最上。
2. **#14 世界分組**:Overview 在多世界時以 host 分組(`hostLabel` 已在 board.ts)。
3. **#15 無狀態訊號 chip**:非 Claude 的 session 卡片戴淡色「不回報狀態」——hooks 只有 claude 有,「安靜」不能被讀成「沒事」。
4. **#23 鍵盤補洞**:⌘I 開抽屜後給焦點一個進 diff 的落點;pane Splitter 兌現 `role=separator` 的方向鍵承諾;看板欄內 ⌘↑/↓ 排序。註:armed 二擊按鈕的 Enter 原生可用,無需另做 y 鍵。
5. **a11y 殘項**:側欄區段頭 aria-expanded;tab strip 的 tablist aria-label。
6. **README 更新**(en + zh-TW):新能力入冊——unseen 層、面板、coach marks、首啟、通知偏好、下一步建議、diff 升級、shell、peek、佇列 follow-up、branch picker、時間軸。

## Tier 3(依序執行)

### 1. Checkpoints v1(狀態:**完成**,四片全落地;決策文件與實測記錄在 `checkpoints.md`)

四個未決採用文件內建議:Stop 快照**預設開**(環境面板可關)、**全留終局清**、手動檢查點**不具名**、大 repo/WSL 成本在第一片完成後量測一次再繼續。切片:

1. ✅ `HostRef::run_with_env`(extra 疊在 carried 之後,同鍵後者勝;本地雙次 envs,WSL/SSH 走 `env K=V` 前綴)
2. ✅ Stop 觸發快照 + 手動按鈕:臨時 index(`GIT_INDEX_FILE=<worktree gitdir>/agentdesk-checkpoint.index`,續用可吃 stat cache)`add -A` + `write-tree` + `commit-tree`(parent = 前一檢查點或 base_sha,identity 固定 AgentDesk)→ `refs/agentdesk/checkpoints/<attempt>/<n>`;掛在 Router `turn_done`,worker 執行緒離開 hook 路徑,`checkpointing` set 防併發;同 tree 不產 ref;終局 `clear_checkpoints`(對主 checkout 跑)+ 啟動孤兒清掃(僅本地 repo,遠端等下次終局);`checkpoints:changed` 事件已發;env 面板開關(`checkpoints_on`,預設開)+ 抽屜 ⚑ 手動 chip(所有 agent)
3. ✅ 時間軸還原 UI:prompt 列 ↩(兩擊確認,執行中 disabled 附理由 title,對應檢查點 = prompt 前最後一個快照、否則 base n=0);`restore_checkpoint(attempt, n)` 先自動快照再 `git restore --source --worktree -- :/` + 刪快照外檔案(index 永不碰,`remove_file` host helper);還原與快照共用 `checkpointing` claim 防夾到半還原樹;banner 供 claude「告訴 agent」預組訊息走 sendFollowup,送不送由人
4. ✅ 「與檢查點比較」diff 檢視:`attempt_diff` 增選用 `n`(`attempt_diff_from`,0/None = base),Changes 分頁在有檢查點時出 baseline select;DiffPane key 帶上 baseline,fold 狀態不跨比較沿用

量測已完成(本機 2 萬檔:暖快照 ~0.04s ≈ 2× `git status`;WSL 未測,缺口記於 checkpoints.md 成本節)。

### 2. 視覺系統批(狀態:**完成**,經 `/impeccable polish`)

- **Token 化**:型階七階(`--fs-micro`…`--fs-hero`,87 個字級全數收編;藥丸形狀改 999px 不佔階)、圓角四階(既有 `--radius` 首次真正被使用)、檢視器共用溝距 `--gutter-x`。間距其餘值為逐面光學調校,刻意不上階(硬套會是 redesign 不是 polish)。
- **圖示**:`Icon.tsx` 內嵌 SVG(warn/bolt/pencil/flag/play/dot/reload/wrap),一種筆畫一種粗細;標點類字形(✕ ＋ ✓ ▸ ⎇ →)刻意留為文字——它們讀起來是字。全部 aria-hidden,語意都在旁邊的文字或 label 上。
- **動效字彙**:呼吸(breathe)正式命名為招牌——唯一 attention 級動效;shimmer(執行中卡片的 status edge 微光)是安靜的表親,blocked 時讓位給呼吸;空板 CTA(beckon)把待辦空位變成真按鈕。三者皆掛 reduced-motion 靜態收尾。
- **merged 專色**:`--merged = color-mix(accent 55%, err 45%)`,CSS 層推導所以自訂主題免改 theme.ts;只有 merged 上色(discarded/superseded 保持中性——放棄不是要宣傳的狀態)。
- **diff 上色**:`tint()`(review.ts)只認字串與註解——所有語言都同意的兩類,靠形狀就找得到;從 currentColor 混色所以 add 行的字串還是綠的。守門:`://` 不開註解、`#` 要跟空格、`/* */` 行內閉合會放回後面的程式碼;runs 恆等拼回原文(excerpt 比對依賴)。
- 測試連動:board-cta 使 `新增卡片` 按鈕名撞名,全部 helper 改 `exact: true`(15 檔 26 處)。

### 3. 其後各項:先決策文件、拍板、再實作

- **Parked 暫停態**(CS pause/checkout + Conductor archive):凍結 session、留分支、釋放 worktree 與併發槽;`--continue` 恢復;pause 時分支名進剪貼簿。
- **內嵌 dev-server 預覽 + inspect mode**(VK):M6 已有 port 配發;iframe/webview 面板;inspect 抽 component/file/line 經 bracketed paste 入 TUI。
- **可編輯 diff**(Crystal):working-tree 側可編輯,凍結 diff 唯讀;用 CodeMirror 6 merge view,不用 Monaco。
- **Cost/context 顯示**:唯一誠實來源是 `~/.claude/projects/` transcript JSONL(hooks 無 token 資料,已驗證);不做即時 ticker;不內建價目表。
- **終端規模化(先量測再決策)**:WebGL context 上限(每 pane 一個 `WebglAddon`,WebView 約 8–16 個)、SearchAddon、WebLinksAddon、scrollback 落盤。

## 遠期(記錄,不排程)

遠端 companion(UiSink seam)、PR 狀態唯讀 chip、Spotlight 式同步到主 checkout(觸碰使用者 checkout,需明確安全設計)。
