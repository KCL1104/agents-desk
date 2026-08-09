# 決策文件:Cost/context 顯示(token 帳,不開終端機就看得到)

> 狀態:**已定案,v1 已實作** · 2026-08 · 來源:前端研究報告 Tier 3
> 查證基準:本容器一場真實 Claude Code session 的 transcript(22MB、4469 列)實測

## 問題

agent 花 token 的速度和語境的水位,今天只活在每個終端機自己的 TUI 裡。看板的本業是「不開終端機就知道每張卡的狀況」——哪張卡在燒、哪場對話快撐不下——這兩個數字缺席,審計就少了一半。

## 已經存在的東西(不要重做)

| 機制 | 涵蓋 | 缺口 |
|---|---|---|
| hooks 管線(狀態、activity) | 回合的節奏 | **payload 沒有 token 資料**(已驗證)——但共同欄位帶 `transcript_path` |
| `~/.claude/projects/**.jsonl` transcript | **唯一誠實的 token 來源**:assistant 列的 `message.usage` 有 in/out/cache_read/cache_creation 四欄(對真檔實測確認) | 沒人在讀 |
| Router `turn_done` 縫(checkpoints 在用) | 「回合剛結束」的準確時刻 | — |
| `sessions:changed` 廣播 + `preview_port` 先例 | in-memory、隨 session 生滅的欄位怎麼活 | — |
| HostRef 檔案 IO | Local/WSL/SSH 一條路 | 沒有「從第 N byte 讀到尾」 |

## 設計空間與判定

### 資料來源:transcript,路徑由 hook 遞來,不用猜

`transcript_path` 是 Claude Code hook payload 的共同欄位,`http` hook 的 body 原樣帶著。收到就記在 session 上(記憶體,不落盤)。**不做** cwd-slug 重建路徑——跳脫規則是 claude 的私事,猜錯一次就讀錯一場對話。

### 時機:只在回合結束讀(與 checkpoint 同一條縫)

不做即時 ticker——回合中輪詢一個 agent 正在寫的檔案,讀到的是半行,花的是整趟 IO。Stop 落地時 worktree 安靜、transcript 也安靜,讀這一刻的帳最誠實。讀在 worker 執行緒,hook 路徑零成本。

### 讀法:記住 byte offset,每輪只讀新尾巴

transcript 只增不改。每 session 記一個 offset,回合結束 `read_from(path, offset)` 只拿新 bytes(本地 seek;遠端 `tail -c +N`,SSH 也便宜)。只消化到最後一個換行——半行是下一輪的事。app 重啟或 `--continue` 重開,offset 歸零重算一次全檔,結果一樣,因為帳本身就在 transcript 裡:**不設 DB 欄位**,存一份會在重啟後說謊的快取沒有意義。

### 計什麼:兩個數字,四欄明細

- **累計花費**:所有 assistant 列的四欄各自加總。**sidechain(sub-agent)列計入**——那是真花掉的錢。
- **語境水位**:最後一個**非 sidechain** assistant 列的 `input + cache_read + cache_creation`≈下一輪起跑的 prompt 大小。sidechain 的 prompt 是別場對話的語境,不能拿來蓋掉主線的。

### 不做的(每一條都有屍體)

- **不換算金額**:價目表會過期,快取階梯(5m/1h)讓單價本身就是條件式——顯示一個會錯的錢數比不顯示更糟。token 數是不會過期的真話。
- **不算語境百分比**:分母(context window)transcript 沒記,hardcode 會錯——實測本 session 語境 278k,任何「200k 上限」的假設當場破產。沒有誠實分母就不給百分比。
- **不做即時 ticker**(上面說過)。
- **卡片不戴徽章**:沒有分母就沒有「快滿了」的誠實門檻;卡片保持安靜,數字住在檢視器。
- **非 claude agent 誠實缺席**:沒有 hooks 就沒有 transcript_path,什麼都不顯示——「無狀態訊號」chip 已經把這件事說過了。

### 顯示:檢視器 meta 列,兩個 mono chip

分支、base、↑↓ 的同一列加上 `語境 279k · ↑2.6M`(k/M 壓縮),tooltip 給四欄精確值與說明。只在有 live session 且已有讀數時出現——凍結與 parked 的 attempt 沒有對話在燒,缺席即事實。

## 成本

每回合一次 tail 讀(bytes 與該輪產出成正比)+ 一次 JSONL 掃描,worker 執行緒上;記憶體每 session 一個 offset + 五個 u64。無新依賴、無 migration。

## v1 範圍(單片)

1. hooks.rs:`HookReport.transcript_path`(body 共同欄位)+ 測試
2. core.rs:`SessionMeta.usage`(in-memory,Serialize)+ `HostRef::read_from` + `parse_usage`(sidechain 規則)+ `usage_after_turn` 掛 turn_done 縫 + 整合測試(假 transcript 餵 hook,end-to-end 到 sessions() 讀數)
3. UI:檢視器 meta chip + tooltip、i18n、mock(sessions 直接帶 usage)、Playwright(有讀數顯示、無讀數缺席)

**驗收**:對一個 attempt 餵 Stop hook(body 帶 transcript_path 指向固定內容的假 transcript),sessions 廣播裡出現正確的累計與語境;sidechain 列計入累計、不動語境;檢視器顯示壓縮後數字、tooltip 有精確值;codex attempt 什麼都不顯示。

## 未決 → 已拍板(v1 實作採用)

1. **顯示位置**:檢視器 only。卡片徽章因「沒有誠實分母」否決(上詳)。
2. **數字格式**:k/M 壓縮,精確值住 tooltip。
3. **遠端(WSL/SSH)**:照做,`tail -c` 讓每輪讀量與該輪成正比——不因為遠端就退成 local-only。
