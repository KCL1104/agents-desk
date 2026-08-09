# 決策文件:Parked(暫停態——凍結 session、留分支、還地)

> 狀態:**已定案,v1 已實作**(三片全落地;未決三項依建議拍板)· 2026-08 · 來源:前端研究報告 Tier 3(CS pause / Conductor archive)
> 參照:Claude Squad pause(checkout 後釋放 worktree、留分支;機制為研究報告轉述)、Conductor archive(第三方轉述,未驗證)

## 問題

一張桌子的容量是有限的:併發槽有上限、每個 worktree 佔一份磁碟、側邊欄與看板的每一列都在收注意力稅。但「現在不做」和「不做了」是兩件事——今天 AgentDesk 只有後者(終局:merge / discard / supersede,worktree 收回、diff 凍結、不可逆)。缺中間態的代價:一個等 code review 回覆、等外部 API 開通、等明天再說的 attempt,要嘛繼續佔著一個槽和一份磁碟,要嘛被迫終局、之後用新 attempt 從頭來——對話丟了,這正是 checkpoints 文件說過的最貴的東西。

Parked 是那個中間態:**工作留著、對話留著、資源還回去**。

## 已經存在的東西(不要重做)

| 機制 | 涵蓋 | 缺口 |
|---|---|---|
| `Worktrees::remove` | 收回 worktree、**分支明文保留**(有測試釘住) | 只在終局被呼叫 |
| `reopen_attempt` | session row 被封存後也能開新終端機,claude 帶 `--continue` + 原 mode | **要求 worktree 目錄存在**,不在就明確拒絕 |
| `--continue` 憑 cwd 找對話 | worktree 路徑記錄在 attempt row,固定不變 | 路徑上沒有目錄時無從續起 |
| Checkpoints(v1 已落地) | 快照不碰 agent 任何狀態;refs 活在主 repo git dir,worktree 收回帶不走;**終局才清** | 尚無人在終局以外的時刻用它搬運工作 |
| 佇列與併發 | PTY 死亡自動釋放槽、`drain_queue` 補位 | park 需要主動踢一下 drain |
| `Worktrees::create` | 從 base 開新分支 + 新 worktree | 不能在**既有分支**上長 worktree(永遠 `-b`) |

結論先寫在這裡:park/resume 幾乎是既有零件的重新排列。真正的新零件只有兩個——`Worktrees::attach`(`git worktree add <原路徑> <既有分支>`,不帶 `-b`)和 attempt row 上的一個 `parked_at` 欄位(store migration)。

## 設計空間與判定

### 語意:parked 是 attempt 的狀態,不是第五個 outcome

- Outcome 的語意是終局:diff 凍結、worktree 永別、checkpoint refs 清除。Parked 全部相反:diff 還會變、worktree 會回來、refs 要留著載工作。塞進 outcome 會讓每個 `outcome.is_some()` 判斷都變成謊言。
- **判定:`attempts.parked_at INTEGER NULL` 新欄位(migration),`NULL` = 沒暫停。** Live 狀態機加一個 `kind: 'parked'`,與 `stopped`(有 worktree 沒終端機)明確區分——stopped 一鍵就回來,parked 要先把地長回來。

### Park 的動作序:快照 → 收地 → 封存 session → 補位

1. **拒絕條件與 restore 完全同一套**:回合進行中(live 且非 idle/saved/exited)拒絕,附完整理由——把地從正在寫檔的 agent 腳下抽走,和把檔案內容抽走是同一種傷害。已終局的 attempt 拒絕(它沒有「暫停」可言)。
2. **未 commit 的工作走 checkpoint,不走 commit**:park 前自動做一個檢查點(機制已存在,無變更時天然 no-op)。**否決** CS 式的自動 WIP commit——它寫進分支歷史,resume 後 agent 看到一個自己沒做過的 commit,正是 checkpoints 文件否決過的對話脫鉤;也**否決**「髒了就拒絕暫停」——agent 停在半途正是最想暫停的時刻,拒絕會讓這功能半數時間不可用。
3. `Worktrees::remove`(收地,分支留下)+ session row 封存 + PTY 確認死亡。
4. `drain_queue()`——釋放的槽立刻給排隊的人。
5. **分支名進剪貼簿 + toast**:暫停的下一個念頭常是「在別處看一眼這個分支」,把名字遞到手上。

### Resume 的動作序:長地 → 還原 → 舊路直走

1. `Worktrees::attach`:在**記錄的原路徑**上 `git worktree add <path> <branch>`。路徑必須是原路徑——`--continue` 憑 cwd 找對話,換路徑等於丟對話。路徑被別的東西佔住(使用者手動放了目錄)→ 明確拒絕,不猜。
2. **從 park 時的檢查點還原內容**(restore 機制已存在):分支 tip 可能落後於暫停當下的 worktree,少這一步就是靜默丟工作。還原 index 之外的一切;**staging 狀態不還原**(index 隨 worktree gitdir 一起消失了)——這是已知的損耗,park 確認文案裡要說。
3. 之後就是**現有的 `reopen_attempt` 原封不動**:它本來就處理「session row 已被封存」的情況,開新終端機、claude 帶 `--continue` + 原 mode。非 claude agent 與現狀一致:開在原目錄,對話能不能續看該 CLI 自己(誠實說,不假裝)。
4. `parked_at` 清空,checkpoint 編號繼續(refs 一直都在)。

### 終局:parked 的 attempt 也能直接收掉

已暫停的卡還是可以 discard / supersede(merge 需要 worktree 做 dirty 檢查——先 resume 再 merge,拒絕時說明白)。終局時 `close_attempt` 的既有清理原樣適用:refs 清除、凍結 diff——但 parked 沒有 worktree 可讀,凍結 diff 用**最後一個檢查點對 base 的 diff**(`git diff base..checkpoint-sha` 在主 repo 跑,tree-ish 對 tree-ish,不需要 worktree)。這是唯一需要多想一步的交叉點。

### UI:看板卡片為主,一種新的安靜

- **Park 入口**:卡片上 stopped/idle 時出現「暫停」;檢視器 header 同款。單擊即可,**不用兩擊武裝**——它可逆,武裝是給不可逆的。
- **Parked 卡片**:`data-live='parked'`,狀態行「已暫停」,邊條用 `--fg` 混灰(比 stopped 更靜、比 finished 有溫度——它還活著,只是睡了)。主按鈕「繼續」= resume 全流程。欄位不動——欄位永遠是人的判斷。
- **側邊欄**:parked 的 session row 已封存,自然消失——側邊欄是「現在活著的東西」,暫停的東西不收注意力稅,這正是目的。
- 「暫停了 N 個」不做全域計數:看板的 parked 卡片本身就是清單。

## 成本

Park 後每個 attempt 的持有成本:一個分支 + checkpoint refs(objects 走 content addressing,與凍結 diff 比不增量)。磁碟(worktree)與併發槽全數歸還——這就是全部的收益。Resume 的成本 ≈ `git worktree add`(秒級)+ checkpoint restore(實測 0.04s 級)+ 開終端機。

## 建議的 v1 範圍

1. `Worktrees::attach` + `parked_at` migration + park/resume core 流程(含 drain_queue、拒絕條件)(M)
2. 看板/檢視器 UI:暫停與繼續按鈕、parked 卡片狀態、剪貼簿 + toast、i18n、mock、Playwright(M)
3. parked 終局:checkpoint-對-base 的凍結 diff(S)

**驗收**:park 後槽被排隊者接走、分支與 refs 都在、worktree 目錄消失;resume 後路徑相同、`--continue` 接上原對話、暫停當下未 commit 的內容一字不差回來;回合進行中 park 被拒且理由完整;parked 卡片直接 discard 後凍結 diff 完整、refs 清空;路徑被佔時 resume 明確拒絕。

## 未決 → 已拍板(v1 依建議採納)

1. **attempt shell 隨 park 關閉**:與終局同規則——park 的 doomed 清單涵蓋 attempt session、shell 與所有 cwd 在 worktree 下的 session,shells 快取一併清。
2. **resume 中間態**:attach 成功即算 resume 成功;restore 失敗經 `Resumed.restore_error` 上浮為 toast,worktree 誠實停在分支上,時間軸可重試——不回滾裝乾淨。
3. **Conductor archive**:維持第三方轉述標註,未再驗證。
