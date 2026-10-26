// 拡張の常駐処理。ポップアップ・右クリックから resolve。設定からカタログ収集／登録。
import { resolve, findSearchTab, collectCatalog, uploadCatalog, importCatalog } from "./resolver.js";
import { getConfig, isBoxSearchTab } from "./config.js";
chrome.storage.local.remove(["sharedIdHits", "searchCache", "lastWarm", "todayCacheOn", "catalogTodayPending", "catalogTabId"]);
chrome.storage.session.remove(["catalogTodayPending", "catalogTabId"]).catch(() => {});
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
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitUsableBoxTab(tabId, cfg, ms = 45000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t && isBoxSearchTab(t.url, cfg.ownDomain)) return t;
    } catch {
      return null;
    }
    const found = await findSearchTab(cfg);
    if (found) return found;
    await sleep(500);
  }
  return findSearchTab(cfg);
}
async function needSearchTab() {
  const cfg = await getConfig();
  if (!cfg.ownDomain) return { tab: null, error: "自社ドメインが未設定です" };
  let tab = await findSearchTab(cfg);
  if (tab) return { tab, error: "" };
  const created = await chrome.tabs.create({ url: "https://" + cfg.ownDomain + "/", active: true });
  if (!created || !created.id) return { tab: null, error: "Box タブを開けませんでした" };
  tab = await waitUsableBoxTab(created.id, cfg);
  if (!tab) return { tab: null, error: "Box にログインしてください" };
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
