// 拡張の常駐処理。ポップアップ・右クリックから resolve。設定からキャッシュ再作成。
import { resolve, warmCache, hasTodayCache, isResolving } from "./resolver.js";
import { getConfig, isOwnBoxApp, isBoxSearchTab, hostOf } from "./config.js";
let warming = false;
chrome.runtime.onInstalled.addListener(() => chrome.contextMenus.create({ id: "resolve", title: "Box共有リンクを解決して開く", contexts: ["link", "selection"] }));
chrome.contextMenus.onClicked.addListener(async i => {
  await resolve(i.linkUrl || i.selectionText || "");
});
function reportProgress(pct) {
  chrome.runtime.sendMessage({ type: "progress", pct }).catch(() => {});
}
async function listBoxTabs() {
  let tabs = await chrome.tabs.query({ url: ["https://*.box.com/*", "https://box.com/*"] });
  if (!tabs.length) tabs = (await chrome.tabs.query({})).filter(t => /box\.com/i.test(t.url || ""));
  return tabs;
}
async function findOwnBoxTab(cfg) {
  const tabs = await listBoxTabs();
  const usable = tabs.filter(t => isBoxSearchTab(t.url, cfg.ownDomain));
  const exact = cfg.ownDomain ? usable.filter(t => isOwnBoxApp(t.url, cfg.ownDomain)) : [];
  return exact[0] || usable[0] || null;
}
async function runWarm() {
  if (warming) return { ok: false, error: "作成中です" };
  warming = true;
  const cfg = await getConfig();
  try {
    const tab = await findOwnBoxTab(cfg);
    if (!tab) {
      const boxTabs = await listBoxTabs();
      const hosts = [...new Set(boxTabs.map(t => hostOf(t.url)).filter(Boolean))];
      const error = !cfg.ownDomain
        ? "自社ドメインが未設定です"
        : hosts.length
          ? "自社Boxタブが見つかりません。設定: " + cfg.ownDomain + " / 開いているBox: " + hosts.join(", ")
          : "Boxのタブが開いていません。設定: " + cfg.ownDomain;
      return { ok: false, error };
    }
    return await warmCache(tab.id) || { ok: true, count: 0 };
  } catch (e) {
    console.warn("warmCache failed", e);
    return { ok: false, error: String(e) };
  } finally {
    warming = false;
  }
}
chrome.runtime.onMessage.addListener((m, _s, send) => {
  if (m.type === "warmCache") {
    runWarm().then(send, e => send({ ok: false, error: String(e) }));
    return true;
  }
  if (m.type !== "resolve") return;
  resolve(m.link, reportProgress).then(send, e => send({ ok: false, log: [String(e)] }));
  return true;
});
// 開いているBoxタブで、その日まだなら15秒後に当日分だけ裏更新。画面遷移では待ちをやり直さない。
const WARM_TODAY = "warmToday";
const WARM_PENDING = "warmTodayPending";
async function scheduleTodayWarm(tabId) {
  const cfg = await getConfig();
  if (!cfg.ownDomain || await hasTodayCache(cfg.ownDomain)) return;
  const pending = await chrome.storage.session.get(WARM_PENDING).catch(() => chrome.storage.local.get(WARM_PENDING));
  if (pending[WARM_PENDING]) return;
  await chrome.storage.session.set({ [WARM_PENDING]: true, warmTabId: tabId }).catch(() => chrome.storage.local.set({ [WARM_PENDING]: true, warmTabId: tabId }));
  chrome.alarms.create(WARM_TODAY, { when: Date.now() + 15000 });
}
async function runTodayWarm() {
  const cfg = await getConfig();
  if (!cfg.ownDomain || await hasTodayCache(cfg.ownDomain)) {
    await chrome.storage.session.set({ [WARM_PENDING]: false }).catch(() => chrome.storage.local.set({ [WARM_PENDING]: false }));
    return;
  }
  if (warming || isResolving()) {
    chrome.alarms.create(WARM_TODAY, { when: Date.now() + 15000 });
    return;
  }
  await chrome.storage.session.set({ [WARM_PENDING]: false }).catch(() => chrome.storage.local.set({ [WARM_PENDING]: false }));
  const tab = await findOwnBoxTab(cfg);
  if (!tab) return;
  warming = true;
  try {
    await warmCache(tab.id, 1);
  } catch (e) {
    console.warn("today warm failed", e);
  } finally {
    warming = false;
  }
}
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete" || !tab.url) return;
  getConfig().then(cfg => {
    if (isBoxSearchTab(tab.url, cfg.ownDomain)) scheduleTodayWarm(tabId);
  });
});
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === WARM_TODAY) runTodayWarm();
});
