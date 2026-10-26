// 拡張の常駐処理。ポップアップ・右クリックから resolve。設定からカタログ収集／登録。
import { resolve, isResolving, findSearchTab, collectCatalog, uploadCatalog, importCatalog, hasTodayCatalog } from "./resolver.js";
import { getConfig, isBoxSearchTab } from "./config.js";
chrome.storage.local.remove(["sharedIdHits", "searchCache", "lastWarm", "todayCacheOn"]);
let warming = false;
chrome.runtime.onInstalled.addListener(() => chrome.contextMenus.create({ id: "resolve", title: "Box共有リンクを解決して開く", contexts: ["link", "selection"] }));
chrome.contextMenus.onClicked.addListener(async i => {
  await resolve(i.linkUrl || i.selectionText || "");
});
function reportProgress(info) {
  if (!info || typeof info !== "object") return;
  const v = {
    progress: {
      phase: info.phase || "",
      days: info.days || 0,
      page: info.page || 0,
      pageCount: info.pageCount || 0,
      remainMs: info.remainMs || 0,
      at: Date.now()
    }
  };
  chrome.storage.session.set(v).catch(() => chrome.storage.local.set(v).catch(() => {}));
}
async function needSearchTab() {
  const cfg = await getConfig();
  const tab = await findSearchTab(cfg);
  if (!tab) {
    const error = !cfg.ownDomain ? "自社ドメインが未設定です" : "Box にログインしてください";
    return { tab: null, error };
  }
  return { tab, error: "" };
}
async function runCatalog(kind) {
  if (warming) return { ok: false, error: "作成中です" };
  warming = true;
  try {
    const { tab, error } = await needSearchTab();
    if (!tab) return { ok: false, error };
    if (kind === "import") return await importCatalog(tab.id);
    if (kind === "collect") return await collectCatalog(tab.id, reportProgress);
    return await uploadCatalog(tab.id);
  } catch (e) {
    console.warn("catalog failed", e);
    return { ok: false, error: String(e) };
  } finally {
    warming = false;
  }
}
chrome.runtime.onMessage.addListener((m, _s, send) => {
  if (m.type === "ping") {
    send({ ok: true });
    return;
  }
  if (m.type === "collectCatalog") {
    runCatalog("collect").then(send, e => send({ ok: false, error: String(e) }));
    return true;
  }
  if (m.type === "uploadCatalog") {
    runCatalog("upload").then(send, e => send({ ok: false, error: String(e) }));
    return true;
  }
  if (m.type === "importCatalog") {
    runCatalog("import").then(send, e => send({ ok: false, error: String(e) }));
    return true;
  }
  if (m.type !== "resolve") return;
  resolve(m.link, reportProgress).then(send, e => send({ ok: false, log: [String(e)] }));
  return true;
});
// 開いているBoxタブで、その日まだなら15秒後にカタログを1回取り込む。画面遷移では待ちをやり直さない。
const CATALOG_TODAY = "catalogToday";
const CATALOG_PENDING = "catalogTodayPending";
async function scheduleTodayCatalog(tabId) {
  const cfg = await getConfig();
  if (!cfg.ownDomain || await hasTodayCatalog(cfg.ownDomain)) return;
  const pending = await chrome.storage.session.get(CATALOG_PENDING).catch(() => chrome.storage.local.get(CATALOG_PENDING));
  if (pending[CATALOG_PENDING]) return;
  await chrome.storage.session.set({ [CATALOG_PENDING]: true, catalogTabId: tabId }).catch(() => chrome.storage.local.set({ [CATALOG_PENDING]: true, catalogTabId: tabId }));
  chrome.alarms.create(CATALOG_TODAY, { when: Date.now() + 15000 });
}
async function runTodayCatalog() {
  const cfg = await getConfig();
  if (!cfg.ownDomain || await hasTodayCatalog(cfg.ownDomain)) {
    await chrome.storage.session.set({ [CATALOG_PENDING]: false }).catch(() => chrome.storage.local.set({ [CATALOG_PENDING]: false }));
    return;
  }
  if (warming || isResolving()) {
    chrome.alarms.create(CATALOG_TODAY, { when: Date.now() + 15000 });
    return;
  }
  await chrome.storage.session.set({ [CATALOG_PENDING]: false }).catch(() => chrome.storage.local.set({ [CATALOG_PENDING]: false }));
  const tab = await findSearchTab(cfg);
  if (!tab) return;
  warming = true;
  try {
    await importCatalog(tab.id);
  } catch (e) {
    console.warn("today catalog import failed", e);
  } finally {
    warming = false;
  }
}
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete" || !tab.url) return;
  getConfig().then(cfg => {
    if (isBoxSearchTab(tab.url, cfg.ownDomain)) scheduleTodayCatalog(tabId);
  });
});
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === CATALOG_TODAY || a.name === "warmToday") runTodayCatalog();
});
