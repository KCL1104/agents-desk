# 前端模式研究:向 Vibe Kanban、Conductor、Claude Squad 等工具學什麼

> 2026-08 · 研究對象:Vibe Kanban(原始碼)、Claude Squad(原始碼)、Conductor(公開資料)、
> Crystal / opcode / emdash / Happy Coder / Omnara(原始碼與公開資料),
> 並以 impeccable 設計準則對 Marol 現有前端做了誠實審查。
> 所有 `file:line` 引用以研究當日的 main / 各 repo 預設分支為準。

---

## 一、先畫線:哲學邊界

Marol 的核心承諾是「每個 session 都是真終端,絕不重繪或重新詮釋」。整份研究的每個建議都先過這條線。明確定義如下:

**安全(可以放心採用)**
- Claude Code hooks(`UserPromptSubmit` / `PreToolUse` / `Notification` / `Stop` / `SessionEnd`)——現有機制,`hooks.rs` 已實作。
- git 側資料:diff、numstat、ahead/behind、分支狀態——讀 worktree,與終端無關。
- Claude 自己寫在磁碟上的紀錄(`~/.claude/projects/` 的 transcript JSONL)——讀 agent 自己的檔案,不是解析它的螢幕。token/cost 資料只存在這裡,hooks 不帶。
- App 自己渲染的表面(Changes 抽屜、Activity 時間軸、看板卡片)——本來就是 app 的畫布,加語法上色、檔案樹都不違反承諾。

**灰帶(可用,但必須誠實標示為啟發式)**
- PTY byte 流量心跳:「輸出最近有沒有變」(Claude Squad 用 pane 內容 hash)。它量的是位元組有沒有流動,不解讀意義。對 codex/gemini/aider 這三個目前只有「執行中/已結束」兩態的 CLI,這能給出「活躍 / 安靜了 N 秒(可能在等你)」的第三態——但 UI 必須寫「安靜」而不是「⚠ 等你授權」,誠實面對它是猜測。

**違反(看到也不能抄)**
- 把 agent 輸出重繪成聊天泡泡(Vibe Kanban、Conductor、Crystal、opcode、Happy、emdash——五分之四的市場都這麼做,`src-tauri/parked/` 就是量測後拒絕它的證據)。
- Magic-string 螢幕比對(Claude Squad 用「No, and tell Claude what to do differently」等字串偵測授權提示——CLI 改個字就靜默壞掉)。
- 鍵擊注入式自動同意(Claude Squad 的 AutoYes daemon)——Marol 的 per-attempt `--permission-mode` 是誠實的等價物。
- 每則訊息的 token 計量 UI(Conductor)——需要 SDK 層存取,PTY app 做不到且不該做。

**市場給的最大訊號**:Conductor 是反方向的收斂證據——它從 SDK-chat 起家,最後被使用者逼著長出「Big Terminal Mode」(HN:「There's a "feel" to the way Claude Code outputs the text… this is lost with conductor」)。**Marol 的核心賭注是對的,不用動搖;要補的是賭注周圍的體驗。**

---

## 二、五個工具速覽

| 工具 | 形態 | 一句話 | 最值得學的一件事 |
|---|---|---|---|
| **Vibe Kanban**(BloopAI,已宣布 sunset) | React SPA + Rust | 看板規劃 + workspace 執行的雙表面 IA,agent 輸出重繪為 chat | 單一 action registry(1,565 行)同時餵 Cmd+K、快捷鍵、選單;五種 glyph 的狀態語言 |
| **Claude Squad**(smtg-ai) | Go TUI + tmux | 唯一與 Marol 同陣營(真終端)的工具 | 一次性情境教學(bitmask 記錄);graded-cost 輪詢;attempt 專屬 shell 分頁 |
| **Conductor**(Melty,閉源 Mac) | Tauri + React,SDK-chat | 公認設計最好;$22M A 輪 | 「建議下一步動作」——從 git 狀態推導單一 CTA,把 N 個終端變成一條決策佇列 |
| **Crystal → Nimbalyst**(stravu) | Electron → 新 MIT 桌面 app | 架構最接近 Marol(worktree 平行 session) | `completed_unviewed`:「在你沒看的時候做完了」是獨立狀態 |
| **opcode / emdash / Happy** | Tauri / Electron / RN | 各自一招 | opcode:checkpoint 時間軸;emdash:命令面板兼注意力收件匣;Happy:blocked 才推播 |

全類別收斂的共識:**worktree-per-task、側欄 session 清單 + 詳情面板、diff 就在對話旁邊、只在 blocked 時通知、約五態的狀態字彙**。Marol 的 hook 狀態軸(running / waiting-permission / waiting-you / awaiting-trust / idle / ended)比多數對手更豐富——缺的是下面配對表裡的東西。

---

## 三、模式 → 缺口配對表

競品已驗證的模式,對上審查在 Marol 找到的具體缺口:

| # | 競品模式(出處) | Marol 現況缺口 | 嚴重度 |
|---|---|---|---|
| 1 | `completed_unviewed` 未讀狀態(Crystal `StatusIndicator.tsx:80-90`;VK `has_unseen_turns`) | 只有「等你」有注意力系統;「趁你不在時做完了」不存在——完成的工作靜默腐爛 | **缺口清單漏掉的最大項** |
| 2 | 草稿留言持久化(emdash `draft-comments-store.ts`) | review 留言存在 `AttemptInspector.tsx:67` 的 local state,⌘I、切 pane、換 attempt 都會**無預警清空半寫的批次**(`App.tsx:827`、`AttemptInspector.tsx:106-109`)——旗艦功能的文字保護比任何對話框都弱 | P1 |
| 3 | 一次性情境教學(Claude Squad `help.go:130-163` bitmask;VK `seen_features`) | 首次體驗只有一句 `pane.emptyFirstRun`(`Pane.tsx:221`);card→attempt→worktree 的心智模型只活在 README | P1 |
| 4 | Action registry + Cmd+K(VK `shared/actions/index.ts`;emdash palette 首組是注意力收件匣) | Profiles、messaging、scripts、themes 全藏在側欄底部 11px 灰字「Environment」按鈕後(`SessionList.tsx:105-107`);無全域搜尋、無面板;手勢只活在 tooltip,違反 app 自己的規則(`ShortcutsDialog.tsx:5-8`) | P1 |
| 5 | 建議下一步動作(Conductor docs/reference/diff-viewer)+ ahead/behind(Crystal `GitStatusIndicator.tsx:25-82`) | Finish 是靜態三鍵選單;merge 失敗才知道 branch 已落後;PR URL 是死文字(`AttemptInspector.tsx:429-433`) | P2 |
| 6 | Graded-cost 輪詢(Claude Squad `app.go:945-982`:選中的算完整 diff,其餘只算 numstat) | 卡片上沒有 +N/−M diffstat;diff 無「擷取於 HH:MM」時間戳,可能讀著過期內容而不自知 | P2 |
| 7 | 每 attempt 專屬 shell 分頁(Claude Squad `ui/terminal.go`) | 想在 attempt 的 worktree 跑個 `git log` 得自己 cd 進 worktree 路徑;▶ run scripts 只涵蓋預先定義的指令 | 功能缺口 |
| 8 | Checkpoint(Conductor:hook → private git ref;Crystal:每輪自動 commit) | 完全沒有「回到這輪之前」的機制;審查也漏了這項 | 功能缺口 |
| 9 | 佇列 follow-up(VK `useSessionQueueInteraction.ts`) | agent 執行中想到下一個指令,只能記在腦裡或打斷它 | 功能缺口 |
| 10 | 暫停/parked(Claude Squad `instance.go:412-496`;Conductor archive+restore) | attempt 只有「活著」或「終局」;沒有「還我worktree、留著分支、之後再繼續」的中間態 | 功能缺口 |

---

## 四、建議

### Tier 1 — 快贏(S 工作量,多數 CSS/local-state 層級)

1. **「完成但未看」第三態**(配對 #1)。Stop hook 到達時 pane 沒有焦點 → 記一筆 unseen;卡片、tab、側欄 row 掛上與 ⚠ 不同的圓點(VK 用品牌色實心點),聚焦即清除。純 hooks + focus 追蹤,SQLite 加一欄。這是整個類別最一致的標準答案。
2. **修 review 留言遺失**(配對 #2)。把 comments state 提升到 App、以 attempt.id 為 key(或 ref map 持久化),非空批次要關閉時先確認。
3. **狀態圓點語意分離**。`waiting_input` 與 `waiting_permission` 只差 opacity 0.7、`starting` 與 `running` 只差 opacity 0.5(`styles.css:140-143`)——7px 下不可辨,而且 opacity-on-color 正是 stylesheet 自己註解警告的反模式。給每態獨立色相,或學 VK 的形狀語言(點=執行、手=授權、三角=錯誤),色彩+形狀雙重編碼耐色盲。ad-hoc chips 的 needs-you 也該同步呼吸動畫(`styles.css:627` vs `579`)。
4. **卡片 diffstat 徽章**。每個開放 attempt 顯示 +N/−M(`git diff --numstat`,學 Claude Squad:只有打開的 inspector 算完整 diff)。搭配 **ahead/behind vs base**(兩個 `rev-list --count`),merge 會失敗在按下之前就看得到。注意 Claude Squad 的 `git add -N`(intent-to-add)技巧,讓 untracked 新檔在 plain `git diff` 裡有逐行 diff——值得對照現有實作。
5. **PR URL 變真連結** + 複製按鈕(一行改動,閉環 PR 路徑)。
6. **⚡/✎ 模式徽章上 pane header 與 topbar**(`Pane.tsx:128-137`、`App.tsx:654-659`)。README 承諾「安靜的自主比什麼都糟」,但監督實際發生的畫面裡它正是安靜的。class 與 i18n key 都已存在。
7. **Diff 標頭列**:「N 檔 · +A −D · 擷取於 HH:MM ↻」——資料已逐 section 算好(`AttemptInspector.tsx:485-507`),加總即可,同時解掉過期 diff 問題。timeline 抓取失敗也要顯示錯誤,而不是偽裝成「尚無活動」(`AttemptInspector.tsx:92-95`)。
8. **一次性教學(coach marks)**,學 Claude Squad 的 bitmask:四個時刻各教一次——首次啟動 attempt(worktree 是什麼、trust 提示為何出現)、首次 Finish(merge 會凍結 diff 收回 worktree)、首次 ⚡ 啟動、首次進入終端 pane(哪些鍵離開、Ctrl+字母屬於 shell)。錨定 popover,不用 modal。
9. **通知偏好 + 測試按鈕**(Crystal `NotificationSettings.tsx`):授權 / 等輸入 / 完成三事件各自開關,加「送測試通知」。放進現有 EnvPanel。另外學 VK:啟動時先吞掉既有 backlog 再開始通知,避免重啟通知風暴。
10. **首次啟動偵測面板**(opcode 模式):Marol 已經 probe login-shell env、`claude --version`、WSL distros——把 probing 結果做成第一畫面「找到 claude 2.1.x ✓ / codex ✗ / 2 個 WSL distro」,誠實且全是現成資料。
11. **對話框收尾**:Create/Start 加 in-flight disabled(防雙擊開兩個 worktree;Finish footer 已有正確示範)、`.modal` 加 `max-height: 90vh; overflow-y: auto`、單行輸入 Enter 送出、`NewSessionDialog.tsx:82` 硬編碼的 `Agent` label 改用 `t()`。
12. **等待 banner 改為循環**(`SessionList.tsx:64` 永遠開 `waiting[0]`,與 ⌘E 行為分歧——重用 cycle 邏輯)。
13. **側欄依「等你 / 執行中 / 閒置」分組**(VK Needs Attention accordion),並解決「idle 被歸進『等你』區但不算進 ⚠ 徽章」的自相矛盾(`sections.ts:54` vs `types.ts:20-24`)。
14. **世界分組**(Happy 的 machine separator):overview 與終端牆按 local / wsl:// 分組,組頭可點(顯示該世界的 PATH probe 狀態)。M10 的資料都在。
15. **非 Claude 卡片顯示「無狀態訊號」淡色 chip**(`reports_status` 已在 `types.ts:108-109`,只是板上沒用)——「安靜」不能被誤讀為「沒事」。

### Tier 2 — 結構投資(M)

16. **Cmd+K 命令面板,首組是注意力收件匣**(emdash `palette-notifications-group.tsx`)。搭配小型 **action registry**(VK 的做法,不用框架:`{id, i18n key, when(state), run()}`),同一張表餵面板、⌘/ 說明、未來選單——快捷鍵與文件永不漂移(Claude Squad 的 keys.go 同一哲學)。一次解掉三個審查缺口:mega-modal 可發現性、無全域搜尋、tooltip-only 手勢。
17. **建議下一步動作**(Conductor 的招牌,完全 git 推導、哲學乾淨):卡片/抽屜依客觀狀態亮出唯一主 CTA——「有未提交變更 → 檢視 diff」「乾淨且領先 base → merge 或 PR」「落後 base → 先 rebase」。把 N 個平行終端變成一條決策佇列。
18. **Diff 檢視升級**:檔案清單/跳轉選單、依 VK 的 collapse policy(刪除檔/改名/>800 行自動摺疊)、mark-as-viewed(Conductor)、wrap 切換、app 端語法上色(哲學安全——這是 app 自己的渲染)。460px 抽屜寬度改可拖(Splitter 元件已存在,`styles.css:650`)。j/k 加檔案層級跳躍。agent 動輒產出 1500 行 diff,這是 review 瓶頸的主戰場。
19. **每 attempt 的自由 shell 分頁**(Claude Squad 最符合哲學的功能):在 attempt worktree 開第二個 PTY 跑登入 shell,同一條 xterm 管線、排除在 status hooks 外。WSL/SSH seam 已能載任意指令。README 自己說 worktree 路徑「是一條你打得出來的路徑」——那就替使用者打好。
20. **選中卡片的即時終端預覽**(Claude Squad list+preview):xterm buffer 已經在了,同樣的位元組,零重繪。看板選卡即見真 TUI 縮影,triage 不必先跳進去。
21. **佇列 follow-up**(VK):執行中輸入的訊息顯示為可取消的 banner,Stop hook 到達時經 bracketed paste 注入——與 M5 review 批次同一條路。
22. **Branch picker 升級**(Claude Squad 完整規格可直接抄):開啟時背景 `git fetch --prune`、`--sort=-committerdate` 近期優先、150ms debounce、版本 token 拒絕過期結果、「新分支」合成列在完全匹配時自動隱藏。
23. **鍵盤補洞**:⌘I 之後給一個落點讓焦點進 diff `<pre>`(旗艦鍵盤迴圈目前沒有鍵盤入口)、splitter 的 `role="separator"` 補 tabindex+方向鍵、看板欄內順序鍵盤化、確認對話框吃 y/Enter(Claude Squad)。
24. **時間軸豐富化**(hooks 資料,哲學安全):相對時間、連續同工具呼叫摺疊、SendMessage 跨 session 條目視覺區分、`status:waiting` 列標出它花掉的時間。

### Tier 3 — 大型功能(L,先決策再投入)

25. **Checkpoints**。機制用 Conductor 的(標示:閉源、機制為第三方轉述推斷):UserPromptSubmit hook 已逐輪觸發,每輪前 commit 到 `refs/marol/checkpoints/<attempt>/<n>`,working branch 歷史保持乾淨;UI 錨定在 Activity 時間軸(「還原 worktree 到此 prompt 之前」),**只還原程式碼、永不動對話**(Conductor 會刪訊息——那是要避開的半邊)。Claude Code 自身已有 /rewind,但 checkpoints 仍涵蓋非輪次對齊的狀態與非 Claude agent。
26. **暫停/parked 狀態**(Claude Squad pause/checkout + Conductor archive 的合體):凍結 session、保留分支、釋放 worktree 與併發槽、隱藏出預設看板;之後 `--continue` 在重建的 worktree 恢復。填補「活著 vs 終局」之間的重要中間態,也是「換我自己改一下」這個最常見人類需求的正名。Claude Squad 的細節:pause 時把分支名複製進剪貼簿——下一個要打的字正是 `git checkout <branch>`。
27. **內嵌 dev-server 預覽**(VK 的殺手級功能,哲學相容——預覽的是**你的 app**,不是 agent):M6 已經替每個 worktree 起 dev server 配 `$MAROL_PORT`,只是從沒顯示過。加 iframe/webview 面板;進階版是 inspect mode——點預覽裡的元素,抽出 component/file/line,經 bracketed paste 送進 TUI(「把這顆按鈕改大」附機器可讀座標)。
28. **可編輯 diff**(Crystal/emdash):一半的 review 意見是瑣事(改名、錯字),來回一輪 agent 太貴;讓 Changes 抽屜的 working-tree 側可直接編輯(凍結 diff 維持唯讀)。實作建議 CodeMirror 6 merge view,Monaco 對手寫 CSS 的精簡技術棧太重。
29. **Cost / context 顯示**(hooks 沒有 token 資料——來源只能是 `~/.claude/projects/` transcript JSONL,讀 agent 自己的磁碟紀錄,哲學上站得住):Activity 抽屜給每 attempt 一行 cost/context;VK 的 20px 放射狀 context gauge(50/75/90% 變色)是好參考。**不做**即時終端 token ticker(需要串流解析)。反面教材:Crystal 把 Sonnet 單價寫死在 UI 裡算成本——永遠從 transcript 記錄取,不要內建價目表。

### 終端規模化(審查與競品都沒蓋到,自查補上)

- **WebGL context 上限**:每個 session 都掛著自己的 `WebglAddon`(`TerminalView.tsx:79`),WebView 通常只允許 8–16 個活躍 WebGL context——併發故事最需要的時刻正是靜默降級的時刻。context-loss fallback 存在(`:80-82`)但成本未量測。方向:只給可見 pane WebGL、隱藏者換回 DOM renderer,或共享 renderer 策略。
- **SearchAddon 缺席**:跨 10k 行 scrollback 找輸出只能用眼睛。
- **WebLinksAddon 缺席**:終端輸出裡的 URL 不可點——「PR URL 是死文字」的終端層雙胞胎。
- Scrollback 不跨 app 重啟(replay buffer 只活在 PTY 存續期間)——至少該在 UI 承認,或評估落盤。

### 視覺系統(impeccable 向)

- **型階與間距階**:目前 10–20px 七種字級、2–22px 任意間距(`styles.css` 全域),只有顏色/radius/mono 被 token 化。學 VK:一張 6 檔尺寸表推導字級、icon、radius、間距——「精緻感」多半來自這種一致性。
- **圖示**:⚠ ✕ ▸ ⤢ ↻ ⎇ ▶ ＋ ⚡ ✎ 是 unicode 字形,粗細與 metrics 隨平台字型漂移(同 codebase 裡 ＋ 與 + 並存:`Board.tsx:161` vs `SessionList.tsx:59`)。換一套內嵌 SVG(Phosphor/Lucide 風格,只挑用到的十幾顆)。
- **動效字彙**:只保留兩種語意——「現在活著」(執行中卡片的 border 微光,VK border-flash 的 mask-composite 技巧)與「你的下一步」(空看板時 New card 微光)。兩者都要掛 `prefers-reduced-motion`(VK 忘了掛在 chat-box 上——抄 guard,別抄疏漏)。抽屜開合目前是硬切且瞬間 reflow 所有終端,值得一個 150ms 的 width transition。
- **招牌元素**:呼吸中的 needs-you 卡片已是候選——命名它、強化它,讓它成為 Marol 的識別,如同 Conductor 的城市護照。溫暖、克制、一個記憶點,是 Conductor 設計獲讚的全部配方。
- **Merged 專色**:VK 給 merged 狀態獨立紫色 token——Finish 三態(merged/discarded/superseded)值得色彩區分。

---

## 五、Marol 審查摘要(impeccable 準則)

**做得好、且多數競品沒做到的**:多通道「等你」注意力系統(banner + 呼吸卡 + tab 徽章 + aria-live + ⌘E + dock badge);「door」模式讓可點卡片保持合法 ARIA;後果成比例的 armed 二擊確認;STATUS_KEY 單一事實來源;11-token 主題系統含即時 WCAG 對比;錯誤哲學(toast 堆疊不驅逐、FriendlyError 原文一鍵展開、merge 拒絕全文顯示);i18n 編譯期完整性保證。

**Nielsen 十項的誠實分數**(0–4 級距,全網真實產品多落在 20–32/40):約 **26/40**。最弱兩項:**辨識重於回憶(5/10 換算)**——差異化功能全藏在一顆 11px 灰字按鈕後;**求助與文件(4/10 換算)**——概念模型只活在 README。最強:狀態可見性(Claude session 部分近乎教科書)、錯誤預防。

**認知負載**:穩態操作極佳(settle window、共享計時器、選中列釘住都是罕見的用心);負載全部堆在第一次接觸(三種視圖、兩種 session、零鷹架)。

---

## 六、不要抄的(反模式清單)

1. **Chat 重繪**——類別多數派,但 opcode 的 ToolWidgets.tsx 是 2,500 行、25+ 個 widget 的無底維護跑步機,壞法是靜默的。parked/ 目錄已經是答案。
2. **假進度條**——Crystal 把狀態映射成寫死的百分比(initializing=25%…)。量不到的東西不要畫成量表;真終端建立的信任經不起這種侵蝕。
3. **一行式錯誤截斷 + 3 秒自動消失**(Claude Squad)——通道(toast)可學,內容不可;要求動作的錯誤永不自動消失。
4. **Kill 順手刪分支**(Claude Squad `git branch -D`)——凍結 diff 再收 worktree 的現行模型嚴格更安全。
5. **依賴最大化**——VK 疊了 Tailwind+Radix+cmdk+NiceModal+Lexical+兩套虛擬化庫;抄模式,不抄套件。
6. **timer 猜測式同步防抖**(VK 拖放後 500ms setTimeout 防跳回)——序號紀律(PTY replay 已在用)是正確工具。
7. **桌面 app 遠端載入 Google Fonts**(VK stylesheet 第一行)——離線即壞、啟動閃動。
8. **`new Audio()` 播通知音**——會註冊進 macOS NowPlaying 搶媒體鍵;VK 的註解教訓:用 AudioContext。這是 README 蒐集的那種「量測過的地雷」。

---

## 七、證據信度聲明

- **Conductor 全部二手**(閉源):HN 創辦人發言、官方 docs/changelog、performance.dev 改寫報導。其 checkpoint 機制(hook → private ref)為第三方轉述,採用前需自行驗證。
- **Crystal 已於 2026-02 廢棄**,接替者 [Nimbalyst](https://github.com/nimbalyst/nimbalyst)(MIT,Crystal 全功能 + session kanban + markdown/mockup 視覺編輯器 + iOS/Android companion)本研究只做了概況確認,未深讀原始碼。
- 「側欄才是收斂 IA、看板不是」的論斷樣本太薄(五工具中一個叫 vibe-KANBAN、兩個已轉向/收攤),當假設看待即可——何況 Nimbalyst 又把 kanban 加了回來。Marol 的雙軸看板(欄位=人放的、燈=agent 報的)本就比類別的混淆版更好,結論是「終端牆與 overview 要當共同一等公民投資」,不是「棄板」。
- Happy(23k stars)證明的類別最大未滿足需求是**遠端解鎖 blocked agent**;`UiSink` trait 的架構註解已預留這條 seam,列為長期方向,非近期前端工作。
- 星數為研究當日快照,僅作聲量參考。

---

## 八、建議的執行順序

1. **第一批(1–2 天級)**:Tier 1 的 #1–#7、#11、#12——unseen 狀態、review 留言保護、圓點語意、diffstat/ahead-behind、PR 連結、⚡ 徽章、diff 標頭、對話框收尾。全是小改動,合計即可明顯抬升日常體感。
2. **第二批(一週級)**:coach marks(#8)+ 首啟偵測(#10)+ 通知偏好(#9)——把「第一次接觸」從一句話變成真正的 onboarding;隨後 Cmd+K + action registry(#16)。
3. **第三批(按價值排)**:建議下一步動作(#17)→ diff 升級(#18)→ shell 分頁(#19)→ 卡片預覽(#20)。
4. **大型功能各自立項**:checkpoints、parked 態、dev-server 預覽、可編輯 diff、cost 顯示、WebGL 規模化——每項先寫一頁決策文件再動工。

impeccable 後續可用的指令:`/impeccable onboard`(第一批完成後做首次體驗)、`/impeccable clarify`(coach marks 與空狀態文案)、`/impeccable polish`(視覺系統收尾)、`/impeccable critique`(改動後重測分數)。
