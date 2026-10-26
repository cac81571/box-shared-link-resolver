// 共有リンクを自社ドメイン上の file/folder ID に解決して開く。
// 検索は表示中タブ（自社Box）で内部APIを呼ぶ。遷移先は常に ownDomain。
import { getConfig, extractSharedId, hostOf, isOwnBoxApp, isBoxSearchTab, CATALOG_FILE_NAME, catalogParentId } from "./config.js";
import { pageSearchOnce, pageCatalogJob } from "./pagefuncs.js";
const MAX_PAGES = 100;
const CATALOG_MAX_PAGES = 2000;
const PAGE_DELAY_MS = 400; // 制限回避。毎秒2〜3リクエストに抑える
const CATALOG_KEY = "sharedCatalog";
const TODAY_CATALOG_KEY = "todayCatalogOn";
const FETCHED_AT_KEY = "catalogFetchedAt";
const FILE_MOD_KEY = "catalogFileModifiedAt";
function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
export async function hasTodayCatalog(ownDomain) {
  const v = await chrome.storage.local.get(TODAY_CATALOG_KEY);
  return ((v[TODAY_CATALOG_KEY] || {})[ownDomain] === todayStr());
}
async function markTodayCatalog(ownDomain) {
  const v = await chrome.storage.local.get(TODAY_CATALOG_KEY);
  const m = v[TODAY_CATALOG_KEY] || {};
  m[ownDomain] = todayStr();
  return chrome.storage.local.set({ [TODAY_CATALOG_KEY]: m });
}
async function markCatalogFetched(ownDomain, fileModifiedAt) {
  const v = await chrome.storage.local.get([FETCHED_AT_KEY, FILE_MOD_KEY]);
  const fetched = v[FETCHED_AT_KEY] || {};
  fetched[ownDomain] = Date.now();
  const next = { [FETCHED_AT_KEY]: fetched };
  if (fileModifiedAt) {
    const mods = v[FILE_MOD_KEY] || {};
    mods[ownDomain] = fileModifiedAt;
    next[FILE_MOD_KEY] = mods;
  }
  await chrome.storage.local.set(next);
  return markTodayCatalog(ownDomain);
}
async function catalogFileModifiedAt(ownDomain) {
  const v = await chrome.storage.local.get(FILE_MOD_KEY);
  return (v[FILE_MOD_KEY] || {})[ownDomain] || 0;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fetchLock = Promise.resolve();
let resolving = false;
export function isResolving() {
  return resolving;
}
function withFetchLock(fn) {
  const next = fetchLock.then(fn, fn);
  fetchLock = next.catch(() => {});
  return next;
}
export async function loadCatalog(ownDomain) {
  const v = await chrome.storage.local.get(CATALOG_KEY);
  return { ...((v[CATALOG_KEY] || {})[ownDomain] || {}) };
}
async function saveCatalog(ownDomain, items) {
  const v = await chrome.storage.local.get(CATALOG_KEY);
  const all = v[CATALOG_KEY] || {};
  all[ownDomain] = items;
  try {
    await chrome.storage.local.set({ [CATALOG_KEY]: all });
  } catch (e) {
    throw new Error("保存容量を超えました。日数を減らすか、フォルダ ID を絞ってください");
  }
}
function compactItems(items, domainB) {
  const out = {};
  for (const sid of Object.keys(items || {})) {
    const it = items[sid];
    if (!it || !it.id) continue;
    out[sid] = {
      sharedLink: domainB ? "https://" + domainB + "/s/" + sid : sid,
      id: String(it.id),
      type: it.type || "folder",
      name: it.name || "",
      updatedAt: it.updatedAt || 0
    };
  }
  return out;
}
function catalogPayload(cfg, items) {
  return {
    version: 1,
    ownDomain: cfg.ownDomain,
    domainB: cfg.domainB,
    exportedAt: Date.now(),
    updatedDays: cfg.catalogDays,
    items: compactItems(items, cfg.domainB)
  };
}
function mergeCatalogItems(dest, src) {
  for (const sid of Object.keys(src || {})) {
    const it = src[sid];
    if (!it || !it.id) continue;
    const cur = dest[sid];
    if (!cur || (it.updatedAt || 0) >= (cur.updatedAt || 0)) dest[sid] = it;
  }
  return dest;
}
function rememberHit(hits, sid, item) {
  if (!sid || !item || !item.id) return;
  hits[sid] = { id: item.id, type: item.type, name: item.name || "", updatedAt: item.updatedAt || hits[sid] && hits[sid].updatedAt || 0, cachedAt: Date.now() };
}
function mergePage(hits, page) {
  for (const it of page.items || []) {
    if (it.sharedId) rememberHit(hits, it.sharedId, it);
  }
}
async function currentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}
// 検索に使えるBoxタブ。表示中が自社Boxならそれを優先。なければ開いているBoxを探す
export async function findSearchTab(cfg) {
  const current = await currentTab();
  if (current && isBoxSearchTab(current.url, cfg.ownDomain)) return current;
  let tabs = await chrome.tabs.query({ url: ["https://*.box.com/*", "https://box.com/*"] });
  if (!tabs.length) tabs = (await chrome.tabs.query({})).filter(t => /box\.com/i.test(t.url || ""));
  const usable = tabs.filter(t => isBoxSearchTab(t.url, cfg.ownDomain));
  const exact = cfg.ownDomain ? usable.filter(t => isOwnBoxApp(t.url, cfg.ownDomain)) : [];
  return exact[0] || usable[0] || null;
}
function waitTabComplete(tabId, host, ms = 15000) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpd);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    function onUpd(id, info, tab) {
      if (id !== tabId || info.status !== "complete") return;
      if (!host || hostOf(tab.url) === host) finish();
    }
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId).then(t => {
      if (t.status === "complete" && (!host || hostOf(t.url) === host)) finish();
    }).catch(finish);
  });
}
async function openHit(cfg, hit, tabId) {
  const url = "https://" + cfg.ownDomain + "/" + hit.type + "/" + hit.id;
  if (tabId) {
    await chrome.tabs.update(tabId, { url, active: true });
    await waitTabComplete(tabId, cfg.ownDomain);
  } else {
    await chrome.tabs.create({ url, active: true });
  }
  return url;
}
async function run(tabId, func, args) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func, args });
    return res.result || { log: ["no result"] };
  } catch (e) {
    return { log: ["executeScript: " + e] };
  }
}
// stopSid があればヒットを通知。continueAfterHit なら残ページも集める
async function fetchPages(tabId, cfg, updatedDays, hits, progress, stopSid, opts = {}) {
  const ep = (cfg.searchEndpoints || "").split("\n").map(s => s.trim()).filter(Boolean)[0] || "";
  const maxPages = opts.maxPages || MAX_PAGES;
  const log = [];
  let pageCount = 1;
  let knownCount = false;
  let last = {};
  let lookSid = stopSid || "";
  let notified = false;
  const started = Date.now();
  function emit(page, total, done) {
    const remainMs = done > 0 && total > done ? Math.round((Date.now() - started) / done * (total - done)) : 0;
    progress(page, total, remainMs);
  }
  for (let page = 1; page <= pageCount && page <= maxPages; page++) {
    emit(page, knownCount ? pageCount : 0, page - 1);
    if (page > 1) await sleep(PAGE_DELAY_MS);
    last = await run(tabId, pageSearchOnce, [lookSid, ep, cfg.folderId, updatedDays, page]);
    if (last.failed) {
      await sleep(1000);
      last = await run(tabId, pageSearchOnce, [lookSid, ep, cfg.folderId, updatedDays, page]);
    }
    log.push(...(last.log || []));
    mergePage(hits, last);
    if (opts.save) await opts.save();
    if (last.pageCount) {
      pageCount = Math.min(maxPages, +last.pageCount || pageCount);
      knownCount = true;
    }
    emit(page, knownCount ? pageCount : 0, page);
    if (lookSid && (last.id || hits[lookSid])) {
      const hit = last.id ? last : hits[lookSid];
      rememberHit(hits, lookSid, hit);
      if (!notified && opts.onHit) {
        notified = true;
        await opts.onHit(hit);
      }
      if (!opts.continueAfterHit) return { ...hit, log };
      lookSid = "";
    }
  }
  return { ...last, log };
}
async function lookupSid(ownDomain, sid) {
  const cat = await loadCatalog(ownDomain);
  if (cat[sid] && cat[sid].id) return cat[sid];
  return null;
}
async function rememberCatalog(cfg, extra) {
  const items = await loadCatalog(cfg.ownDomain);
  const dated = Object.values(items).filter(it => it && it.updatedAt).length;
  await chrome.storage.local.set({
    lastCatalog: {
      at: Date.now(),
      count: Object.keys(items).length,
      dated,
      domain: cfg.ownDomain,
      folderId: catalogParentId(cfg),
      fileName: CATALOG_FILE_NAME,
      ...extra
    }
  });
}
async function isolatedPublishSend(ownDomain, domainB, catalogDays) {
  const v = await chrome.storage.local.get("sharedCatalog");
  const raw = ((v.sharedCatalog || {})[ownDomain]) || {};
  const items = {};
  for (const sid of Object.keys(raw)) {
    const it = raw[sid];
    if (!it || !it.id) continue;
    items[sid] = {
      sharedLink: domainB ? "https://" + domainB + "/s/" + sid : sid,
      id: String(it.id),
      type: it.type || "folder",
      name: it.name || "",
      updatedAt: it.updatedAt || 0
    };
  }
  const jsonText = JSON.stringify({ version: 1, ownDomain, domainB, exportedAt: Date.now(), updatedDays: catalogDays, items });
  const doneP = new Promise(resolve => {
    const timer = setTimeout(() => resolve({ result: { ok: false, error: "Box への登録がタイムアウトしました" } }), 120000);
    function onMsg(e) {
      if (!e.data || e.data.source !== "box-slr-pub-done") return;
      clearTimeout(timer);
      window.removeEventListener("message", onMsg);
      resolve(e.data);
    }
    window.addEventListener("message", onMsg);
  });
  const CHUNK = 256 * 1024;
  const total = Math.ceil(jsonText.length / CHUNK) || 1;
  for (let i = 0; i < total; i++) {
    window.postMessage({ source: "box-slr-pub", i, total, chunk: jsonText.slice(i * CHUNK, (i + 1) * CHUNK) }, "*");
  }
  const done = await doneP;
  return done && done.result;
}
async function isolatedImportRecv() {
  const chunks = {};
  const bodyP = new Promise(resolve => {
    function onChunk(e) {
      const d = e.data;
      if (!d || d.source !== "box-slr-imp") return;
      chunks[d.i] = d.chunk;
      if (d.total && Object.keys(chunks).length >= d.total) {
        window.removeEventListener("message", onChunk);
        let s = "";
        for (let i = 0; i < d.total; i++) s += chunks[i] || "";
        resolve(s);
      }
    }
    window.addEventListener("message", onChunk);
  });
  const doneP = new Promise(resolve => {
    const timer = setTimeout(() => resolve({ result: { ok: false, error: "取り込みがタイムアウトしました" } }), 120000);
    function onMsg(e) {
      if (!e.data || e.data.source !== "box-slr-imp-done") return;
      clearTimeout(timer);
      window.removeEventListener("message", onMsg);
      resolve(e.data);
    }
    window.addEventListener("message", onMsg);
  });
  window.postMessage({ source: "box-slr-imp-start" }, "*");
  const done = await doneP;
  const result = (done && done.result) || { ok: false, error: "応答がありません" };
  if (!result.ok) return result;
  if (result.skipped) return { ok: true, skipped: true, fileId: result.fileId || "", sharedLink: result.sharedLink || "", modifiedAt: result.modifiedAt || 0 };
  await chrome.storage.local.set({ _catalogImport: await bodyP });
  return { ok: true, fileId: result.fileId || "", sharedLink: result.sharedLink || "", modifiedAt: result.modifiedAt || 0 };
}
async function collectCatalogInner(tabId, cfg, onProgress) {
  const days = cfg.catalogDays || 365;
  const progress = (page, pageCount, remainMs) => { try { onProgress && onProgress({ page, pageCount, remainMs }); } catch { } };
  const hits = await loadCatalog(cfg.ownDomain);
  let n = 0;
  const r = await fetchPages(tabId, cfg, days, hits, progress, "", {
    maxPages: CATALOG_MAX_PAGES,
    save: async () => {
      n++;
      if (n % 10 === 0) await saveCatalog(cfg.ownDomain, hits);
    }
  });
  await saveCatalog(cfg.ownDomain, hits);
  const count = Object.keys(hits).length;
  const hard = (r.log || []).find(s => String(s).startsWith("executeScript:"));
  const capped = (r.pageCount && r.page >= CATALOG_MAX_PAGES);
  const error = hard || (!count ? ((r.log || []).find(s => String(s).startsWith("error ")) || "取得できませんでした") : "");
  return { ok: !hard && count > 0, count, capped, error, items: hits };
}
export async function collectCatalog(tabId, onProgress) {
  const cfg = await getConfig();
  if (!cfg.ownDomain) return { ok: false, count: 0, error: "自社ドメインが未設定です" };
  if (!tabId) return { ok: false, count: 0, error: "Box にログインしてください" };
  return withFetchLock(async () => {
    const collected = await collectCatalogInner(tabId, cfg, onProgress);
    await rememberCatalog(cfg, {
      ok: !!collected.ok,
      error: collected.ok ? (collected.capped ? "ページ上限に達したため、古い分は含まれていない可能性があります" : "") : (collected.error || "取得できませんでした"),
      action: "collect",
      capped: !!collected.capped
    });
    return collected;
  });
}
export async function uploadCatalog(tabId) {
  const cfg = await getConfig();
  if (!cfg.ownDomain) return { ok: false, count: 0, error: "自社ドメインが未設定です" };
  if (!tabId) return { ok: false, count: 0, error: "Box にログインしてください" };
  return withFetchLock(async () => {
    const items = await loadCatalog(cfg.ownDomain);
    const count = Object.keys(items).length;
    if (!count) {
      const error = "先に「収集」してください";
      await rememberCatalog(cfg, { ok: false, error, action: "publish" });
      return { ok: false, count: 0, error };
    }
    const installed = await run(tabId, pageCatalogJob, ["publish", catalogParentId(cfg), CATALOG_FILE_NAME]);
    if (!installed || !installed.ready) {
      const error = "Box タブへ処理を入れられませんでした。" + ((installed && installed.log && installed.log[0]) || "");
      await rememberCatalog(cfg, { ok: false, error, action: "publish" });
      return { ok: false, count, error };
    }
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: isolatedPublishSend,
      args: [cfg.ownDomain, cfg.domainB, cfg.catalogDays]
    });
    const uploaded = (res && res.result) || { ok: false, error: "Box への登録に失敗しました" };
    await rememberCatalog(cfg, {
      ok: !!uploaded.ok,
      error: uploaded.ok ? "" : (uploaded.error || "Box への登録に失敗しました"),
      action: "publish",
      fileId: uploaded.fileId || "",
      sharedLink: uploaded.sharedLink || ""
    });
    return {
      ok: !!uploaded.ok,
      count,
      fileId: uploaded.fileId || "",
      sharedLink: uploaded.sharedLink || "",
      error: uploaded.ok ? "" : (uploaded.error || "Box への登録に失敗しました")
    };
  });
}
export async function importCatalog(tabId) {
  const cfg = await getConfig();
  if (!cfg.ownDomain) return { ok: false, count: 0, error: "自社ドメインが未設定です" };
  if (!tabId) return { ok: false, count: 0, error: "Box にログインしてください" };
  return withFetchLock(async () => {
    const local = await loadCatalog(cfg.ownDomain);
    const sinceMs = Object.keys(local).length ? await catalogFileModifiedAt(cfg.ownDomain) : 0;
    const installed = await run(tabId, pageCatalogJob, ["import", catalogParentId(cfg), CATALOG_FILE_NAME, sinceMs]);
    if (!installed || !installed.ready) {
      const error = "Box タブへ処理を入れられませんでした";
      await rememberCatalog(cfg, { ok: false, error, action: "import" });
      return { ok: false, count: 0, error };
    }
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: isolatedImportRecv });
    const got = (res && res.result) || { ok: false, error: "取り込みに失敗しました" };
    if (!got.ok) {
      await rememberCatalog(cfg, { ok: false, error: got.error || "取り込みに失敗しました", action: "import" });
      return { ok: false, count: 0, error: got.error || "取り込みに失敗しました" };
    }
    if (got.skipped) {
      await markTodayCatalog(cfg.ownDomain);
      await rememberCatalog(cfg, { ok: true, error: "ファイル未更新のためスキップ", action: "import", skipped: true, fileId: got.fileId || "", sharedLink: got.sharedLink || "" });
      return { ok: true, skipped: true, count: Object.keys(local).length, fileId: got.fileId || "", sharedLink: got.sharedLink || "" };
    }
    try {
      const raw = await chrome.storage.local.get("_catalogImport");
      let data;
      try { data = JSON.parse(raw._catalogImport || ""); } catch { data = null; }
      const incoming = data && data.items && typeof data.items === "object" ? data.items : null;
      if (!incoming) {
        await rememberCatalog(cfg, { ok: false, error: "カタログの形式が違います", action: "import" });
        return { ok: false, count: 0, error: "カタログの形式が違います" };
      }
      const merged = mergeCatalogItems(await loadCatalog(cfg.ownDomain), incoming);
      await saveCatalog(cfg.ownDomain, merged);
      await markCatalogFetched(cfg.ownDomain, got.modifiedAt);
      await rememberCatalog(cfg, { ok: true, error: "", action: "import", fileId: got.fileId || "", sharedLink: got.sharedLink || "" });
      return { ok: true, count: Object.keys(merged).length, fileId: got.fileId || "", sharedLink: got.sharedLink || "" };
    } finally {
      await chrome.storage.local.remove("_catalogImport");
    }
  });
}
export async function importCatalogJson(jsonText) {
  const cfg = await getConfig();
  if (!cfg.ownDomain) return { ok: false, count: 0, error: "自社ドメインが未設定です" };
  let data;
  try { data = JSON.parse(jsonText || ""); } catch { data = null; }
  const incoming = data && data.items && typeof data.items === "object" ? data.items : null;
  if (!incoming) return { ok: false, count: 0, error: "カタログの形式が違います" };
  const merged = mergeCatalogItems(await loadCatalog(cfg.ownDomain), incoming);
  await saveCatalog(cfg.ownDomain, merged);
  await markCatalogFetched(cfg.ownDomain);
  await rememberCatalog(cfg, { ok: true, error: "", action: "import" });
  return { ok: true, count: Object.keys(merged).length };
}
export async function exportCatalogJson() {
  const cfg = await getConfig();
  const items = cfg.ownDomain ? await loadCatalog(cfg.ownDomain) : {};
  return JSON.stringify(catalogPayload(cfg, items), null, 2);
}
export async function resolve(link, onProgress) {
  const log = [];
  const emit = info => { try { onProgress && onProgress(info); } catch { } };
  resolving = true;
  try {
  const cfg = await getConfig();
  if (!cfg.ownDomain) return { ok: false, log: ["オプションで自社ドメインを設定してください"] };
  const sid = extractSharedId(link);
  if (!sid) return { ok: false, log: ["共有IDを抽出できません: " + link] };
  log.push("sharedId=" + sid + " own=" + cfg.ownDomain + " collab=" + cfg.domainB);
  let tabForSearch = await findSearchTab(cfg);
  if (!await hasTodayCatalog(cfg.ownDomain)) {
    if (!tabForSearch) tabForSearch = await findSearchTab(cfg);
    if (!tabForSearch) return { ok: false, needLogin: true, log: [...log, "Box にログインしてください"] };
    emit({ phase: "import" });
    log.push("本日のカタログを取り込み");
    try {
      const imp = await importCatalog(tabForSearch.id);
      log.push(imp && imp.ok ? (imp.skipped ? "カタログ未更新のためスキップ" : ("カタログ " + (imp.count || 0) + "件")) : ("カタログ取り込み失敗 " + ((imp && imp.error) || "")));
    } catch (e) {
      log.push("カタログ取り込み失敗 " + e);
    }
  }
  emit({ phase: "catalog" });
  let r = await lookupSid(cfg.ownDomain, sid);
  if (r && r.id) {
    log.push("storage hit name=" + (r.name || ""));
    const tab = await currentTab();
    const url = await openHit(cfg, r, tab && tab.id);
    return { ok: true, url, log, name: r.name || "", type: r.type };
  }
  if (!tabForSearch) tabForSearch = await findSearchTab(cfg);
  if (!tabForSearch) return { ok: false, needLogin: true, log: [...log, "Box にログインしてください"] };
  const days = cfg.updatedDays;
  log.push("ストレージになし。過去" + days + "日分を検索");
  emit({ phase: "recent", days });
  const progress = (page, pageCount, remainMs) => emit({ phase: "recent", days, page, pageCount, remainMs });
  let report;
  const hitP = new Promise(res => { report = res; });
  let didOpen = false;
  const found = {};
  const job = withFetchLock(async () => {
    await fetchPages(tabForSearch.id, cfg, days, found, progress, sid, {
      continueAfterHit: true,
      onHit: async hit => {
        report(hit);
        if (!didOpen) {
          didOpen = true;
          await openHit(cfg, hit, tabForSearch.id);
        }
      }
    });
    await saveCatalog(cfg.ownDomain, mergeCatalogItems(await loadCatalog(cfg.ownDomain), found));
    report(found[sid] || null);
  });
  r = await hitP;
  if (r && r.id) {
    log.push("search hit name=" + (r.name || ""));
    if (!didOpen) {
      didOpen = true;
      const url = await openHit(cfg, r, tabForSearch.id);
      return { ok: true, url, log, name: r.name || "", type: r.type };
    }
    const url = "https://" + cfg.ownDomain + "/" + r.type + "/" + r.id;
    return { ok: true, url, log, name: r.name || "", type: r.type };
  }
  await job;
  return { ok: false, notFound: true, days, log: [...log, "見つかりませんでした"] };
  } finally {
    resolving = false;
  }
}
