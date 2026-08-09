# 決策文件:可編輯 diff(working-tree 側就地改)

> 狀態:**提案,待決** · 2026-08 · 來源:前端研究報告 Tier 3(Crystal 的可編輯 diff)
> 參照:Crystal(機制為研究報告轉述:working-tree 側可編輯、歷史唯讀)

## 問題

review 迴圈最常見的收尾是一個小修:typo、多餘的 log、一行命名。今天這一步有兩條路,都貴:離開桌子開編輯器找到那個 worktree 裡的那個檔;或者叫 agent 改——一輪對話的成本買一行變更,還要等。diff 就在眼前、檔案就在盤上,中間卻隔著一整段導航。Crystal 的答案是對的:**看到哪裡改哪裡**。

## 已經存在的東西(不要重做)

| 機制 | 涵蓋 | 缺口 |
|---|---|---|
| AttemptInspector 的 diff(fold、viewed、留言、tint) | 讀的體驗完整 | **唯讀**;資料模型是 unified patch 字串,不是可編輯的兩側全文 |
| `HostRef::read_to_string` / `write_file`(host.rs 已查證) | host 透明的檔案讀寫,Local/WSL/SSH 一條路 | 未曝露為 Tauri 指令 |
| worktree.rs 的 git 管線 | — | 沒有「某個 rev 的檔案內容」(`git show <sha>:<path>`) |
| restore 的 settled 守門 + 「告訴 agent」預組訊息 | **人動地的先例與規矩已立**:回合中拒絕、動完把話遞到手上、送不送由人 | — |
| 凍結 diff | 終局的唯讀紀錄 | 本來就不該可編輯——這是邊界,不是缺口 |
| Modal 的 dirty 守門 | 「打了字的東西不被誤點毀掉」慣例 | 編輯器要接上同一條 |

## 設計空間與判定

### 哲學:人改自己的 repo,不是 app 改 agent 的狀態

「絕不碰 agent 看得到的東西」管的是 **app 自作主張**(index、分支、快照都走旁路)。人在自己的 repo 裡改檔案,用任何編輯器都改得到——app 只是把導航省掉,這不是哲學例外。但 restore 立下的兩條規矩原樣沿用:

1. **Settled 才能改**:agent 回合進行中拒絕(同一個 busy 判定、同一種附完整理由的拒絕)——從正在寫檔的 agent 腳下改檔案,和抽走檔案是同一種傷害。存檔指令在 core 層**再驗一次**,不只靠 UI 藏按鈕——UI 守門會過期。
2. **改完把話遞到手上**:存檔後提供「告訴 agent」預組訊息(「我手動改了 {file},重讀後再繼續」),走既有 bracketed paste,僅 claude,送不送由人。

**凍結 diff 永遠唯讀**——它是紀錄,不是文件。parked 同樣拒絕(沒有地可改)。

### 編輯器:CodeMirror 6 merge view,不用 Monaco,也不用手刻

- **否決 Monaco**:~5MB、worker 基建、AMD 包袱——為了改幾行 typo 把 VS Code 搬進來,是用重量買臉熟。
- **否決手刻**(contenteditable + 自己 diff):undo 堆疊、IME(中文輸入!)、選取模型——這是編輯器的本業,手刻是不誠實的工程量。
- **採用 `@codemirror/merge`**(+ `state`/`view` 核心):模組化、無 worker、原生支援 unified 檢視且單側可編輯。這會是 UI 第一個真正的第三方 UI 依賴(現在只有 xterm 和 React),bundle 約 +300KB——值得,而且只值得這一次。
- **不裝 language packages**:與 diff tint 同一條哲學——不假裝懂每個語言。v1 純文字編輯,tint 的字串/註解質感是「讀」的事,編輯態交給 CM 的預設。

### 資料模型:per-file 兩側全文,不是 patch

新指令兩顆:

- `attempt_file(attempt_id, path) -> { base: Option<String>, work: Option<String> }`——base 側 `git show <base_sha>:<path>`(新檔 → None),work 側 `read_to_string`(已刪 → None)。凍結/parked 拒絕。
- `write_attempt_file(attempt_id, path, contents)`——`write_file`,**core 層 settled 守門**,成功後 emit 讓 stats 下一輪 tick 自然刷新。

比較基準固定對 base_sha:checkpoint 基準下「編輯」的語義混亂(改的是現在,比的是過去的過去),不做。二進位檔(diff 已標 binary)不出編輯鈕。

### UI:檔案就地展開成編輯器,存檔是明確的動作

- 進入點:diff 每個檔頭多一顆「編輯」chip——僅 live attempt、settled、非凍結、非 parked 時出現(消失規則與 park 按鈕同一家)。
- 點下去:該檔的唯讀區塊原地換成 CM merge view(unified,base 側唯讀、work 側可編輯),高度有上限、自己捲。一次一檔——同時開三個編輯器的抽屜不是編輯器,是事故。
- **存檔 explicit**:儲存鈕 + ⌘S;不自動存——自動存會把「還在想」寫進 agent 即將重讀的盤。存檔後:重新整理 diff、該檔的 viewed 標記清掉(它變了,「看過」失效)、出「告訴 agent」chip。
- 取消/收合帶未存變更 → dirty 確認,接 Modal 既有慣例。
- 留言(commentable 行)在編輯模式下停用——一個檔同時是「證據」和「草稿」會讓 excerpt 對不上;關掉編輯就回來。

### 不做的

- 不編輯 base 側(歷史不是文件)。
- 不做多檔批次存、不做 format-on-save、不做 conflict 三方合併——worktree 在 settled 時人是唯一寫者;race 由 core 守門擋。
- 不做「編輯排隊等回合結束」——那是 follow-up 的事,文字改動排隊會過期。

## 成本

依賴:`@codemirror/state`、`@codemirror/view`、`@codemirror/merge`,約 +300KB(gzip 後遠小於此);無 worker、無全域樣式污染(CM6 scoped)。指令兩顆,git 呼叫每次開檔一次 `show` + 一次讀檔——與開一次 diff 同量級。

## 建議的 v1 範圍

1. Rust:`file_at_base`(worktree.rs `git show`)+ `attempt_file` / `write_attempt_file` 指令 + settled/凍結/parked 守門 + 測試(M)
2. UI:CM6 依賴、檔頭編輯 chip、就地 merge view、儲存/取消 + dirty 守門、viewed 失效、告訴 agent、i18n、mock(L)
3. Playwright:編輯→存→diff 更新且 viewed 清除;mid-turn 存檔被 core 拒且理由完整;凍結/parked 無編輯鈕;dirty 取消守門(M)

**驗收**:在 diff 裡把一行改掉、按存,worktree 檔案內容改變、diff 重新整理呈現新狀態、該檔 viewed 重置;agent 回合中存檔被拒(UI 藏鈕 + core 拒絕雙層);凍結與 parked 的 diff 沒有編輯入口;未存變更誤點取消有 dirty 確認;「告訴 agent」送出的訊息含檔名。

## 未決(拍板後開工)

1. **Merge view 版式**:unified(B 側可編輯)或 side-by-side?建議 **unified**——460px 抽屜放不下誠實的雙欄;抽屜可拉寬,但預設要能用。
2. **@codemirror 依賴**:UI 第一個大依賴,需要明確點頭(否決 Monaco 與手刻的理由在上)。
3. **Crystal 機制標註**:維持轉述標註。
