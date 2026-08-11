# 決策文件:session 要不要活得比 app 久

> 狀態:**已定案,v1 已實作(local + tmux)** · 2026-08 · 來源:Xirp 研究(配對 #8)
> 參照:Xirp(閉源,macOS;依賴 `tmux`,FAQ 明說 session 存活過 app 關閉)、
> Claude Squad(Go TUI + tmux,同一招)

## 問題

AgentDesk 的 PTY 活在 app 的行程裡。關掉 app,agent 就死。

重開之後靠 `claude --continue` 由 cwd 找回**對話**,但那不是同一個 session:
scrollback 沒了(`pty.rs` 的 replay buffer 只活在行程存續期間,且刻意不落盤)、
執行中的那一輪被中斷、非 Claude 的 agent 連對話都接不回來。

代價落在三個真實情境:

1. **長跑任務綁住 app**。agent 跑三十分鐘的重構,這三十分鐘裡 app 不能關、不能升級。
2. **崩潰即損失**。app 崩了,所有 attempt 的當前回合一起沒了——worktree 與 checkpoint 還在,
   但正在進行的那一輪白跑。
3. **SSH 世界最脆弱**。網路斷一下,遠端的 agent 跟著死;而遠端正是「跑久一點」最合理的地方。

Xirp 的答案:PTY 活在 `tmux` server 裡,app 只是 attach 上去的前端。
三條互相佐證的證據——啟動依賴檢查列出 `tmux`、FAQ 2.3 明說「survive app close and reopen」、
設定頁 Advanced 提供「connection and **daemon** information」。
**未親手驗證**(macOS only),但足以當設計輸入。

## 已經存在的東西(不要重做)

| 機制 | 涵蓋 | 缺口 |
|---|---|---|
| `pty.rs`:`NativePtySystem` + `HashMap<String, PtySession>` | 真 PTY、login-shell 環境、bounded scrollback 帶單調 seq | 全部在 app 行程內;`kill_all()` 在收攤時清掉 |
| Scrollback 的 seq 續傳(`attach` 給歷史 + 只補比 seq 新的) | **晚接上來的 pane 不會漏也不會重**——這正是 re-attach 的協定 | 只服務同一行程內的 pane |
| `Status::Saved`(「存著,但現在沒有終端機」) | 狀態機**已經有**「session 存在但沒接上」這一格 | 目前只由關閉/重啟產生,不是由「還在跑但沒人看」產生 |
| `reopen_attempt` / `resume_attempt` + `--continue` | 對話層的接續,含權限模式帶回 | 重建的是新行程,不是原本那個 |
| `HostRef` / `host.rs`:local · `wsl://` · `ssh://` 三世界一條路 | 任意指令都能在三個世界執行 | — |
| Checkpoints(每輪快照)+ park(收地留分支) | 「回得去」的兩種既有答案 | 兩者都不保住**執行中的那一輪** |
| `parked.md` 的 shelf/attach 模型 | 「釋放資源、之後長回來」的完整先例 | 針對 worktree,不針對行程 |

**特別注意**:`Status::Saved` 與 scrollback 的 seq 續傳,是這個題目已經鋪好的兩塊地基。
真正缺的只有「PTY 的擁有者不是這個行程」。

## 設計空間與判定

### 選項 A:自己寫 daemon

AgentDesk 起一個常駐子行程持有所有 PTY,app 透過 socket attach。

- 好處:完全掌控協定;三個世界一致;Windows 原生也能做。
- 壞處:**要自己處理最難的那些事**——daemon 生命週期、孤兒回收、版本不合時的升級、
  多個 app 實例、socket 權限、崩潰後的重啟。這是一整個子系統,不是一片功能。

### 選項 B:tmux(Xirp 與 Claude Squad 的作法)

`spawn` 改成 `tmux new-session -d -s agentdesk-<id> <cmd>`,attach 用 `tmux attach`,
輸出照樣走 PTY 讀。

- 好處:**daemon 別人寫好了**,而且是三十年的成熟軟體;
  遠端 tmux 順帶解決 SSH 斷線;`tmux capture-pane` 甚至能把 scrollback 找回來。
- 壞處:**多一個硬依賴**。而且它跟 `worlds.md` 的核心承諾正面衝突——
  「零遠端安裝,everything transits wsl.exe / ssh」。SSH 世界要 tmux,
  就是要求使用者在遠端主機裝東西。**Windows 原生沒有 tmux**,而 PRODUCT.md
  已確認原生 Windows 要全支援。

### 核心判定(建議):持久化是「世界的能力」,不是 app 的前提

與 `worlds.md` 已經拍板的「**世界是卡片的屬性,不是視窗的模式**」同構。

- 每個世界在探測時順便回答一題:**這個世界有沒有 tmux**(`host_env` 已經在探 PATH 與 claude,加一項)。
- 有 → 該世界的 session 走 tmux,關掉 app 不死。
- 沒有 → 該世界照現行行為,**而且卡片要說出來**,不是靜靜降級。
  這正是既有的「無狀態訊號 chip」同一套誠實:能力的缺席要看得見。
- **絕不自動安裝、絕不建議安裝到遠端主機**。枚舉,不發明——與 SSH 只認 `~/.ssh/config` 同一條線。

這樣三個矛盾同時解掉:不背全域依賴、不毀零遠端安裝的承諾、Windows 原生誠實地沒有這個能力
(直到有人找到它的等價物)。

### 次判定:先做本機,SSH 押後

報酬排序是 SSH > 本機 > WSL,但**風險排序剛好相反**。
本機的 tmux 是使用者自己機器上的一個 brew/apt 套件,他自己決定;
遠端的 tmux 是別人的機器。v1 只做 local(+ WSL,同樣是本機),SSH 留給第二片單獨決策。

### 要避開的一個坑:別讓 tmux 進到位元組路徑上

AgentDesk 的第一承諾是「app 只搬運位元組,TUI 自己畫自己」。
tmux **會**重繪——它有自己的 status line、自己的複製模式、自己的鍵繫結。

所以:**`tmux -f /dev/null`(不讀使用者的 `.tmux.conf`)、`status off`、
`escape-time 0`、`prefix` 設成幾乎不可能撞到的鍵**,而且視窗尺寸由 app 驅動。
tmux 在這裡的角色只有一個:**持有行程**。它多畫一個畫素都是 bug。
這條要進驗收:同一個 TUI 在 tmux 內外的位元組流必須一致。

## 成本

- **實作**:`pty.rs` 的 `spawn`/`attach`/`kill` 三個入口各多一條 tmux 路徑;
  `host_env` 多探一項;`Status::Saved` 多一個來源(還活著但沒接上);
  重啟時要枚舉 `tmux ls` 認回自己的 session。粗估中等,不是一片。
- **測試**:mock 層要能假裝一個有 tmux 的世界與一個沒有的;
  「位元組流一致」需要一條真的整合測試。
- **風險**:tmux 版本差異(`-f /dev/null` 的行為、`capture-pane` 的旗標在舊版不同)。
  要訂最低版本並照實檢查,不猜。
- **不做的話的成本**:上面三個情境照舊;而遠端 companion(`UiSink` seam)幾乎必然
  需要「session 不綁在某個 UI 上」這件事先成立——**這題其實是那題的前置**。

## 建議的 v1 範圍

1. `host_env` 加一項 tmux 探測(版本一起記),結果進世界選擇器的健康顯示。
2. `pty.rs` 在 local/WSL 且該世界有 tmux 時走 tmux,參數如上(不讀使用者設定、關 status line)。
3. app 啟動時 `tmux ls` 認回自己命名空間下的 session,狀態接回既有的 `Status::Saved` 語義。
4. 沒有 tmux 的世界:行為不變,卡片戴一個「關掉 app 會結束」的淡色 chip——**降級要看得見**。
5. **不做**:SSH 世界、scrollback 落盤(`capture-pane` 誘人但先不碰)、自己寫 daemon。

## 第二次實作(2026-08-11):**已落地**,`-L` 每 session 一個 socket

第一次撤回後,先做的不是寫程式,是**量測前提**:

| 作法 | 內層 agent 讀到的 `AGENTDESK_SESSION_ID` |
|---|---|
| `-L` 每 session 一個 socket | `s42` ✓ |
| 共用 server 的第二個 session | **`first`** ——第一個 session 的 id |

第二列比原本的診斷更嚴重:不是「變數不見」,是**變數是錯的**。
共用 server 時第二個 session 會用第一個的 id 回報狀態,卡片會為錯的 agent 亮燈。
`-L` 讓環境正確變成結構保證,代價是每個 session 一個閒置 server。

### v1 的形狀

- `Hold { socket, conf, socket_file }`;socket = `agentdesk-<desk tag>-<session id>`。
  **desk tag 是 data_dir 的 FNV-1a**——沒有它,一個 install 的孤兒清掃會殺掉另一個的活 agent,
  而且測試之間會互殺。
- spawn:`tmux -L <socket> -f <conf> new-session -A -D -s agent -c <cwd> -- <exe> <args>`。
  **`-A` 是 create-or-attach**,所以「第一次開」和「重開時接回」是同一條程式碼路徑,
  兩者不可能對不上。
- **退出 app = `kill`(只斷 client)**;**刻意關閉 = `destroy`(`kill-server` + 刪 socket 檔)**。
  這個區別就是整個功能:退出不等於做完了。
- 只有 **agent 的 session** 被 hold。run script 與 worktree shell 是「你開來看的」,
  跟著桌子收掉;agent 是「你開來讓它跑的」。
- 啟動時掃孤兒:讀 socket 目錄(那是被遺忘的 id 唯一還存在的地方),
  只碰自己 desk tag 的,`kill-server` 之後**把 socket 檔也刪掉**。

### 實測驗證(真 tmux 3.4)

1. 環境送達內層 agent ✓
2. **完全沒有 client 時 session 仍在、agent 程序仍在跑** ✓ ← 這就是整個功能
3. `kill-server` 之後 agent 程序一起收掉 ✓
4. cargo **406 passed**,而且是在 tmux 真的接管每個 agent session 的情況下跑出來的
5. 全套跑完:活著的 tmux 程序 **0**、殘留 socket 檔 51 → **1**

### 過程中修掉的兩件事

- **bracketed paste 的行為變了,而且變得更對。** tmux 只在內層程式宣告了 DECSET 2004 時
  才轉發 `\x1b[200~` 標記。測試的 stub 是純 `cat`,從不宣告,所以被正確濾掉——
  而 `bracketed_followup` 的註解本來就寫著「只送給量測過會開它的 CLI」。
  把 stub 改成宣告它所替身的那個 CLI 真的會宣告的模式,測試就過了。
  **淨效果:tmux 讓這條路比原本無條件送更安全。**
- **tmux server 結束後會留下 socket inode。** 死檔看起來跟活的一樣,
  會讓清掃永遠愈掃愈慢。關閉與清掃兩條路現在都負責 unlink。

### 仍然沒做

- **SSH 與 WSL**:見上面的核心判定,各自要單獨決策。
- **狀態誠實度**:一個 detached 但還在跑的 session,重開 app 後仍顯示「已關閉」,
  直到被打開才接回。接回本身是對的(`-A` 會 attach 到還活著的 agent),
  但那個標籤在接回之前是錯的。**這是 v1 唯一已知的不誠實,列為下一項。**

## 第一次實作嘗試(2026-08-11):撤掉,以及為什麼

拍板後實作到「spawn 走 tmux + 關閉時 kill-session + 退出時只 detach + 啟動時掃孤兒」,
編譯通過,而且**機制確實生效**——測試跑完後 `tmux ls` 裡留著活的 `agentdesk-<id>` session,
client 已死而 agent 還在。然後 `cargo test` 掛了四個,查下去是一個真的問題:

### 致命發現:tmux 不會把環境變數帶進新 session

**新 session 繼承的是 tmux *server* 的環境,不是啟動它的 client 的。**
於是 `AGENTDESK_SESSION_ID` 與 `AGENTDESK_HOOK_URL` 到不了 agent。

這兩個變數正是狀態 hooks 的全部依據。照那個實作出貨,結果會是:
**session 活過 app 了,但每一張卡都不再回報狀態,而且是靜默的。**
那是這個產品明確拒絕的失敗模式——「量不到就要說出來」的反面。

更糟的是它只在第二個 session 之後才錯:第一個 session 順手啟動了 tmux server,
server 繼承了當下的環境;之後的 session 全部拿到那份**凍結的舊環境**。
所以連 bug 都是間歇性的。

### 這改變了 v1 的範圍

修法是 `tmux new-session -e KEY=VAL`(tmux **3.2+**,不是文件原本寫的 3.0)。
但這件事沒有看起來簡單:

- agent 拿到的是**登入 shell 的完整環境**(這是 `shell_env` 存在的理由),
  幾十個變數全部要走 `-e`,命令列會很長。
- 或者只傳「這張桌子自己加的那幾個」,但那等於默認 agent 從 tmux server 拿到的
  基礎環境是對的——而它正是那份可能已經凍結好幾天的舊環境。
- 換句話說,**tmux 的環境模型跟「agent 拿到的環境必須和你的終端機一模一樣」
  這條核心承諾是有摩擦的**,不是加個旗標就結束。

### 結論

**已撤回全部實作**(`git checkout -- src-tauri/`),Rust 391 測試回到全綠。
不留半套的理由就是上面那條:少了環境傳遞,這個功能會用「狀態靜默消失」來換「session 存活」,
那是一筆賠本的交易。

**下一輪要先解決的,是環境傳遞,不是 attach。** 建議的下一步:
1. 量測 `-e` 的實際上限(幾十個變數的命令列在 macOS/Linux 上會不會爆)。
2. 決定基準環境從哪來:每次 `kill-server` 後重起以確保新鮮?還是每個 session 一個
   獨立的 socket(`-L agentdesk-<id>`)——那樣每個 session 有自己的 server,
   環境天生新鮮,代價是行程數。**第二條看起來比較對。**
3. 重新量測最低版本(`-e` 需要 3.2)。

## 未決(待拍板)

1. **v1 要不要包含 WSL?** WSL 是本機,但 tmux 要裝在 distro 裡,語義上更接近「別人的機器」。
2. **沒有 tmux 的世界,那個 chip 要說什麼、戴在哪?** 卡片上會不會太吵——
   一個永遠都在的 chip 正是「靜態彩色邊」被否決過的那種噪音。
3. **既有 session 的遷移**:升級後舊 session 還在舊模式裡,要不要處理,還是等它們自然終局。
4. **最低 tmux 版本**訂在哪,以及探到過舊的版本時是拒絕還是降級。
   (實作後修正:`-e` 需要 **3.2**,不是本文原先寫的 3.0。)
5. **每個 session 一個 tmux socket(`-L`)還是共用一個 server?**
   實作嘗試撞到的環境問題讓這題從「效能取捨」升級成「正確性取捨」——
   共用 server 意味著共用一份可能已經凍結的環境。
