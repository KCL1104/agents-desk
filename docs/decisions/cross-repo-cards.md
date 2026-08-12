# 決策文件:一張卡跨多個 repo

> 狀態:**已定案,v1 已實作** · 2026-08 · 來源:使用者回報(「session 因為要設 worktree,綁定只能在一個 repo 中生成,但有時候我是想要跨 repo 進行」)
> 推翻:`docs/xirp-research.md` 配對 #19「三種專案型態 / 父資料夾多 repo —— 動安全論證 —— 暫不做」

## 問題

一個要同時改後端和它的客戶端的變更,是**一件事、一段對話**。今天它只能是兩張卡、兩個 session、兩份各自不完整的上下文,而那兩個 agent 誰也不知道對方改了什麼——中間那份「兩邊要怎麼對起來」的推理,是這個產品最不該弄丟的東西。

被綁死的地方不在 UI,在資料模型:`tasks.repo_path` 是一個字串,`attempts` 只有一組 `worktree_path / branch / base_sha`,於是 diff、stat、checkpoint、diff 內編輯、合併、PR **全部**吊在那一組上。

## 為什麼當初的「動安全論證」是錯的判斷

研究報告把這條擋在「暫不做」,理由寫的是「動安全論證」。查證後那句話站不住,而且**站不住的方向很重要**。

安全論證的原句是:**一個 attempt 只能花掉自己的分支**。它推廣得乾乾淨淨——每個 repo 各開自己的 worktree、各在這次 attempt 自己的分支上,agent 碰得到的沒有一個是人本人的 checkout。分支從一條變成好幾條,「只能花掉自己的」一個字都沒鬆。

真正會破壞論證的是**便宜的那個版本**:如果額外的 repo 只是「掛個唯讀目錄讓 agent 看得到」,那 agent 在那裡寫的字就是寫進你本人的 checkout——沒有 worktree、沒有分支、沒有 diff、沒有退路。所以這裡的取捨不是「完整版貴、便宜版安全」,而是**完整版是唯一保住論證的版本**,便宜版才是不能做的那個。

## 判定

### 卡片:第一個 repo 留在 row 上,其餘進側表

`tasks.repo_path` / `base_branch` 不動,新增 `task_repos(task_id, position, repo_path, base_branch)` 只裝「第一個以外的」。

不把全部搬進側表,是因為**每一張已經存在的卡,它的 repo 就在那一欄**;搬家等於寫一次遷移去改人家整個看板的每一列,而換來的只有對稱。`StoredTask::repos()` 是其餘程式真正在用的形狀。

### Attempt:每一棵 checkout 都寫下來,包括只有一棵的時候

新增 `attempt_trees(attempt_id, position, repo_path, base_branch, dir, worktree_path, branch, base_sha)`,**每個 attempt 都寫**,一個 repo 的也寫。

代價是那一列等於把 attempt 自己的欄位再說一次;換到的是**下游全部只 iterate 一個清單**,而不是每個碰到 worktree 的函式都分岔成「一個」和「多個」兩條路。分岔才是 bug 會住進去的地方。

這張表在此功能之前開的 attempt 上是空的。那不是缺列要補——attempt 自己的欄位**就是**它那唯一一棵 checkout,`Core::trees()` 當場合成一棵回去,不去替別人回填一張他們那時還沒有的表。

### 版面:一個 repo 不搬家,多個 repo 才長出工作區

- 一個 repo:checkout 就在 `~/.marol/worktrees/<repo>-<hash>/<slug>-<n>/`,**和過去逐位元組相同**。
- 多個 repo:同一個路徑變成**工作區**,底下每個 repo 各占一個以 repo 為名的資料夾,session 起在工作區。

工作區本身不是 repo。這是刻意的:worktree 不能巢在另一個 repo 裡(README 已有的理由),而且「你在一個工作區、要改哪個 repo 就進它的資料夾」是一句 agent 一讀就懂的話。

同名的兩個 repo(兩個 `api`)第二個接上和 worktree 目錄同一套路徑 hash——認得出來,而且是構造上唯一,不是碰運氣。

### 一個分支名,在每個 repo 裡

它們是一件事,用一個名字審查是重點。編號因此只有一個答案要往前走:**任何一個 repo 已經有那個名字,整個 attempt 就跳過那一號**,否則 `marol/card-2` 在同一個工作區裡會指兩件不同的事。

### Diff:一份 diff,路徑相對於工作區

每棵 checkout 的 diff 用 `--src-prefix=a/<dir>/` / `--dst-prefix=b/<dir>/` 算,於是 `web/api.ts` 和 `api/routes.py` 是同一份 diff 裡的兩個檔。

這一個決定順手解掉三件事:前端的 diff parser **一行都不用改**;審查留言指的路徑,agent 站在工作區原地就打得開;diff 內編輯拿回來的路徑,第一段就說了是哪棵 checkout。一個 repo 時不加前綴,所以那份 diff 也和過去逐位元組相同。

不在任何一棵 checkout 底下的路徑**拒絕**,不退回第一棵——把客戶端的檔案寫進後端,正是這個查表存在的理由。

### 合併:先全部檢查,再逐一動手

`merge_to_base` 的每一條拒絕,都是「不這樣會靜默丟工作」。拆出 `check_merge` 先問完全部,是因為**在已經改動了第一個 repo 之後才發現第二個沒 commit**,是這個 app 還來得及防的那種半途狀態。

這不是原子性的承諾,也不假裝是:第一個落地之後,第二個仍可能因為衝突失敗。那時候的做法是**如實報告已經合併進去的是哪些、attempt 不關、worktree 不收**——人接手收尾需要知道的就是這個。它把常見情況(有一邊忘了 commit)變回別處一樣的那種當面拒絕。

### Checkpoint:編號是「工作裡的一個時刻」,不是某棵樹改了幾次

序號由 core 給,跨 checkout 共用一個。那一刻沒動到的 repo 就不長 ref——那是誠實的紀錄:那裡當時沒有東西要快照。讀回去時取**該編號或更早**的最新一顆(`at_or_before`),沒有就是它的 base。

各自編號的版本會讓「checkpoint 3」在每個 repo 裡指不同的瞬間,而走回去那一步會拼出一個從來不存在過的工作區。

### PR:一個 repo 一個,全部回傳

PR 屬於 repo,湊不成一個。能誠實給的是那一組,同名分支、同一份描述。中途失敗就停在那裡並說出已經開好的是哪些。

## 兩條建卡時的拒絕

| 拒絕 | 為什麼 |
|---|---|
| 同一張卡上的 repo 必須在**同一個世界** | attempt 的 worktree 共用一個資料夾,而資料夾跨不過通往 WSL distro 或 SSH host 的那道門。混世界的卡描述的是一個不可能存在的工作區。 |
| 同一個 repo **不能出現兩次** | 那是同一條分支的兩棵 worktree,git 本來就拒絕,而且後面沒有任何東西分得出來。 |

## 開場訊息

模板寫在硬碟上、升級不覆蓋,所以**今天每一份模板都是在「一張卡一個 repo」的世界寫的**,沒有一份提到工作區。一個站在工作區裡、卻被告知自己在一棵 worktree 裡的 agent,會去它醒來的目錄找檔案,然後找到一堆資料夾。

所以 `{repos}` 沿用 `{prompt}` 那條既有紀律:模板沒提到它、而這張卡真的跨了多個 repo,就把那段補上去。只有一個 repo 時什麼都不加——那份模板自己的句子,對它的處境已經句句為真。

## 明確不做

- **唯讀掛額外目錄。** 上面說過:那是唯一會破壞安全論證的版本。
- **每列一個世界選擇器。** 提供一個 core 一定會拒絕的卡,是提供一個假選項。
- **跨 repo 的原子合併。** 沒有這種東西,而假裝有比說清楚更貴。

## 驗收

- `tests/worktree.rs`:兩個 repo 各開一棵、同一分支名、人本人的 checkout 沒動;編號跳過任一 repo 已有的名字;diff 路徑相對於工作區(含新建檔走 `--no-index` 那條);同名 repo 各得一個資料夾;中途失敗不留半個工作區。
- `tests/attempts.rs`:一張卡兩個 repo 跑一個 session;diff 涵蓋兩邊且路徑可回查;合併整體拒絕、不先動第一個;checkpoint 編號跨 checkout 一致、還原走 at-or-before;park/resume 全部還回去又全部長回來;兩條建卡拒絕;各 repo 的 setup 在各自的 checkout 裡跑、而 `$MAROL_ROOT_PATH` 指的是**第一個** repo(不是第一個有 setup 的);run script 依 checkout 命名;Knows 分頁讀每一棵且每一列說得出自己屬於誰;一棵還不回去的 checkout 不會連累其他棵;沒有任何時刻帶的編號拿去 diff 會被拒絕(和 restore 同一個答案)。
- `ui/tests/workspace.spec.ts`:額外列是 opt-in、各自帶 base;空白列擋住建立;跨世界的拒絕落在對話框裡;命令面板搜得到第二個 repo;合併鈕說出全部的 base;開 PR 回來的是好幾條連結而不是一條黏起來的字串;Knows 分頁分得出兩棵 checkout 的 `CLAUDE.md`。
