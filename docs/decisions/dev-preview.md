# 決策文件:內嵌 dev-server 預覽 + inspect mode

> 狀態:**已定案,v1 已實作**(三片全落地;未決三項依建議拍板)· 2026-08 · 來源:前端研究報告 Tier 3(Vibe Kanban preview / click-to-component)
> 參照:Vibe Kanban 的 preview 面板與 inspect(機制為研究報告轉述,injection 細節未驗證)

## 問題

改前端的 attempt,驗收的最後一步永遠是「打開看」。今天這一步要離開桌子:▶ dev 起了 server、`$MAROL_PORT` 給了埠,然後你得自己開瀏覽器、自己記埠號、自己在兩個視窗之間對照 diff 和畫面。回饋迴圈的最後一哩是斷的——而 inspect(點畫面上的元件、直接變成給 agent 的話)是那一哩上最值錢的一段。

## 已經存在的東西(不要重做)

| 機制 | 涵蓋 | 缺口 |
|---|---|---|
| M6 run scripts | ▶ 起 dev server、輸出進自己的終端機、`$MAROL_PORT` 帶一個 kernel 配發的空埠 | **埠沒有記錄在任何地方**——env 注入後就丟了,面板無從知道該開哪個 URL |
| Tauri webview,`csp: null`(已查證 tauri.conf.json) | app 內 `<iframe src="http://localhost:PORT">` 不被 CSP 擋 | dev server 自己送 `X-Frame-Options` 的少數例外要誠實報錯 |
| 看板 peek(`term-area.as-preview`) | 「主畫面旁邊掛一塊即時面板」的版面先例 | — |
| 佇列 follow-up / bracketed paste | 把一段話送進 claude 終端機的既有路 | 只對 claude 量測過(維持既有誠實) |
| WSL mirrored networking(M10a 已記錄) | distro 內的埠在 localhost 打得到 | NAT 模式打不到;**SSH 的埠活在遠端,一定打不到** |

## 設計空間與判定

### 埠的記錄:session 的 in-memory 欄位,不進 SQLite

run_script 當下把埠寫進該 ad-hoc session 的 meta(`preview_port: Option<u16>`),跟著 broadcast 走。不落盤——server 隨 PTY 死,重啟後埠早就無效,存起來只會變成一個會說謊的欄位。這與 shells 快取同一條「transient 不落盤」的既有規則。

### 面板:iframe 掛在 content row,跟 peek 同一塊地

- 有 `preview_port` 的 session 活著時,它的 run-chip 旁多一顆「預覽」;開啟後在 content row 右側掛面板(與看板 peek 同一個版面位置與寬度規則),iframe 指 `http://localhost:{port}`。
- 面板頭:URL(可複製)、重新整理、在外部瀏覽器開啟(`tauri-plugin-opener`,既有)、關閉。
- **server 死了要說**:PTY 退出時面板蓋上「server 已結束」而不是留一張白 iframe——空白與壞掉從外面看分不出來,這是 M6 對 config 靜默失效的同一條誠實。
- webview 與 iframe 是跨源:app 讀不到 iframe 內容,iframe 也讀不到 app。預覽是「看」,不是「碰」。

### 世界:v1 = 本機 + WSL(mirrored);SSH 明確拒絕

- 本機埠直接可達;WSL mirrored networking 下 localhost 可達(NAT 下面板開了也連不上——沿用 M10a 的既有註記,面板顯示連線失敗而不是假裝)。
- SSH 的埠在遠端。要通就要多開一條 local forward(`-L`)掛在既有 ControlMaster 上——可做,但屬於第二片,不擋 v1。v1 對 SSH attempt 不出「預覽」按鈕,理由在 tooltip 說完整。

### Inspect mode:opt-in 的 postMessage 契約,永不注入

拆成兩半看:

- **VK 式做法**(轉述):代理 dev server、在回應裡注入 inspect script。**否決注入**——修改受測頁面的 bytes,等於讓「你在看的東西」不再是「server 送出的東西」;這對一個以「不重繪、不重新詮釋」立身的 app 是根本性的矛盾,而且 proxy 引入的差異(header、websocket、HMR)每一項都是新的謊言來源。
- **採用:repo 自己掛一小段 dev-only script**(`.marol/config.json` 的世界觀:workspace 的事 repo 自己說)。script 在頁面裡監聽 Alt+click,把 `{file, line, component}`(React dev mode 的 `_debugSource`,或 Vue 的 `__file`)用 `postMessage` 丟出來;app 這側 `window.addEventListener('message')` 收,驗 origin 是預覽的 origin,組成一句「使用者指著 {file}:{line} 的 {component}」走既有 bracketed-paste 進 claude。送不送由人——與 restore 的預組訊息同一條規則。
- Opt-in 的代價是「不裝就沒有 inspect」;換來的是零注入、零代理、頁面行為與真實瀏覽器完全一致。這個取捨值得。

### 不做的

- 不做內建瀏覽器(網址列、上一頁)——外部瀏覽器一鍵可達,桌子不需要第二個 Chrome。
- 不做截圖比對、不做 responsive 模擬器——v1 是「看得到」,不是 DevTools。

## 成本

面板本體是一個 iframe——記憶體成本 ≈ 一個分頁,只在開啟時存在。埠記錄是一個 in-memory 欄位。Inspect 的 app 側是一個 message listener + 既有 paste 路;repo 側一段 ~30 行的 dev-only script(可以先放 docs 範例,之後再考慮發套件)。

## 建議的 v1 範圍

1. `preview_port` 進 session meta(run_script 記錄、broadcast 帶出、UI 型別)(S)
2. 預覽面板:預覽按鈕、iframe + 面板頭四鍵、server 死亡蓋版、SSH 拒絕與 WSL-NAT 誠實報錯(M)
3. Inspect:postMessage 契約 + origin 驗證 + 組句進 bracketed paste(僅 claude,沿用 followupSendable)+ docs 範例 script(M)

**驗收**:▶ dev 起來後一鍵看到頁面;server 結束後面板說「已結束」而非空白;SSH attempt 沒有預覽按鈕且理由可讀;掛了範例 script 的 repo 裡 Alt+click 元件,claude 終端機收到一句可讀的指位訊息,沒掛的 repo 預覽照常、只是沒有 inspect;Playwright 蓋面板開關與 message → paste 的線路。

## 未決 → 已拍板(v1 依建議採納)

1. **槽位**:同一塊地,明確的開啟壓過 hover 驅動的 peek——預覽開著時 peek 讓位,關掉就還回去(hover 不構成「後開」;兩個都要就進外部瀏覽器)。
2. **inspect script**:docs 範例(`docs/examples/marol-inspect.js`,React `_debugSource` + Vue `__file`),等第三個人要再發套件。
3. **VK 機制標註**:維持轉述標註。
