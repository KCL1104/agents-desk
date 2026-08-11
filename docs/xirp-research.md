# Xirp 研究：同陣營競品第一次出現，而且來自 Spotify

> 2026-08-11 · 研究對象：Spotify Xirp(2026-08-10 公開 beta)。
> 兩輪研究:第一輪讀官方頁面與報導,第二輪抓 `llms.txt` 找出全部十四頁,
> 直接讀 `.md` 原文(index / getting-started / projects / sessions / settings / faq / changelog / xirp-and-portal)。
> **未實際安裝**(macOS only)——所有 UI 描述來自文件文字與其截圖檔名,無親手驗證。
> 依產品原則 #4「借來的機制在親手量測前都是未經查證的二手資訊」處理。

---

## 一、Xirp 是什麼

一句話:**Spotify 內部長出來的多 agent 桌面控制台,2026-08-10 開放公測。**

官方定義:「run and manage local AI coding sessions across projects, agents, and Git worktrees」。
支援 Claude Code / Codex / Gemini,macOS only,閉源,需 Spotify 帳號登入。
**依賴外部工具:`tmux`(必要)與 GitHub CLI `gh`**——啟動時檢查並給安裝指引。

規模數字(官方自陳,未經第三方驗證,且官方兩處互相矛盾):
「thousands of Spotify engineers... across more than 36,000 sessions」vs「1,300+ Spotify engineers」。
宣稱可協調「50+ parallel sessions」。

## 二、與 AgentDesk 的機制對照

**這是類別裡第一次出現與 AgentDesk 核心機制一致的對手。**

| 機制 | AgentDesk | Xirp | 判定 |
|---|---|---|---|
| 終端 | 真 PTY,不重繪 | 「a full interactive terminal」「Type and respond exactly as in the native coding-agent CLI」 | **一致** |
| 隔離 | 每 attempt 一個 worktree | 每 session 可選 main checkout 或新 worktree | **一致** |
| 狀態 | Claude Code hooks | 「session hooks」偵測 working / idle / waiting | **一致** |
| 多 agent | Claude / codex / gemini,非 Claude 誠實降級 | 同三家,vendor neutrality 當旗幟舉 | **一致** |
| 設定歸屬 | 權限模式 per-attempt,不代管憑證 | 「Models, credentials, and permissions stay in each agent's own native configuration — **Xirp does not translate settings between agents**」 | **同一條誠實原則** |

三個核心賭注被一家有數千名工程師實測資料的公司獨立驗證,連「不代替 agent 翻譯設定」這條
誠實原則都獨立長出來了。**本研究最重要的一行:核心不用動。**

## 三、Xirp 的論點,以及與 AgentDesk 的分歧

落地頁標題不講終端,講情境:

> **「Know your systems. So your agents can too.」**

他們把類別定義為**檢索問題**:知識散在人與人的對話裡,agent 拿不到,於是做出
「technically correct and **operationally wrong**」的決定。發表文列的三個規模痛點:

1. **重複發現** — 「Agents in one session would expend cycles rediscovering what another session had already resolved」
2. **重建成本** — 工程師花在重建情境的力氣,跟拿去蓋新東西的一樣多
3. **碎片化** — 機構知識散進個人設定(各自的 CLAUDE.md、各自的 MCP)

**分歧:AgentDesk 的 positioning 回答 how(終端是真的),Xirp 回答 why(為什麼需要一個 app)。**
他們的答案(接企業 catalog)AgentDesk 抄不了也不該抄,但問題是真的,
而 AgentDesk 已有一整套本機零件(worktree、checkpoints、transcript、跨 session 訊息)沒被組織成論點。

---

## 四、架構:session 比 app 長壽,靠的是 tmux

第一輪把這項列為「未驗證、證據最弱」。第二輪有三條互相佐證的證據:

1. **依賴清單**:「Xirp checks your Mac when it starts and provides guidance when required software,
   such as **`tmux`** or the GitHub CLI (`gh`), is missing.」
2. **FAQ 2.3 直球**:「What happens when I close the app — do I lose my sessions?
   **No. Sessions are persistent and survive app close and reopen.**」
3. **設定頁**:「Advanced and debug ... Debug pages show connection and **daemon** information.」

⇒ **PTY 活在 tmux server 裡,app 只是 attach 上去的前端。** 這正是 Claude Squad(Go TUI + tmux)
用的同一招——前次研究已記錄它是唯一同陣營的工具,只是當時沒注意到 tmux 才是它持久化的來源。

對照 AgentDesk:app 結束 = PTY 結束,重開靠 `claude --continue` 由 cwd 找回對話,scrollback 不落盤。

**這是兩者之間唯一真正的架構分歧,而且解法比想像中便宜**——不必自己寫 daemon,tmux 就是 daemon。
但代價要看清楚:

- **多一個硬依賴**。Xirp 選擇接受,並做了「缺工具就給安裝指引」的啟動檢查。
- **與 `worlds.md` 的「零遠端安裝」正面衝突**。本機與 WSL 裝 tmux 尚可討論,
  但 SSH 世界要求遠端主機有 tmux,就打破了「everything transits wsl.exe / ssh、零遠端安裝」的承諾。
  諷刺的是 SSH 世界**最需要**它:tmux 在遠端就是斷線不死 session。
- **Windows 原生沒有 tmux**。PRODUCT.md 已確認「native Windows 與 WSL 都要全支援」,
  那 Windows 原生世界就得有第二套持久化機制,或誠實地在該世界沒有這個能力。

判定:**值得立決策文件,但不要照抄成全域依賴。** 可能的中間路線是把持久化做成
**世界的能力而非 app 的前提**(local/WSL 有 tmux 就用,沒有就退回現行行為;SSH 世界另議),
與「世界是卡片的屬性」的既有結論同構。

---

## 五、三個表面的設計拆解

### 5.1 Projects — 一個 AgentDesk 沒有的實體層

Xirp 有「專案」這個一等實體,AgentDesk 沒有(卡片直接綁路徑)。

- **三種專案型態**:單一 git repo(完整 git/worktree 體驗)、非 git 資料夾(session/files/skills/rules 仍可用)、
  **父資料夾含多個 repo**(agent 可跨子專案工作,但 repo 層控制受限)。
- **五個分頁**:
  - **Overview** — 活躍與近期 session、worktrees、一個開工用的 prompt 框;
    檢視可切「卡片 / 精簡列表 / 其他版面」,且「keeps session and worktree information together
    so you can see which branch each agent is using」。
  - **Git** — working-tree 變更、**分支**、**commit 歷史**、**commit 控制**;點檔案看 diff 再提交。
  - **Files** — 檔案樹 + 編輯器 + markdown 預覽;`Cmd+P` 依名開檔、`Cmd+Shift+F` 全專案搜尋、
    `Cmd+E` 從 session 切換編輯器。
  - **Skills** — 列出「supported global and project skill folders」發現的可重用指令,
    用於「release checks, migrations, or repository-specific operations」。
  - **Rules** — 列出 `CLAUDE.md`、`AGENTS.md` 與支援的 agent 設定檔。
- **專案管理**:pin、改名、移除(不刪本機資料夾)、從父資料夾匯入更多 repo。
- **每專案設定**:設定頁的 Projects 區段頂端有專案選擇器,決定正在編輯哪一個。

AgentDesk 缺口:無專案實體、無 Files 分頁、無 Skills/Rules 表面、
Git 側只有 attempt 的 diff(無分支列表、無 commit 歷史、無 commit 控制)。

### 5.2 Sessions — 比 AgentDesk 鬆的耦合,和幾個沒有的動作

- **session 可以不屬於任何專案**:「It can belong to a project and worktree, or run as a
  **general session without project context**.」新增時 `+` 先選專案或選 general。
- **session 與 worktree 明確解耦**:「Closing a session does not delete its worktree, and
  deleting a worktree does not close the session — they are managed independently.」
  刪 worktree 前要人確認是否連分支一起刪(與 Claude Squad 順手 `git branch -D` 的反模式相反,
  這點他們做對了)。
- **新增 session 表單**:描述目標、選 agent、main checkout 或新 worktree、
  **附截圖到初始 prompt**、覆寫該次 agent 選項、**前景或背景啟動**。
- **session 中可做的事**:像原生 CLI 一樣打字;**中途換成另一個已安裝的 agent**;
  用外部終端或編輯器開啟 worktree;不離開 session 就瀏覽檔案與看 git 變更;
  **fork 一段對話去試另一條路**;在同一 worktree 開一個 linked shell;停止或關閉。
- **狀態只有四態**:Working / Idle / Waiting / Finished-or-failed。
  (AgentDesk 六態 — running / waiting-permission / waiting-you / awaiting-trust / idle / ended —
  **比他們細**。)
- **工具列顯示**:專案、session、分支、**context-window 使用量**、worktree、agent、控制項。
- **Grid view(`Cmd+G`)**:多個活終端同窗;可調大小、聚焦單格、最大化、
  **依主題分組**、**依專案篩選**;每格仍可互動。
- **導覽鍵**:minimap 卡片點選聚焦、`Cmd+←/→` 前後移動、
  **`Cmd+Shift+K` 最近 session 切換器(MRU)**、`Cmd+K` 搜尋專案/session/檢視/動作、`Cmd+/` 全部快捷鍵。

AgentDesk 缺口:general session、MRU 切換器、fork 對話、截圖輸入、背景啟動、
終端牆的分組與篩選、中途換 agent。

### 5.3 Settings — AgentDesk 最弱的一環,對手做得很完整

AgentDesk 現況:單一 `EnvPanel.tsx`(536 行)藏在側欄底部一顆 11px 灰字按鈕後,
約十四組設定平鋪(diagnostics / language / theme / notifications / profiles / messaging /
checkpoints / termSr)。前次審查已判定 Nielsen「辨識重於回憶」是最弱項之一。

Xirp 的設定頁:齒輪圖示或 **`Cmd+,`** 開啟,八個區段,**頂端有搜尋欄**
(「Use the search field to find a setting by name or description」):

| 區段 | 內容 | AgentDesk 有無 |
|---|---|---|
| **General** | Application(app 行為 + **重播歡迎導覽的按鈕**)、Appearance(主題、終端字型、**字級**、**版面密度**)、**Accessibility**(視覺與互動偏好) | 主題有(且 11-token + 即時 WCAG 更好);字級/密度/a11y 區段無;重播導覽無 |
| **Sessions** | 預設 agent;**Prompting 設定控制「Xirp 自己加進新 session 的指令」,並明說 repository rules 與 Portal context 是另外的來源** | 無(`prompt.rs` 有組句,但使用者看不到 app 加了什麼) |
| **Terminal & editor** | Option 鍵行為、自然滑鼠選取、終端捲動、**外部終端 app**、**編輯器指令**、**可改鍵的快捷鍵**(選一列、錄新組合、存檔) | 部分(`launchers.ts`);快捷鍵不可改 |
| **Git & worktrees** | worktree **建立位置**與**命名規則**;專案層 setup / cleanup 腳本 | 位置固定 `~/.agentdesk/worktrees/`;腳本有(`.agentdesk/config.json`) |
| **Notifications** | hooks 驅動徽章/音效/視覺提示;**可只關音效保留視覺** | 有(三事件開關 + 測試鈕) |
| **Coding agents** | 列出已安裝的 agent CLI,「**exposes only tested, agent-specific launch controls**」;憑證與模型留在各 agent 自己的設定,「**it never exposes credential files**」 | 部分(profiles + 版本探測) |
| **Projects** | 每專案的顯示、git/worktree 預設、setup 腳本(頂端專案選擇器) | 無專案層 |
| **Advanced & debug** | 功能旗標、**第三方授權聲明**、**連線與 daemon 診斷頁**;匯出前警告「可能含本機路徑與 repo 名稱」 | 診斷有;授權聲明無 |

底部固定顯示**版本與更新狀態**。

### 5.4 Onboarding — 三步,每步都是一個真決定

歡迎導覽只有三步,而且**每一步都是 app 真的需要的決定**,不是投影片:

1. **選 coding agent** — 偵測已安裝的 CLI,選新 session 的預設(之後可逐次改)。
2. **啟用 session hooks** — 一句話處理信任:
   「Session hooks let Xirp detect when an agent is working, idle, or waiting for input.
   This drives status indicators and notifications.
   **Enabling hooks does not grant an agent additional file or network permissions.**」
3. **選版面** — minimap 放上、左、或右(之後可在設定改)。

外加:啟動時檢查環境,缺 `tmux` / `gh` 就給安裝指引;
文件的 Troubleshooting 每一條都指到確切設定路徑
(「狀態沒更新 → Settings > Notifications > Session Events > 啟用 Session hooks」)。

---

## 六、模式 → 缺口配對表

| # | Xirp 的做法 | AgentDesk 現況 | 哲學檢查 | 判定 |
|---|---|---|---|---|
| 1 | **Rules 分頁**(CLAUDE.md / AGENTS.md / agent 設定檔) | 無表面 | 安全(app 自己的畫布) | **做** |
| 2 | **Skills 分頁**(global + project 兩層) | 無 | 安全 | **做** |
| 3 | **設定搜尋欄**(依名稱或描述找設定) | 無;設定藏在 11px 灰字後 | 安全 | **做,成本最低的可發現性修法** |
| 4 | **`Cmd+,` 開設定** | 無標準鍵 | 安全 | **做** |
| 5 | **Prompting 設定:公開 app 自己加了什麼指令** | `prompt.rs` 組句對使用者不可見 | 安全,且**正面兌現原則 #3** | **做** |
| 6 | **重播歡迎導覽按鈕** | coach marks 有 bitmask,無重置入口 | 安全 | **做**(數行) |
| 7 | **MRU session 切換器 `Cmd+Shift+K`** | 只有 ⌘E 循環「等你」的 | 安全 | **做**;與 ⌘E 是不同心智模型(回到剛才 vs 去該去的) |
| 8 | **session 比 app 長壽(tmux)** | app 死 = PTY 死 | 安全但**動架構**,且與零遠端安裝衝突 | **立決策文件** |
| 9 | **第三方授權聲明頁** | 無(Apache-2.0 專案,綁了 CM6 / xterm / Plex Mono) | 安全 | **做**(比較像義務不是功能) |
| 10 | **Files 分頁**(樹 + 編輯器 + ⌘P + ⌘⇧F) | 只有 diff 內可編輯 | 安全 | 需決策(要不要往 IDE 走) |
| 11 | **Git 分頁**(分支、commit 歷史、commit 控制) | 只有 attempt diff | 讀取端安全;commit 控制**由人發起**,不違反「app 不主動碰 git 狀態」 | 需決策 |
| 12 | **可改鍵的快捷鍵** | 固定表(⌘/) | 安全 | P2 |
| 13 | **字級 / 版面密度 / Accessibility 區段** | 密度是設計決定(13px body),無使用者控制 | 安全,且是 a11y 論證 | P2 |
| 14 | **grid view 分組與篩選** | 終端牆無分組/篩選 | 安全 | P2 |
| 15 | **general session(無專案)** | 必須 task → attempt → worktree | 安全但**動核心模型** | 需決策(見下) |
| 16 | **fork 對話** | Task 1—N Attempt,但都從 base 開 | 需要 agent 側支援,未必做得到 | 存疑 |
| 17 | **截圖附進初始 prompt** | 無圖片輸入路徑 | 安全 | P3 |
| 18 | **worktree 位置與命名可設定** | 固定 `~/.agentdesk/worktrees/` | 安全 | P3 |
| 19 | **三種專案型態 / 父資料夾多 repo** | 硬綁單一 git repo | **動安全論證** | 暫不做 |
| 20 | **工具列顯示 context-window 使用量** | 抽屜顯示 `語境 {ctx} · ↑{out}`,**刻意不換算百分比** | 他們可能顯示百分比 | **不跟進**——沒有誠實的分母 |

---

## 七、建議

### 第一批:設定與情境表面(S–M,哲學全乾淨)

把「Xirp 的設定頁」當成一份現成規格,對著改 `EnvPanel`:

1. **`Cmd+,` + 搜尋欄 + 分區**(配對 #3、#4)。搜尋欄是這一輪投報率最高的一項:
   它不需要重新設計資訊架構,就治好「差異化功能全藏在一顆灰字按鈕後」——
   前次審查判定的最弱項。分區可直接借他們的骨架,但 **Projects 區段先跳過**(AgentDesk 無專案層)。
2. **Rules + Skills 分頁**(配對 #1、#2)。理由與第一輪相同,且第二輪更確定:
   Xirp 的 Rules 分頁明列 `CLAUDE.md`、`AGENTS.md` **與支援的 agent 設定檔**——
   這是少數能讓 codex / gemini 得到同等價值的功能,直接兌現 PRODUCT.md 的「parity is the goal」。
3. **Prompting 可見化**(配對 #5)。AgentDesk 有 `prompt.rs`,會在 session 開場替使用者組話。
   產品原則 #3 說「app 絕不自己對 agent 說話,每則機器組的訊息都放進人的手裡」——
   開場 prompt 是這條原則目前唯一的灰帶。把「app 加了什麼」列出來(最好可編輯),
   是**用對手的功能兌現自己的原則**,不是抄功能。
4. **重播歡迎導覽 + 第三方授權頁**(配對 #6、#9)。都是數行,後者對 Apache-2.0 專案接近義務。
5. **`Cmd+Shift+K` MRU 切換器**(配對 #7)。與 ⌘E 並存不衝突:
   ⌘E 是「去該去的地方」(注意力),⌘⇧K 是「回到剛才那個」(記憶)。

### 第二批:先量測再決定

6. **持久化 session**(配對 #8)。第一輪列為證據最弱,第二輪證據充分。
   先寫決策文件,要回答的三題:
   - tmux 當硬依賴可不可接受?(Xirp 接受了,並做了缺件安裝指引)
   - SSH 世界怎麼辦?遠端 tmux 是最大的報酬(斷線不死)但打破零遠端安裝的承諾。
   - Windows 原生沒有 tmux,是另做一套還是誠實地在該世界沒有這個能力?
   建議的方向:**持久化是世界的能力,不是 app 的前提**——與「世界是卡片的屬性」同構。
7. **Git 分頁的讀取端**(配對 #11)。分支列表、commit 歷史、ahead/behind 全是唯讀,
   完全不觸碰 agent 看得到的狀態,而且解掉「merge 失敗才知道分支落後」的老問題(前次研究 #5)。
   **commit 控制另議**:它由人發起,所以不違反「app 不主動碰」的字面,但要想清楚
   「人在 app 裡 commit,而 agent 正在同一個 worktree 裡跑」的競態。

### 第三批:需要產品決策,不要順手做

8. **general session(配對 #15)**。這條比看起來重要:
   Xirp 最便宜的第一個動作是「就開一個 agent」,AgentDesk 是「建任務 → 開 attempt → 長 worktree」。
   前次審查說「認知負載全部堆在第一次接觸」——**general session 就是那個缺掉的低門檻入口**。
   但它會動到「Task 1—N Attempt 1—1 Session」這個核心模型,以及
   「一個 attempt 只能花掉自己的分支」這個安全論證。要嘛不做,要嘛想清楚再做。
9. **規模目標**。Xirp 為 50+ 設計(minimap + grid view + 分組 + 篩選 + MRU + 專案層,
   全都是 50 個 session 才需要的東西)。AgentDesk 併發預設 3,介面為 3–10 張卡設計且設計得好。
   **不建議追**,但該回答一個更誠實的問題:AgentDesk 的實際上限是幾張卡,app 有沒有說出來?
   (終端規模化那份量測只答了渲染層的 16 個 WebGL context。)
10. **Files 分頁 / 專案實體 / 多 repo**。三者互相牽連,而且會把 AgentDesk 推向 IDE。
    建議最多只走到「⌘P 在 attempt worktree 裡開檔」——review loop 常需要看 diff 以外的檔案,
    這個需求是真的;完整檔案樹與編輯器則超出「監督多個 agent」的產品邊界。

---

## 八、不要抄的

1. **Portal / catalog 綁定**。AgentDesk 沒有企業目錄,不該假造。
   反面提醒:第三方評論說沒有 Portal 的 Xirp「closer to a nicer multi-harness session switcher」——
   **單機價值必須自己站得住**。
2. **帳號登入**。要 Spotify 帳號才能用一個本機開發工具。無帳號是特色,不是缺陷。
3. **雲端 transcript 上傳**。preview terms 收集的「Customer Session Interaction Data」包含
   prompts、**source code**、repository context、edits 與 accept/reject 決策,
   Spotify 可「store, use, and process... to **develop and improve our products and services**」;
   FAQ 4.3 自承「**Xirp does not scrub or redact credentials**」,把審查責任推給使用者。
   與 no-telemetry 正面衝突。要做知識共享就做本機檔案匯出。
4. **context-window 百分比**(配對 #20)。AgentDesk 已明確拒絕(沒有誠實的分母),維持拒絕。
5. **「switch tools mid-project, the full working state carries over」**。
   跨 harness 帶**對話狀態**走做不到(每個 CLI 的 transcript 格式與 session 概念都不同);
   他們的 session 內換 agent 實際上換的是「在同一個 worktree 裡重開一個別的 CLI」。
   這正是誠實哲學該挑明的模糊地帶。
6. **把 vendor neutrality 當口號**。三個 agent + 要帳號 + macOS only,離 neutral 還有距離。
   AgentDesk 的作法維持:**量得到的才顯示,量不到的戴免責 chip**。

## 九、對外敘事的機會(不點名比較)

- 這個類別現在有大公司背書,「多 agent 桌面控制台」不再需要解釋自己為什麼存在。
- Xirp 的每個限制,剛好是 AgentDesk 已經站著的位置:
  **開源 Apache-2.0 / 無帳號 / 無遙測 / 三平台 + WSL + SSH 三個世界 / 本機優先**。
- 誠實記下 AgentDesk **弱於** Xirp 的地方:設定的可發現性、無情境表面(rules/skills)、
  無檔案瀏覽、無專案層、規模(3 vs 50+)、macOS 以外沒有簽章安裝檔。
- README 值得補一段回答 *why*,但用 AgentDesk 自己的答案:
  **情境不該屬於任何一個 harness,而且不該離開你的機器。**

## 十、證據信度聲明

- **未安裝、未實測**(macOS only)。UI 描述來自官方 `.md` 原文與其截圖檔名,無截圖內容驗證。
  版面細節(minimap 長什麼樣、grid view 的分組怎麼操作)只有文字描述。
- 配對 #8(tmux 持久化)有三條互相佐證的官方文字(依賴清單、FAQ 2.3、debug 頁的 daemon 字樣),
  信度**高於**其他各項,但仍未親手驗證 tmux 是不是持久化的實作方式——
  也可能 tmux 另有用途而持久化來自別的 daemon。動工前需確認。
- 規模數字全部自陳且官方兩處矛盾。當作「這個量級存在」看待,不要引用具體數字。
- 主要來源:`backstage.spotify.com/docs/llms.txt` 列出的十四頁中的八頁 `.md` 原文、
  `portal.spotify.com/blog/introducing-xirp`、`xirp.spotify.com`、
  `backstage.spotify.com/spotify-for-backstage-terms/xirp-preview-terms/`、
  explainx.ai 的第三方分析。
