# 決策文件:Checkpoints(worktree 快照與還原)

> 狀態:**已定案,v1 已實作**(切片 1–4)· 2026-08 · 來源:前端研究報告 Tier 3 #25
> 參照:Conductor checkpoints(機制為第三方轉述,未驗證)、Crystal CommitMode、opcode Timeline、Claude Code 原生 `/rewind`

## 問題

Agent 是非單調的:第二小時可以毀掉第一小時。今天 AgentDesk 在一個 attempt **進行中**沒有任何「回到第 N 輪之前」的手段——凍結 diff 只在終局產生,git 歷史只有 agent 自己願意 commit 的部分,而 agent 最常見的狀態正是一大片未 commit 的變更。缺這個機制的代價是行為性的:使用者不敢放手讓 agent 跑,因為跑壞了沒有便宜的退路——可還原性正是換取自主性的貨幣(Conductor 與 opcode 都以此為賣點)。

## 已經存在的東西(不要重做)

| 機制 | 涵蓋 | 不涵蓋 |
|---|---|---|
| 凍結 diff | 終局後的完整紀錄 | 進行中;只能讀不能還原 |
| Claude Code `/rewind` | Claude session 內,程式碼+對話,逐輪 | 非 Claude agent;session 關掉後的操作;desk 層的可見性 |
| 多 attempt | 粗粒度的 fork(整卡重來) | 同一 attempt 內的細粒度退路 |
| `base_sha` | 「第 0 輪之前」天然存在 | 之後的每一輪 |

`/rewind` 是重要的邊界:對活著的 Claude session,原生方案更好(它同時回捲對話)。Desk checkpoints 的**剩餘價值**在:session 已關閉或重開之後仍可還原、從抽屜看得見且可 diff、涵蓋 run script / worktree shell 造成的變動、以及手動檢查點對所有 agent 有效。

## 設計空間與判定

### 觸發:Stop,不是 UserPromptSubmit

Conductor 在每次使用者訊息前快照(UserPromptSubmit 時刻)。我們驗證過兩條路:

- **UserPromptSubmit**:語意漂亮(「這輪之前」),但快照必須離開 hook 路徑非同步執行(hooks 的鐵律:絕不讓 agent 等),於是與 agent 本輪最早的編輯**存在撕裂競態**——快照可能夾到下一輪的前幾筆變更。
- **Stop**:worktree 安靜,**零競態**;「第 N 輪之後」= 「第 N+1 輪之前」,而「第 1 輪之前」由 `base_sha` 免費提供。覆蓋完整,且 `turn_done` 的偵測 seam 已經存在(queued follow-up 與完成通知都掛在上面)。

**判定:Stop 觸發(僅 Claude,hooks 只有它有)+ 手動檢查點按鈕(所有 agent,放在抽屜)。**

### 儲存:private ref + 臨時 index,絕不碰 agent 的任何東西

- Crystal 直接 commit 在工作分支(`checkpoint:` 前綴)——**否決**:污染分支歷史,而且 commit 需要動 agent 的 index。
- `git stash create` 什麼都不碰——但**不含 untracked 檔**,而 agent 最常做的事就是開新檔。**否決**。
- **採用**:臨時 index 快照。`GIT_INDEX_FILE=<tmp> git add -A && git write-tree`,commit-tree 後 `git update-ref refs/agentdesk/checkpoints/<attempt-id>/<n>`。worktree、index、分支、reflog,agent 看得到的一切都原封不動——與 stats 拒用 `add -N` 是同一條紀律。
- 前置工程:`HostRef::run` 目前不支援單次呼叫的額外環境變數(已查證),需要一個 `run_with_env`;WSL/SSH 的 `env K=V` 前綴管線(pty spawn 已在用)可直接沿用。
- refs 活在主 repo 的 git dir(worktree 共享 object store),所以 worktree 收回不會帶走它們:**attempt 終局時刪除該 attempt 的全部 checkpoint refs**(凍結 diff 從此是唯一且足夠的紀錄),啟動時掃一次孤兒 refs。

### 還原:只還原程式碼,永不碰對話,而且還原本身可還原

- Conductor 的還原會**刪除該輪之後的所有訊息**——研究已標記為要避開的半邊。**判定:絕不觸碰 agent 的對話狀態。**
- 還原前**自動先做一個「現在」的檢查點**,所以還原永遠可以反悔——與凍結 diff 同一個「先留紀錄再動手」反射。
- 機制:`git restore --source=<sha> --worktree -- :/` + 刪除快照中不存在的 tracked-in-snapshot 檔案集合差。
- **對話脫鉤問題**(還原後 agent 以為它的編輯還在):v1 只允許在 session 為 stopped / idle / exited 時還原;還原後對量測過的 CLI 提供一則預組訊息(「worktree 已還原到第 N 輪之後」)走既有 bracketed paste,送不送由人決定。執行中還原一律拒絕,附完整理由——與 merge 拒絕同一套誠實。

### UI:錨定在 Activity 時間軸

時間軸已經是逐輪的紀錄(prompt 列 = 輪的開頭)。每個 prompt 列旁掛「↩ 還原到此輪之前」;抽屜的 Changes 分頁可選「與檢查點 N 比較」(重用現有 diff 渲染,把 base 換成 checkpoint sha)。**不做** opcode 式的分支樹——fork 已由多 attempt 表達。

## 成本

每輪一次 `add -A`(臨時 index)+ write-tree:量級與 `git status` 相同,而看板 stats 每 15 秒已在跑同量級的操作;object 走 content addressing,重複內容不重複儲存。

**實測**(2026-08,本機 Linux,2 萬檔 repo):首次快照(臨時 index 從零建)~0.21s;之後每次(index 續用、吃 stat cache)~0.04s;無變更同樣 ~0.04s;對照 `git status` ~0.02s——「與 status 同量級」成立,且臨時 index 因此**續用不即刪**(存於 worktree 私有 gitdir,worktree 收回時一併消失)。WSL/SSH 未實測(本容器無環境):每次快照約 5 個 git 呼叫,遠端走 ssh 多工連線是 5 個 round trip,遇到問題時的第一個嫌疑人記在這裡。

## 建議的 v1 範圍

1. `run_with_env` 管線(S)
2. Stop 觸發快照 + 手動按鈕,refs 寫入與終局清理(M)
3. 時間軸還原 UI + 還原前自動快照 + stopped/idle 限制(M)
4. 與檢查點比較的 diff 檢視(S,重用現有渲染)

**驗收**:每輪結束產生一個 ref 且 agent 的 `git status` 前後不變(哲學驗收,要寫成測試);還原後 worktree 等於快照且自動快照存在;執行中還原被拒且理由完整;終局後 refs 消失、凍結 diff 依然完整;Playwright 覆蓋時間軸 UI 全流程。

## 未決 → 已拍板(v1 依建議採納)

1. **預設開關**:開,環境面板可關(`checkpoints_on`)。大 repo 實測見成本節;WSL 未測,列為已知缺口。
2. **保留數**:全留,終局即清(`close_attempt` 刪 refs + 啟動孤兒清掃)。
3. **手動檢查點的命名**:不具名,時間戳即名。
4. **Conductor 機制驗證**:維持標註,未再驗證;不影響本設計。
