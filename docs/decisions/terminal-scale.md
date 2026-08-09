# 決策文件:終端規模化(先量測,再決策)

> 狀態:**已定案,v1 已實作** · 2026-08 · 來源:roadmap「終端規模化」
> 量測環境:容器內 Chromium(Playwright 預裝版)。WKWebView 的絕對數字待真機驗;結構性結論(誰持有 context、誰被踢)與平台無關。

## 量測

**WebGL context 上限**(40 個 canvas 逐一建 context、各畫一次、聽 `webglcontextlost`):

- 40 個 context **全部建立成功**——建立永遠不會失敗,沒有錯誤可以接。
- 500ms 後只有 **16 個活著**;第 0–23 個(**最舊的**)收到 `webglcontextlost`。
- 結論:超額時瀏覽器**無聲地踢掉最舊的** context。錯誤處理接不到「第 17 個開不了」,只接得到「第 1 個死了」。

**對 AgentDesk 的意義**:每個 live session 的終端機都常駐(藏起來保 scrollback)——藏著的 pane 也持有 WebGL context。第 17 個 session 一掛載,被踢的是最舊的 context,**很可能正是螢幕上看著的那個 pane**;而現行程式在 context 丟失時 dispose addon,一路 DOM renderer 到底,不會復原。

**scrollback 記憶體**:容器 headless Chromium 的 `performance.memory` 不可用,精確數字沒測到。已知結構成本(xterm 每 cell 以 typed array 存,估算非量測):10k 行 × 200 欄約在每終端機十幾 MB 的量級。現行 `scrollback: 10_000` 的上限維持——這是「有界」與「無界」的差別,不是要調的數字。

## 判定

1. **WebGL 跟著可見性走**(核心修正):`WebglAddon` 只在 pane 可見時掛載、隱藏即 dispose。可見 pane 數受版面自然限制(遠小於 16),踢舊 context 的情境**結構性消失**;隱藏的 pane 本來就不畫任何東西,占著 GPU context 是純浪費。context 意外丟失(WKWebView 記憶體壓力會踢)仍走 DOM 後備——而且下次隱藏/顯示循環會**自然痊癒**,取代原本的「一次丟失、永遠 DOM」。
2. **SearchAddon + ⌘F 搜尋列**:10k 行 scrollback 不可搜就是一面牆。搜尋列是浮層不是 header 列(終端機尺寸不能因它增減——TUI 會整個重排);Enter/Shift+Enter 走下一個/上一個,Esc 關閉還游標;找不到時輸入框穿上 no-match 狀態,不聳肩。鍵位入 App 的唯一鍵盤表:⌘/Ctrl+F,終端機內依既有 shell 規則加 Shift(Ctrl+F 是 readline 的 cursor-forward)。
3. **WebLinksAddon**:⌘/Ctrl+click 開連結(走既有 `openExternal`);**素點不開**——終端機裡的 click 屬於 TUI 的滑鼠協議與文字選取。
4. **scrollback 落盤:緩辦**。有界的 in-memory scrollback + Rust 側既有 replay buffer 已涵蓋重掛載;落盤買的是「無限歷史」,代價是序列化格式、失效策略、磁碟生命週期三件真工程。等真的有人撞到 10k 上限再談。

## 成本

依賴 +2(`@xterm/addon-search`、`@xterm/addon-web-links`,皆官方零傳依賴);WebGL 掛卸每次 tab 切換一回,一次性 repaint,量級可忽略。

## 驗收(已由測試釘住)

- 餵進 scrollback 的字串,⌘F(終端機內 Ctrl+Shift+F)→ 輸入 → Enter 後成為 xterm selection。
- 無符合時輸入框戴 no-match;再打字即清除。
- Esc 關閉搜尋列,焦點回到終端機。
- WebGL 可見性掛卸為結構性修正,由量測記錄背書(可見 pane 數 < 16 恆成立)。
