import { resolve } from "./resolver.js";
chrome.runtime.onInstalled.addListener(() => chrome.contextMenus.create({ id: "resolve", title: "Box共有リンクを解決して開く", contexts: ["link", "selection"] }));
chrome.contextMenus.onClicked.addListener(async i => {
  const r = await resolve(i.linkUrl || i.selectionText || "");
  await chrome.storage.local.set({ lastLog: r.log.join("\n") });
});
chrome.runtime.onMessage.addListener((m, _s, send) => { if (m.type === "resolve") { resolve(m.link).then(send, e => send({ ok: false, log: [String(e)] })); return true; } });
