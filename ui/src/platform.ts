/**
 * 平台正確的修飾鍵。
 *
 * 快捷鍵總表寫「⌘/Ctrl」是在教規則 —— 兩個平台的人都讀同一張表;
 * 但認鍵卡與 coach 教的是「現在就按這顆」,說一顆使用者鍵盤上
 * 不存在的鍵,教的就是錯的。這裡只判斷一次:mac 家族用 ⌘,
 * 其他平台用 Ctrl+ —— 與 App 鍵盤表監聽的 metaKey/ctrlKey 同一份事實。
 */
const isMac =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');

/** 把一個鍵名組成本平台的和弦:chord('E') → '⌘E' 或 'Ctrl+E'。 */
export function chord(keys: string): string {
  return isMac ? `⌘${keys}` : `Ctrl+${keys}`;
}
