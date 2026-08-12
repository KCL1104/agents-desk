# 決策文件:一張卡跨多個 repo(前後端 / 前端 + 自動化 QA)

> 狀態:**提案,待拍板** · 2026-08 · 來源:使用者需求(「有時候一個任務要同時處理前後端,或前端與自動化 QA」)
> 前次結論:`xirp-research.md` #19「三種專案型態 / 父資料夾多 repo」判為「動安全論證,暫不做」——
> 本文件是把那個「想清楚再做」補上。

## 問題

今天的單位是 **Task 1—N Attempt 1—1 Session**,而 Task 只帶**一個** `repo_path` + `base_branch`,
Attempt 只帶**一個** `worktree_path` / `branch` / `base_sha`。下游全部掛在那一棵樹上:
diff、stat、checkpoints、merge、PR、setup/run 腳本、`$MAROL_ROOT_PATH`、Knows 分頁、park/resume。

一個真實任務常常不長這樣。改一條 API 要同時動 `web` 與 `api`;寫一個功能要同時動 `web` 與 `qa`。
今天只有兩條路:

1. **開兩張卡**,兩個 agent 各自在自己的 repo 裡做,靠跨 session 訊息(`--name`,claude ≥ 2.1.224)喊話。
2. **手動**:在一張卡的 worktree 裡,叫 agent 自己 `cd` 去別的 repo ——
   那會直接寫進**使用者的 checkout**,把「一個 attempt 只能花掉自己的分支」這個安全論證整個拆掉。

第 2 條不能留。第 1 條是真的可用,但它吃兩個併發名額、要兩份 review、兩次合併,
而且**最需要的那個場景它剛好做不好**:同一顆腦袋同時改 API 契約的兩側。

## 已經存在的東西(不要重做)

| 機制 | 涵蓋 | 缺口 |
|---|---|---|
| `Worktrees::create` / `remove` / `attach` | 一個 repo 開一棵樹的全套(分支佔用、seq 前進、prune、原路徑長回) | 一次只做一棵 |
| `dir_for(host, root, repo)` + `path_hash` | 每個 repo 有自己的 worktree 目錄,同名 repo 不撞 | — (**多 repo 完全沿用,磁碟佈局不必改**) |
| `merge_to_base` / `push_and_open_pr` | 參數已經是 `(repo, worktree, branch, base_branch)` | 只是被呼叫一次 |
| `host::locate` / `HostEnv` / `worktree_root` | 每個世界一份環境與 worktree 根 | — |
| `NAMED_SESSIONS_SINCE` 的版本閘 | 「量到才用,不知道就關」的既有先例 | `--add-dir` 還沒進表 |
| `repo_config` + `$MAROL_ROOT_PATH` / `$MAROL_PORT` | 每個 repo 自己說怎麼變成可跑的工作區 | 一個 attempt 只讀一個 repo 的 config |
| 跨 session 訊息(`--name`) | 兩張卡的 agent 互相喊話 | 不是同一份語境,要人協調 |

## 量測(2026-08,claude 2.1.228,本機)

「先量測再決定」。三種擺法,問題固定是「不准用工具,說出你語境裡已經有的 `MAGIC_TOKEN_*`」,
兩個 repo 各有自己的 `CLAUDE.md` 與 `.claude/skills/`:

| 擺法 | CLAUDE.md | skills |
|---|---|---|
| **A** cwd = 父目錄(底下 `web/`、`api/`),不傳旗標 | **NONE** | **NONE** |
| **B** cwd = 父目錄 + `--add-dir web api` | `web` + `api` 都在 | `web-deploy` + `api-migrate` 都在 |
| **C** cwd = `web/` + `--add-dir ../api` | `web` + `api` 都在 | (同 B) |

追加量測:`--add-dir` 進來的樹**可寫**——`--permission-mode acceptEdits` 下要求它在 `../api` 建檔,
檔案真的出現了;而 `git -C ../api status` 這種 Bash 呼叫仍然照常走權限閘(不是 add-dir 的例外)。

**A 是這份設計最重要的一個負面結果**:單純把父目錄當 cwd,兩個 repo 的規則檔與 skills **全部安靜地不見**。
那正是 Marol 最不能接受的失敗形狀——「這個 repo 沒有規則」與「規則沒載進來」長得一模一樣。
所以「開一個 workspace 父目錄當 cwd」這條看起來最漂亮的路,被量測否決。

未量測、必須補的:codex 有沒有對等旗標(這台機器沒裝);`--add-dir` 最早出現在哪個 claude 版本;
以及互動模式下 `--add-dir` 的目錄會不會各自再要一次資料夾信任(`-p` 會跳過信任對話框,量不到)。

## 設計空間與判定

### 核心判定一:一張卡綁多個 repo,一個 attempt 開 N 棵樹,但**仍然只有一個 session**

一個 agent 看得到全部的樹。理由:

- **併發帳不變**。名額算的是「握著終端機的 attempt」,一個 attempt 還是一個 session,
  看板上的 `running / max` 一個字都不用改。
- **同一顆腦袋改契約兩側**,這正是兩張卡做不好的事。
- **安全論證原封不動**,只是從單數變複數:一個 attempt 只能花掉**它自己的 N 條分支**,
  每個 repo 一條,任何一個主 checkout 都碰不到。yolo 模式的邊界跟著長,論證不變。

### 核心判定二:cwd 留在主樹,其餘的樹用 `--add-dir` 掛進來(量測 C)

不是父目錄(A 已被量測否決),也不是「父目錄 + add-dir」(B)。選 C 是因為:

- **cwd 是一個真的 git repo**:CLI 自己的 git 感知(分支、status)還在,B 的 cwd 不是 repo,那塊會是空的。
- **`--continue` 的鍵不變**。它認 cwd;park/resume 的「原路徑長回來,佔用即拒」那條規則一個字不改。
- **單 repo 的卡片跟今天完全一樣**:不多一個目錄、不多一個旗標、不多一行 migration 後的行為差異。
  多 repo 是**加上去**的,不是把既有的路改道。
- **磁碟佈局零改動**:第二棵樹落在它自己 repo 的 `<root>/<name>-<hash>/<slug>-<seq>`,沿用 `dir_for`。
  seq 的挑法從「在這個 repo 空著」變成「在**每個** repo 都空著,且每個目錄都空著」——
  既有的 `loop { seq += 1 }` 往外包一層就是了。分支名在每個 repo 都一樣(`marol/<slug>-<seq>`),
  這是特性不是巧合:`git branch` 裡一眼看得出這兩條是一對。

### 核心判定三:看不見全部的樹,就不開——不降級,不猜

`--add-dir` 是 claude 的旗標。一張綁了兩個 repo 的卡片,若要跑在
(a) 沒有 `--add-dir` 的舊 claude,或 (b) 沒有量到對等旗標的 CLI 上,**start 對話框直接拒絕**,
理由寫滿:「這張卡綁了 web 與 api;這個 agent 沒有量測過的方式看見第二個 repo。
升級 claude,換 agent,或把卡片拆成兩張。」

降級在這裡是最壞的選項:agent 安靜地只看得見一半的工作,而 diff 會顯示另一半沒被動過,
看起來像「它決定不改後端」,不像「它根本看不到後端」。這跟「無狀態訊號 chip」是同一條哲學,
只是這件事的後果嚴重到不該用 chip 說,該用拒絕說。

留給 parity 的空間是完整的:模型、磁碟佈局、UI 全部與 CLI 無關,codex 哪天長出對等旗標就進 `agent.rs` 的表。

### 核心判定四:一張卡的所有 repo 必須在**同一個世界**

WSL 裡的樹和本機的樹沒有共同的檔案系統,一個 `--add-dir` 跨不過去。建卡時就拒絕,講清楚。
(世界仍然是卡片的屬性——只是現在是「這張卡的世界」,不是「這一列的世界」。)

### 資料模型

```
task_repos    (task_id, position, repo_path, base_branch)          -- position 0 = 主 repo
attempt_trees (attempt_id, position, repo_path, worktree_path,
               branch, base_sha)                                    -- position 0 = 主樹 = session 的 cwd
```

migration **V6**:把每張既有卡片、每個既有 attempt 各搬成一列,然後**丟掉**
`tasks.repo_path` / `tasks.base_branch` / `attempts.worktree_path` / `attempts.branch` / `attempts.base_sha`。

保留舊欄位當「主樹的鏡子」是誘人的(讀取端有 45 + 40 處),但 `store.rs` 自己已經寫過那條規矩:
「Modelling a 1:1 relation from both ends lets the two ends disagree」。一個事實一個地方,
讀取端補一個 `primary()` helper,多數呼叫點是改一行。

### 合併:沒有原子性,所以要**顯示**中間態

兩個 repo 沒有原子合併,git 沒有這個東西。所以合併鈕**逐 repo 各一顆**,各自兩擊、各自拒絕
(`merge_to_base` 的三個拒絕本來就是逐樹成立的:未 commit、主 checkout 不在 base、base 髒)。
順序由人決定(通常後端先)。

檢視器必須能誠實顯示「web 已合併 / api 尚未」這個真實存在的中間態,
而不是一顆假裝原子的「已合併」徽章。attempt 的 outcome 仍然是人按的終局:
收尾頁腳列出哪幾棵樹合了、哪幾棵沒合,人自己決定這樣算不算完成。

### Checkpoints:一組編號,缺號往前找

每回合逐樹快照,編號 `n` 是**一組**。沒變的樹照舊不產 ref(同 tree 不產 ref 的規則不動),
所以會有缺號。還原第 `n` 組時,每棵樹各自用它 **≤ n 的最後一個** ref;一個都沒有就回自己的 `base_sha`。

### 腳本與環境

- `setup` 逐樹跑,各自在自己的樹裡,`$MAROL_ROOT_PATH` 仍然是**那棵樹自己的 repo** 的主 checkout。
  起動時間變成兩者相加——這是真成本,要說出來。
- `run` 清單標上 repo 名(`web: dev`、`api: dev`、`qa: e2e`),各自拿自己的 `$MAROL_PORT`。
- 新增 `$MAROL_TREE_<NAME>`:每棵樹的路徑,給腳本用。
- **v1 沒有答案的**:前端的 run 腳本要知道後端拿到哪個 `$MAROL_PORT`。埠是啟動時才配發的,
  沒有誠實的靜態答案。明說這個缺口,不假裝。

### 第一則訊息

模板加一個 `{trees}` 區塊,每棵樹一列:`- web → <path>(分支 marol/x-1,從 main @ a1b2c3d)`。
模板不會被覆寫(既有規則),所以**已經編輯過模板**的人不會有 `{trees}`——
這時多 repo 卡片把區塊接在最後。這不違反「你讀到的就是會跑的」:start 對話框顯示的是組好的全文,而且可編輯。

## 不做的

- **不做父目錄當 cwd 的 workspace**。量測 A:兩個 repo 的 CLAUDE.md 與 skills 全部不載入。
- **不做 symlink 把兄弟樹接進主樹**。那是往 agent 的 worktree 裡寫 untracked 檔案,遲早被 commit 進去。
- **不做跨世界的卡片**(判定四)。
- **不做「唯讀參考 repo」**(v1)。worktree 就是安全論證,所以每個 repo 都開自己的分支;
  「只讀」的意思就是你不合併它。大 repo 開一棵樹的磁碟與時間成本是真的,但那要量過再說,不猜。
- **不做原子跨 repo 合併,不做 PR 群組**。git 沒有,假裝有比沒有更糟。
- **不做「每 repo 一個 agent 的協作組」**。兩張卡 + 跨 session 訊息今天就買得到八成,
  剩下的兩成(同一顆腦袋改契約兩側)正是它做不到的那部分。

## 成本

**Rust。** `store.rs`:兩張新表 + V6(搬移 + 丟欄位)。`worktree.rs`:`create` 外包一層
「seq 要在每個 repo 都空」,其餘函式簽名不動(它們本來就吃 `(repo, worktree, branch, base)`)。
`core.rs` 是主要工程:`open_attempt` / `finish_opening` / `close_attempt` / `park` / `resume` /
`attempt_diff` / `attempt_stats` / `attempt_file` / `write_attempt_file` / `merge_attempt` / `open_pr` /
`checkpoint_now` / `restore_checkpoint` / `list_run_scripts` / `run_script` / `agent_docs` 全部從
「一棵樹」變成「一組樹」。`agent.rs`:`--add-dir` 進 `every_flag`,加 `ADD_DIR_SINCE` 版本閘。

**UI。** 開卡對話框的 repo 列(預設一列,「＋ 加一個 repo」長出第二列;世界一張卡只選一次)、
卡片上的 repo 徽章、檢視器 Changes 逐 repo 分區(diff 的檔案鍵要帶 tree,可編輯 diff 沿用)、
逐 repo 合併與 PR、Knows 逐樹、run 清單標 repo、拒絕文案、i18n(en 為準,zh-TW 全映射)、
`mock-tauri.ts` 每個新指令補 handler、Playwright。

**沒有新依賴,沒有新的磁碟佈局。** 主要成本是把單數換成複數的那 15 個函式,以及檢視器的分區。

## 建議的 v1 範圍(三片,依序)

1. **模型與開卡(L)**:`task_repos` + `attempt_trees` + V6;開卡對話框可加 repo(同世界檢查、逐 repo 檢查 base);
   `open_attempt` 逐 repo 開樹(seq 在每個 repo 都要空);`--add-dir` + 版本閘 + 看不見全部就拒絕;
   `{trees}` 區塊;setup 逐樹;finish / park / resume 逐樹收放。
2. **檢視器(M)**:Changes 逐 repo 分區、stat 逐樹 + 卡片顯示合計、合併鈕逐 repo(各自兩擊)、
   PR 逐 repo、Knows 逐樹、run 清單標 repo、`$MAROL_TREE_<NAME>`。
   **中間態必須看得見**:「web 已合併 / api 尚未」。
3. **Checkpoints 跨樹(S/M)**:逐樹快照、一組編號、還原時缺號往前找。

**驗收(片 1)**:一張卡綁 `web` 與 `api`,開一次 attempt 得到兩棵樹、兩條同名分支、**一個** session;
在 TUI 裡 agent 讀得到也寫得到兩邊,而且兩邊的 `CLAUDE.md` 與 skills 都在語境裡(量測 B/C 的那條線);
把 claude 換成 codex,同一張卡在 start 對話框被**拒絕**並說出理由;單 repo 卡片的行為與 v0.4.1 逐位元相同。

## 在片 1 落地之前,今天的答案

**開兩張卡,讓它們互相喊話。** 跨 session 訊息已經在(claude ≥ 2.1.224),
session 名字就是卡片名字(「修好登入 #1」),所以後端那張可以直接叫前端那張。

它適合:兩邊的工作真的可以分開 review、分開合併;或者兩邊本來就該是不同的 agent
(一個開發、一個跑 QA)。它不適合:同一條 API 契約的兩側——那要等片 1。

## 待拍板

1. **拒絕 vs 降級**(判定三)。建議拒絕。反面意見是「讓人自己承擔,agent 只看得到主 repo 也能做事」。
2. **舊欄位丟不丟**。建議丟(一個事實一個地方)。反面意見是 85 個呼叫點的改動風險。
3. **v1 要不要收「唯讀參考 repo」**。建議不收,先量大 repo 開樹的成本。
4. **`ADD_DIR_SINCE` 的值**。必須查證 `--add-dir` 最早出現的版本;查不到就用量過的
   2.1.228 當保守下限,並在文案裡說這是下限而不是首次出現的版本。
