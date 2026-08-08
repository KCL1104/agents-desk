# 路線圖:研究落地的收尾與 Tier 3

> 2026-08 · 本文件是跨 session 的續作錨點:現況、剩餘工作、每項的關鍵技術事實。
> 完成一項就把該節的狀態改掉;新的決策寫進對應的決策文件,不寫這裡。

## 現況

- main = 研究報告 + 六批實作 + checkpoints 決策文件(至 `5b6d3ad`),工作分支 `claude/research-popular-tool-frontend-fax4cb` 與 main 同步。
- 驗證基線:Playwright 242 passed(沙箱跑法:`npx playwright test --config playwright.local.config.ts`,指向預裝 Chromium)、cargo 全綠(容器已裝 GTK/WebKit dev 套件)、`npm run build` 乾淨。
- 慣例備忘:i18n 是雙語 typed catalog,兩語相同的字串要進 `i18n.spec.ts` 的 SHARED 豁免;每個新 Tauri 指令都要在 `tests/mock-tauri.ts` 補 handler;凡動 agent 看得到的 git 狀態(index、worktree、分支)一律禁止。

## 第八批:收尾(狀態:**進行中**)

報告 Tier 1/2 的漏網項,一次清完:

1. **#13 側欄重分組**:等你(=NEEDS_YOU,與 ⚠ 徽章同義)/ 開發中 / 待命(idle 獨立成區)/ 已完成——修掉「idle 在等待輸入區卻不進徽章」的矛盾;等你區排最上。
2. **#14 世界分組**:Overview 在多世界時以 host 分組(`hostLabel` 已在 board.ts)。
3. **#15 無狀態訊號 chip**:非 Claude 的 session 卡片戴淡色「不回報狀態」——hooks 只有 claude 有,「安靜」不能被讀成「沒事」。
4. **#23 鍵盤補洞**:⌘I 開抽屜後給焦點一個進 diff 的落點;pane Splitter 兌現 `role=separator` 的方向鍵承諾;看板欄內 ⌘↑/↓ 排序。註:armed 二擊按鈕的 Enter 原生可用,無需另做 y 鍵。
5. **a11y 殘項**:側欄區段頭 aria-expanded;tab strip 的 tablist aria-label。
6. **README 更新**(en + zh-TW):新能力入冊——unseen 層、面板、coach marks、首啟、通知偏好、下一步建議、diff 升級、shell、peek、佇列 follow-up、branch picker、時間軸。

## Tier 3(依序執行)

### 1. Checkpoints v1(狀態:**待做**,決策文件已定案於 `checkpoints.md`)

四個未決採用文件內建議:Stop 快照**預設開**(環境面板可關)、**全留終局清**、手動檢查點**不具名**、大 repo/WSL 成本在第一片完成後量測一次再繼續。切片:

1. `HostRef::run_with_env`(已查證現無此能力;WSL/SSH 的 `env K=V` 前綴管線沿用 pty spawn 的做法)
2. Stop 觸發快照 + 手動按鈕:臨時 index(`GIT_INDEX_FILE`)`add -A` + `write-tree` + `commit-tree` → `refs/agentdesk/checkpoints/<attempt>/<n>`;掛在 Router `turn_done`(seam 已存在,佇列 follow-up 在用);終局刪 refs + 啟動孤兒清掃
3. 時間軸還原 UI:prompt 列旁「還原到此輪之前」;還原前自動快照現在;僅 stopped/idle/exited 可還原,執行中拒絕附全文理由;只還原程式碼永不碰對話
4. 「與檢查點比較」diff 檢視(現有渲染換 base sha)

### 2. 視覺系統批(狀態:待做;適合配 `/impeccable polish`)

型階與間距階 token 化;unicode 字形圖示 → 內嵌 SVG;動效字彙(執行中卡片微光 + 空板 CTA,皆掛 reduced-motion);merged 專色;招牌元素(呼吸卡)命名。另收:diff 語法上色(app 端渲染,哲學安全)。

### 3. 其後各項:先決策文件、拍板、再實作

- **Parked 暫停態**(CS pause/checkout + Conductor archive):凍結 session、留分支、釋放 worktree 與併發槽;`--continue` 恢復;pause 時分支名進剪貼簿。
- **內嵌 dev-server 預覽 + inspect mode**(VK):M6 已有 port 配發;iframe/webview 面板;inspect 抽 component/file/line 經 bracketed paste 入 TUI。
- **可編輯 diff**(Crystal):working-tree 側可編輯,凍結 diff 唯讀;用 CodeMirror 6 merge view,不用 Monaco。
- **Cost/context 顯示**:唯一誠實來源是 `~/.claude/projects/` transcript JSONL(hooks 無 token 資料,已驗證);不做即時 ticker;不內建價目表。
- **終端規模化(先量測再決策)**:WebGL context 上限(每 pane 一個 `WebglAddon`,WebView 約 8–16 個)、SearchAddon、WebLinksAddon、scrollback 落盤。

## 遠期(記錄,不排程)

遠端 companion(UiSink seam)、PR 狀態唯讀 chip、Spotlight 式同步到主 checkout(觸碰使用者 checkout,需明確安全設計)。
