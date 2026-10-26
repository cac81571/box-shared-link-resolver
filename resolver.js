// 共有リンクを自社ドメイン上の file/folder ID に解決して開く。
// 検索は表示中タブ（自社Box）で内部APIを呼ぶ。遷移先は常に ownDomain。
import { getConfig, extractSharedId, hostOf, isOwnBoxApp, isBoxSearchTab } from "./config.js";
import { pageSearchOnce } from "./pagefuncs.js";
const MAX_PAGES = 100;
const PAGE_DELAY_MS = 400; // 制限回避。毎秒2〜3リクエストに抑える
const HITS_KEY = "sharedIdHits";
const TODAY_KEY = "todayCacheOn";
const DAY_MS = 86400000;
function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
export async function hasTodayCache(ownDomain) {
  const v = await chrome.storage.local.get(TODAY_KEY);
  return ((v[TODAY_KEY] || {})[ownDomain] === todayStr());
}
async function markTodayCache(ownDomain) {
  const v = await chrome.storage.local.get(TODAY_KEY);
  const m = v[TODAY_KEY] || {};
  m[ownDomain] = todayStr();
  return chrome.storage.local.set({ [TODAY_KEY]: m });
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
function cutoffMs(updatedDays) {
  return Date.now() - Math.max(1, +updatedDays || 7) * DAY_MS;
}
function pruneHits(hits, updatedDays) {
  const cut = cutoffMs(updatedDays);
  for (const sid of Object.keys(hits)) {
    const t = hits[sid] && hits[sid].updatedAt;
    if (!hits[sid] || (t && t < cut)) delete hits[sid];
  }
  return hits;
}
async function loadHits(ownDomain, updatedDays) {
  const v = await chrome.storage.local.get([HITS_KEY, "searchCache"]);
  const all = v[HITS_KEY] || {};
  const hits = { ...(all[ownDomain] || {}) };
  const old = v.searchCache && v.searchCache.items;
  const now = Date.now();
  if (old) {
    for (const sid of Object.keys(old)) {
      const it = old[sid];
      if (!hits[sid] && it && it.id) hits[sid] = { id: it.id, type: it.type, name: it.name || "", updatedAt: it.updatedAt || 0, cachedAt: now };
    }
  }
  for (const sid of Object.keys(hits)) {
    if (hits[sid] && !hits[sid].cachedAt) hits[sid].cachedAt = now;
  }
  return pruneHits(hits, updatedDays);
}
async function saveHits(ownDomain, hits, updatedDays) {
  pruneHits(hits, updatedDays);
  const v = await chrome.storage.local.get(HITS_KEY);
  const all = v[HITS_KEY] || {};
  all[ownDomain] = hits;
  return chrome.storage.local.set({ [HITS_KEY]: all });
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
  const log = [];
  let pageCount = 1;
  let last = {};
  let lookSid = stopSid || "";
  let notified = false;
  for (let page = 1; page <= pageCount && page <= MAX_PAGES; page++) {
    progress(((page - 1) / pageCount) * 100);
    if (page > 1) await sleep(PAGE_DELAY_MS);
    last = await run(tabId, pageSearchOnce, [lookSid, ep, cfg.folderId, updatedDays, page]);
    if (last.failed) {
      await sleep(1000);
      last = await run(tabId, pageSearchOnce, [lookSid, ep, cfg.folderId, updatedDays, page]);
    }
    log.push(...(last.log || []));
    mergePage(hits, last);
    if (opts.save) await opts.save();
    if (last.pageCount) pageCount = Math.min(MAX_PAGES, +last.pageCount || pageCount);
    progress((page / pageCount) * 100);
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
export async function warmCache(tabId, days) {
  const cfg = await getConfig();
  if (!cfg.ownDomain || !tabId) return { ok: false, count: 0, error: "tab or domain missing" };
  const updatedDays = days || cfg.updatedDays;
  return withFetchLock(async () => {
    const hits = await loadHits(cfg.ownDomain, cfg.updatedDays);
    const r = await fetchPages(tabId, cfg, updatedDays, hits, () => {}, "");
    await saveHits(cfg.ownDomain, hits, cfg.updatedDays);
    const count = Object.keys(hits).length;
    const dated = Object.values(hits).filter(it => it && it.updatedAt).length;
    const hard = (r.log || []).find(s => String(s).startsWith("executeScript:"));
    const ok = !hard && count > 0;
    const error = hard || (!ok ? ((r.log || []).find(s => String(s).startsWith("error ")) || "取得できませんでした") : "");
    await chrome.storage.local.set({ lastWarm: { at: Date.now(), ok, count, dated, error, domain: cfg.ownDomain } });
    if (ok) await markTodayCache(cfg.ownDomain);
    return { ok, count, error };
  });
}
export async function resolve(link, onProgress) {
  const log = [];
  const progress = pct => { try { onProgress && onProgress(Math.max(0, Math.min(100, Math.round(pct)))); } catch { } };
  progress(0);
  resolving = true;
  try {
  const cfg = await getConfig();
  if (!cfg.ownDomain) return { ok: false, log: ["オプションで自社ドメインを設定してください"] };
  const sid = extractSharedId(link);
  if (!sid) return { ok: false, log: ["共有IDを抽出できません: " + link] };
  log.push("sharedId=" + sid + " own=" + cfg.ownDomain + " collab=" + cfg.domainB);
  let hits = await loadHits(cfg.ownDomain, cfg.updatedDays);
  let r = hits[sid];
  if (r && r.id && await hasTodayCache(cfg.ownDomain)) {
    log.push("cache hit name=" + (r.name || ""));
    progress(100);
    const tab = await currentTab();
    const url = await openHit(cfg, r, tab && tab.id);
    return { ok: true, url, log, name: r.name || "", type: r.type };
  }
  const tabForSearch = await findSearchTab(cfg);
  if (!tabForSearch) return { ok: false, needLogin: true, log: [...log, "Box にログインしてください"] };
  let report;
  const hitP = new Promise(res => { report = res; });
  let didOpen = false;
  const job = withFetchLock(async () => {
    hits = await loadHits(cfg.ownDomain, cfg.updatedDays);
    if (hits[sid] && hits[sid].id) report(hits[sid]);
    if (await hasTodayCache(cfg.ownDomain) && hits[sid] && hits[sid].id) return;
    log.push(hits[sid] ? "当日分を裏で継続" : "当日分を検索（ヒット後も継続）");
    await fetchPages(tabForSearch.id, cfg, 1, hits, progress, sid, {
      continueAfterHit: true,
      save: () => saveHits(cfg.ownDomain, hits, cfg.updatedDays),
      onHit: async hit => {
        report(hit);
        if (!didOpen) {
          didOpen = true;
          await openHit(cfg, hit, tabForSearch.id);
        }
      }
    });
    await saveHits(cfg.ownDomain, hits, cfg.updatedDays);
    await markTodayCache(cfg.ownDomain);
    report(hits[sid] || null);
  });
  r = await hitP;
  if (r && r.id) {
    log.push("cache hit name=" + (r.name || ""));
    progress(100);
    if (!didOpen) {
      didOpen = true;
      const url = await openHit(cfg, r, tabForSearch.id);
      return { ok: true, url, log, name: r.name || "", type: r.type };
    }
    const url = "https://" + cfg.ownDomain + "/" + r.type + "/" + r.id;
    return { ok: true, url, log, name: r.name || "", type: r.type };
  }
  await job;
  return { ok: false, log: [...log, "見つかりませんでした"] };
  } finally {
    resolving = false;
  }
}
