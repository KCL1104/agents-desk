/**
 * 終端機的螢幕閱讀器模式。
 *
 * xterm 的 `screenReaderMode` 會在 DOM 裡維護一層可朗讀的文字 —— 包含
 * 每一則授權提示 —— 但 WebGL 繪製是純 canvas，對螢幕閱讀器完全沉默。
 * 所以這個開關同時管兩件事：終端機的 screenReaderMode，以及要不要載
 * WebGL addon（開啟時一律走 DOM 繪製器，那才是可及性的那條路）。
 *
 * 預設關閉：這是拿 GPU 效能換可及性的誠實交換，由使用者自己決定，
 * 而且設定的提示文字直說代價。
 */
const KEY = 'marol.termSr';

/** 事件名沿用主題切換的先例：已掛載的終端機不在 prop 鏈上，靠廣播到達。 */
export const TERM_SR_EVENT = 'marol:termsr';

export function termSrEnabled(): boolean {
  return localStorage.getItem(KEY) === '1';
}

/** 寫入並廣播 —— 每個活著的終端機即時切換，不必重開 session。 */
export function setTermSr(on: boolean): void {
  localStorage.setItem(KEY, on ? '1' : '0');
  window.dispatchEvent(new Event(TERM_SR_EVENT));
}
