# Xirp 研究：同陣營競品第一次出現,而且來自 Spotify

> 2026-08-11 · 研究對象:Spotify Xirp(2026-08-10 公開 beta)。
> 資料來源全部為官方一手文件與公開報導,**未實際安裝**(macOS only,本機無 macOS)——
> 凡標「未驗證」者,依產品原則 #4「借來的機制在親手量測前都是未經查證的二手資訊」處理。

---

## 一、Xirp 是什麼

一句話:**Spotify 內部長出來的多 agent 桌面控制台,2026-08-10 開放公測。**

官方定義:「run and manage local AI coding sessions across projects, agents, and Git worktrees」。
支援 Claude Code / Codex / Gemini,macOS only,閉源,需 Spotify 帳號登入。

四項核心能力(官方列表):

1. **Parallel sessions** — 多個持久 agent session 同時跑,切換不掉狀態
2. **Project isolation** — 每個任務一個 git worktree
3. **Unified control** — 終端、檔案、git 變更、session 狀態在同一個介面
4. **Optional Portal integration** — 接上 Spotify Portal 取得組織情境

規模數字(官方自陳,未經第三方驗證,且官方兩處數字互相矛盾):
「thousands of Spotify engineers... across more than 36,000 sessions」(engineering blog)
vs「1,300+ Spotify engineers already use it」(X)。宣稱可協調「50+ parallel sessions」。

## 二、與 AgentDesk 的機制對照

**這是類別裡第一次出現與 AgentDesk 核心機制一致的對手。**先前的研究(`frontend-patterns-research.md`)
記錄的是「五分之四的市場把 agent 輸出重繪成聊天泡泡」,唯一同陣營的 Claude Squad 用 magic-string
螢幕比對。Xirp 把三件事都做對了:

| 機制 | AgentDesk | Xirp | 判定 |
|---|---|---|---|
| 終端 | 真 PTY,不重繪 | 「The agent starts in a persistent terminal」 | **一致** |
| 隔離 | 每 attempt 一個 worktree | 每 session 可選 main checkout 或新 worktree | **一致** |
| 狀態偵測 | Claude Code hooks,絕不解析 ANSI | 「session hooks」偵測 working / idle / waiting for input,onboarding 明說「without granting additional permissions」 | **一致** |
| 多 agent | Claude / codex / gemini,非 Claude 誠實降級 | Claude Code / Codex / Gemini,vendor neutrality 列為第一原則 | **一致,但他們當旗幟舉** |

三個核心賭注被一家有數千名工程師實測資料的公司獨立驗證。**這是本研究最重要的一行:核心不用動。**

## 三、Xirp 真正的論點,以及它跟 AgentDesk 的分歧

Xirp 的落地頁標題不是講終端,是講情境:

> **「Know your systems. So your agents can too.」**
> 「connects to your services, ownership, docs, and architectural decisions —
> so every AI coding session starts with real context, not guesswork.」

他們把這個類別重新定義為**檢索問題**,不是文件問題:知識散在人與人的對話裡,agent 拿不到,
於是做出「technically correct and operationally wrong」的決定。發表文列出他們在規模下撞到的三件事:

1. **重複發現** — 「Agents in one session would expend cycles rediscovering what another session had already resolved」
2. **重建成本** — 工程師「投入在重建情境上的力氣,跟拿去蓋新東西的一樣多」
3. **碎片化** — 機構知識散進個人設定(各自的 CLAUDE.md、各自的 MCP 配置)

**分歧就在這裡。** AgentDesk 的 positioning 是機制主張(「每個 session 都是真終端」)——它回答的是
*how*,而且回答得比誰都硬。Xirp 回答的是 *why*:為什麼你需要一個 app 而不是十個終端分頁。

他們的答案(接企業 catalog)AgentDesk 抄不了也不該抄。但**問題是真的**,而且 AgentDesk 已經有
一整套本機版的答案零件(worktree、checkpoints、transcript、rules/skills、跨 session 訊息),
只是從來沒有被組織成一個論點。

## 四、模式 → 缺口配對表

沿用前次研究的格式:Xirp 已驗證的模式,對上 AgentDesk 的現況。

| # | Xirp 的做法 | AgentDesk 現況 | 哲學檢查 | 嚴重度 |
|---|---|---|---|---|
| 1 | **Rules 分頁**:CLAUDE.md / AGENTS.md 集中呈現,「help agents follow repository conventions」 | 無;`prompt.rs` 有相關字串但無 UI 表面 | 安全(app 自己的畫布) | **P1** |
| 2 | **Skills 分頁**:列出 global + project 兩層 skill 資料夾,「for repeatable tasks like releases or migrations」 | 無 | 安全 | **P1** |
| 3 | **Files 分頁**:檔案樹 + 編輯器 + markdown 預覽,⌘P 開檔、⌘⇧F 全專案搜尋、⌘E 從 session 切編輯器 | 只有 diff 內可編輯(CM6);看 diff 以外的檔案要離開 app | 安全 | P2 |
| 4 | **三種 project 型態**:git repo / 非 git 資料夾 / 父資料夾含多個 repo(跨 repo agent 工作) | 硬綁單一 git repo(worktree 模型的前提) | 安全但**動到核心模型** | 需決策 |
| 5 | **PR 監看**列在「不需 Portal 也能用」的核心清單 | 明確拒絕(「merge / open-PR is the end of the pipeline」);roadmap 遠期有「PR 狀態唯讀 chip」 | 唯讀 chip 安全;PR review/CI 仍該拒 | 需重新評估 |
| 6 | **Session minimap**,位置可選(上 / 左 / 右),onboarding 就問 | 固定 220px 左側欄 | 安全 | P3 |
| 7 | **卡片 / 精簡列表雙檢視**,列表直接顯示每個 agent 用哪條分支 | 看板 + 終端牆 + overview 三視圖,無精簡列表 | 安全 | P3 |
| 8 | **session 比 app 長壽**:「You can leave the page, open another session, or **close and reopen Xirp without ending the underlying session**」 | app 結束 = PTY 結束;重開靠 `claude --continue` 重建對話,scrollback 不落盤 | 安全但**是架構決策** | **未驗證,先量測** |
| 9 | **專案 pin / 改名 / 從父資料夾匯入**;移除不刪本機資料夾 | 無專案層概念(卡片直接綁路徑) | 安全 | P3 |
| 10 | **情境跨 session 流動**:transcript 上傳 → 隊友與未來 session 可用 | 跨 session 訊息要人手動轉述 | 雲端版**違反 no-telemetry**;本機版安全 | 需決策 |

## 五、建議

### 立刻做(低成本,哲學乾淨,而且剛好補「非 Claude 平價」)

1. **Rules 分頁 + Skills 分頁**(配對 #1、#2)。這兩個是本研究成本效益最高的一項,理由有三:
   (a) 純 app 畫布,零哲學風險;(b) `CLAUDE.md` / `AGENTS.md` / skills 目錄**對 codex 與 gemini 一樣有效**
   ——這是少數能讓非 Claude agent 得到同等價值的功能,直接兌現 PRODUCT.md 的「parity is the goal」;
   (c) 它是 AgentDesk 版「情境層」的第一塊磚,而且完全在本機。
2. **Hooks 開關升格為一等公民**。Xirp 把 session hooks 做成 onboarding 的明確一步,並且用一句
   「without granting additional permissions」處理信任。AgentDesk 的 hooks 是整個狀態軸的地基,
   對使用者卻近乎隱形。給它一個明說的開關與一句同等誠實的文案,同時解決信任與可發現性。
3. **精簡列表檢視 + 卡片顯示分支名**(配對 #7)。小改動,session 一多就有意義。

### 先量測再決定

4. **session 是否該比 app 長壽**(配對 #8)。這是兩者之間唯一真正的架構分歧,也是本研究裡
   風險與報酬都最大的一項。動工前必須先做兩件事:
   - **驗證 Xirp 到底做了什麼**:退出 app 後 agent 程序是否還在(需要一台 macOS)。
     官方文句也可能只是指「離開該頁面 / 關掉視窗」,不是離開 app。**現階段記為未驗證。**
   - **如果為真**,它意味著一個 detached agent host(常駐程序)。報酬:app 崩潰不殺 agent、
     長跑任務不綁 app、scrollback 有處可續、而且**遠端 companion(`UiSink` seam)幾乎必然需要它**。
     成本:常駐程序生命週期、孤兒清理、升級、Windows 差異——每一項都不便宜。
     先寫一頁決策文件,不要直接開工。
5. **PR 狀態唯讀 chip**(配對 #5)。原本的拒絕理由是「merge / open-PR 是管線的終點」——這個理由
   對「做 PR review 與 CI」仍然成立,但對「顯示這條分支的 PR 現在是紅是綠」不成立。
   Xirp 把它放進不需 Portal 的核心清單,是市場訊號但不是理由;理由應該是:**閉環的最後一格回饋現在是空的**。

### 需要產品決策(不要順手做)

6. **規模目標是多少?** Xirp 為 50+ 平行 session 設計,AgentDesk 的併發預設是 3。
   AgentDesk 現在的介面(四欄看板、終端牆、220px 側欄、每個 pane 最小 490×350)是為
   **3–10 張卡**設計的,而且設計得很好。往 50 走不是加個 minimap 就行,是整套注意力表面的重寫。
   **現況最誠實的問題是:AgentDesk 的實際上限是多少張卡,而且 app 有沒有誠實說出來?**
   終端規模化那份量測(16 個 WebGL context 上限)已經是這個問題的第一個答案,但只答了渲染層。
7. **跨 session 情境要不要做本機版?**(配對 #10)Xirp 的答案是把 transcript 上傳到雲端 Workspace。
   AgentDesk 的等價物只能是本機的:例如把某個 attempt 的 transcript / checkpoint 摘要
   存進 repo 的 `.agentdesk/`,讓下一個 attempt 的第一則 prompt 可以引用它。
   注意產品原則 #3:**組好的訊息永遠放進人的手裡,送不送是人決定的**——這條在這裡特別容易被違反。
8. **多 repo / 非 git 資料夾**(配對 #4)。worktree 模型是 AgentDesk 的安全論證的地基
   (「一個 attempt 只能花掉自己的分支」)。非 git 資料夾沒有這個保障,父資料夾多 repo 則讓
   「一個 attempt = 一條分支」的等式失效。Xirp 用「limited repository-level controls」帶過,
   AgentDesk 若要做,得先想清楚安全論證怎麼重寫。**我的建議是暫不做**,但要知道這是真實需求。

## 六、不要抄的

1. **Portal / catalog 綁定**。AgentDesk 沒有企業目錄,也不該假造一個。Xirp 自己的第三方評論說得很直白:
   沒有 Portal,它「closer to a nicer multi-harness session switcher」——這句話反過來就是
   AgentDesk 該注意的:**單機價值必須自己站得住**。
2. **帳號登入**。Xirp 要 Spotify 帳號才能用一個本機開發工具。無帳號是 AgentDesk 的特色,不是缺陷。
3. **雲端 transcript 上傳**。Xirp 的 preview terms 寫得很寬:收集的
   「Customer Session Interaction Data」包含 prompts、**source code**、repository context、model responses、
   edits 與 accept/reject 決策,而 Spotify 可以「store, use, and process... to provide, maintain,
   **develop and improve our products and services**」。這與 AgentDesk 的 no-telemetry 是正面衝突。
   要做知識共享,做成本機檔案匯出。
4. **「switch tools mid-project, the full working state carries over」這個承諾**。
   跨 harness 帶著**對話狀態**走做不到(每個 CLI 的 transcript 格式與 session 概念都不同);
   他們大概是指 worktree 與檔案狀態延續。這正是「誠實優先」該挑明的模糊地帶——
   AgentDesk 的 no-signal chip 就是同一問題的誠實版本,保持。
5. **把 vendor neutrality 當口號**。三個 agent + 要帳號 + macOS only,離「neutral」還有距離。
   AgentDesk 的 parity 承諾要維持現在的作法:**能量到的才顯示,量不到的戴免責 chip**。

## 七、對外敘事的機會(不點名比較)

Xirp 的存在把幾件事變成可說的:

- **這個類別現在有大公司背書**,「多 agent 桌面控制台」不再需要解釋自己為什麼存在。
- Xirp 的每一個限制,剛好是 AgentDesk 已經站著的位置:
  **開源 Apache-2.0 / 無帳號 / 無遙測 / 跨三平台 + WSL + SSH 三個世界 / 本機優先**。
  這些原本是工程事實,現在是差異化。
- 但也要誠實記下 AgentDesk 目前**弱於** Xirp 的地方:規模(3 vs 50+)、
  情境層(無 rules/skills 表面)、檔案瀏覽、專案層概念、macOS 以外沒有簽章安裝檔。

README 值得補一段回答 *why*(而不只是 *how*)的話——但要用 AgentDesk 自己的答案:
**情境不該屬於任何一個 harness,而且不該離開你的機器。**

## 八、證據信度聲明

- **未安裝、未實測**(macOS only)。所有 UI 描述來自官方文件文字,無截圖驗證。
- 配對 #8(session 比 app 長壽)是本文件唯一可能改變架構的一項,且**證據最弱**:
  一句可雙解的官方文句。動工前必須親手驗證。
- 規模數字全部自陳,且官方兩處互相矛盾(36,000 sessions / thousands of engineers vs 1,300+ engineers)。
  當作「這個量級是真的存在」看待,不要引用具體數字。
- Portal 與 Workspace 的行為描述來自 Xirp 文件對 Portal 的說明,未從 Portal 側交叉驗證。
- 主要來源:`backstage.spotify.com/docs/xirp`(index / getting-started / xirp-and-portal /
  projects / workspaces)、`portal.spotify.com/blog/introducing-xirp`、`xirp.spotify.com`、
  `backstage.spotify.com/spotify-for-backstage-terms/xirp-preview-terms/`。
