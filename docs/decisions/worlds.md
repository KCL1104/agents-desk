# 決策文件:世界選擇器(WSL/SSH 像 VS Code 一樣用選的,不用打的)

> 狀態:**提案,待決** · 2026-08 · 來源:使用者需求(「像 VS Code 左下角切換 WSL/SSH 那樣」)
> 參照:VS Code Remote 指示器(狀態列左下角、點開 quick pick、視窗綁定一個 remote)

## 問題

WSL 與 SSH 支援今天是隱形的:唯一的入口是在 repo 欄手打 `wsl://Ubuntu/home/...`——沒有任何 UI 宣告這能力存在,格式錯了才知道有格式,而且順序反直覺(人先想「我要在 Ubuntu 裡開」,才想路徑)。VS Code 的答案是把「世界」做成一等公民:左下角永遠顯示你在哪,點開就能選。

## 已經存在的東西(不要重做)

| 機制 | 涵蓋 | 缺口 |
|---|---|---|
| `host.rs` 的 `wsl://`/`ssh://` scheme + `locate`/`stored` | 世界作為路徑前綴,全 app 一條路 | 前綴要人手打 |
| `hosts: HashMap<Host, HostEnv>` + `host_env` | 每世界 login-shell 探測一次、快取(PATH、claude、worktree root) | 只在第一張卡開下去時才探,沒有「先看看這個世界通不通」 |
| 卡片 host 徽章 + Overview 世界分組 | 多世界**同桌**的呈現 | — |
| 側欄左下 `sidebar-foot`(環境) | 左下角這個位置已經是「桌子的設定」的家 | 只有環境面板,沒有世界 |
| NewTaskDialog 的 datalist branch picker | 「建議、不逼你打」的先例 | repo 欄沒有同等待遇 |
| SSH「不發明連線設定」哲學(`~/.ssh/config` 別名) | 帳號/port/金鑰全部沿用終端機的 | config 沒被枚舉成選單 |

## 設計空間與判定

### 核心判定:世界是「卡片的屬性」,不是「視窗的模式」

VS Code 的整窗綁定是它單 workspace 模型的產物。AgentDesk 的看板**本來就多世界同桌**——本機卡、WSL 卡、SSH 卡各戴徽章排在一起,這是比 VS Code 好的地方,不是要修的地方。所以選擇器的語義是:

- **左下角的世界鈕 = 「新東西預設開在哪」+ 世界健康總覽**,不是全域過濾器。
- 點開選單:本機 / WSL: 每個 distro / SSH: 每個別名,選了就記住(存 settings),鈕上顯示目前預設(如「⊕ WSL: Ubuntu」)。
- **開卡/開 session 對話框各自帶世界選擇**,預設值來自左下角,單次可改——世界屬於那張卡,不鎖整個 app。
- 選定世界後,路徑欄打**素路徑**(`/home/charlie/proj`),`wsl://` 前綴由 app 組——格式從使用者的鍵盤上消失。

### 發現(discovery):枚舉,不發明

- **WSL**:`wsl.exe -l -q` 枚舉 distro(僅 Windows;注意 **wsl.exe 輸出是 UTF-16LE**,要正確解碼,這是所有 wsl 包裝的經典地雷)。`wsl.exe -l -v` 可加標預設 distro。
- **SSH**:解析 `~/.ssh/config` 的 `Host` 別名——跳過萬用字元樣式(`*`/`?`)與 `Match` 區塊。與 M10b 同一條哲學:**只列使用者自己寫過的別名**,不發明任何連線設定。
- **探測是懶的**:選單打開時只列名字(讀 config/一次 `wsl -l` 都是毫秒級);點選某世界才探 login shell + claude(`host_env` 既有快取),結果顯示在選單裡(claude 版本或「找不到 claude」)。**啟動時絕不探 SSH**——一個掛掉的 host 不可以拖慢開 app。

### 路徑輸入的三個等級

1. **素路徑 + 世界選擇**(v1 主路):選了世界,路徑欄就是那個世界裡的絕對路徑。
2. **UNC 正規化**(v1 順手):任何路徑欄貼上 `\\wsl$\Ubuntu\home\...` 或 `\\wsl.localhost\Ubuntu\...` 自動翻成 `wsl://Ubuntu/home/...`——Windows 檔案總管複製出來的就是這個形狀。「瀏覽」按鈕因此對 WSL 也能用:挑 `\\wsl$` 下的目錄,app 翻譯。
3. **遠端目錄瀏覽器**(不做):SSH 世界做 `ls` 式挑目錄是一整個檔案瀏覽器的工程,v1 打字;datalist 記住「這個世界最近用過的 repo」可以買到八成體驗。

### 不做的

- **不做全域世界切換**(上詳,會倒退)。
- **不掃描 known_hosts 或發明 SSH 設定**。
- **不在啟動時探測任何遠端**。
- **不做 VS Code 式的「在遠端裝 server」**——AgentDesk 本來就不需要:一切經 `wsl.exe`/`ssh` 過境,遠端零安裝。

## 成本

Rust:`list_worlds`(枚舉)+ `probe_world`(懶探測,回 claude 版本/錯誤)兩個指令;wsl -l 的 UTF-16 解碼與 ssh config 解析都是可單元測試的純函式。UI:側欄腳的世界鈕 + 選單、兩個對話框的世界 select + 前綴組裝 + UNC 正規化。無 migration、無新依賴。

## 建議的 v1 範圍

1. Rust:`list_worlds`(wsl -l UTF-16 解碼、ssh config Host 解析,皆附純函式測試)+ `probe_world`(走既有 `host_env`,回版本或全因錯誤)(M)
2. UI:左下角世界鈕(顯示預設世界、點開選單、懶探測結果、記住選擇)+ 開卡/開 session 對話框的世界 select 與素路徑組裝 + UNC 貼上正規化 + i18n + mock(M)
3. Playwright:選世界開卡 → 存出 `wsl://` 路徑;UNC 貼上被正規化;預設世界跨重啟記住;探測失敗顯示全因(S)

**驗收**:不打任何 `wsl://` 字面,從左下角選「WSL: Ubuntu」→ 開卡 → 路徑欄打 `/home/me/proj` → 卡片存的是 `wsl://Ubuntu/home/me/proj` 且戴 Ubuntu 徽章;貼 `\\wsl$\Ubuntu\home\me\proj` 得到同樣結果;SSH 別名出現在選單且探測失敗時給完整理由;開 app 不因為任何遠端世界變慢。

## 未決(拍板後開工)

1. **左下角鈕的語義**:「新東西的預設世界 + 健康總覽」(建議)vs 全域過濾器(否決理由在上)。
2. **SSH 來源**:僅 `~/.ssh/config` 別名(建議)vs 加掃 known_hosts(否決:那是指紋快取,不是使用者的意圖)。
3. **WSL 瀏覽**:接受 UNC 並正規化、瀏覽按鈕可挑 `\\wsl$`(建議做)vs 純打字。
