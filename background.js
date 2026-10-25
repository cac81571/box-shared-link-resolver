// 拡張の常駐処理。ポップアップと右クリックメニューから resolve を呼ぶ。
import { resolve } from "./resolver.js";
chrome.runtime.onInstalled.addListener(() => chrome.contextMenus.create({ id: "resolve", title: "Box共有リンクを解決して開く", contexts: ["link", "selection"] }));
chrome.contextMenus.onClicked.addListener(async i => {
  await resolve(i.linkUrl || i.selectionText || "");
});
// ポップアップが閉じていても進捗通知が失敗しないようにする
function reportProgress(pct) {
  chrome.runtime.sendMessage({ type: "progress", pct }).catch(() => {});
}
chrome.runtime.onMessage.addListener((m, _s, send) => {
  if (m.type !== "resolve") return;
  resolve(m.link, reportProgress).then(send, e => send({ ok: false, log: [String(e)] }));
  return true; // 非同期で send するため true
});
