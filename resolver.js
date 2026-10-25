// 共有リンクを自社ドメイン上の file/folder ID に解決して開く。
// 検索は表示中タブ（自社Box）で内部APIを呼ぶ。遷移先は常に ownDomain。
import { getConfig, extractSharedId } from "./config.js";
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
async function hasTodayCache(ownDomain) {
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
async function run(tabId, func, args) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func, args });
    return res.result || { log: ["no result"] };
  } catch (e) {
    return { log: ["executeScript: " + e] };
  }
}
// stopSid があればその共有IDで打ち切る。空なら全ページ収集（ウォームアップ）
async function fetchPages(tabId, cfg, updatedDays, hits, progress, stopSid) {
  const ep = (cfg.searchEndpoints || "").split("\n").map(s => s.trim()).filter(Boolean)[0] || "";
  const log = [];
  let pageCount = 1;
  let last = {};
  for (let page = 1; page <= pageCount && page <= MAX_PAGES; page++) {
    progress(((page - 1) / pageCount) * 100);
    if (page > 1) await sleep(PAGE_DELAY_MS);
    last = await run(tabId, pageSearchOnce, [stopSid || "", ep, cfg.folderId, updatedDays, page]);
    if (last.failed) {
      await sleep(1000);
      last = await run(tabId, pageSearchOnce, [stopSid || "", ep, cfg.folderId, updatedDays, page]);
    }
    log.push(...(last.log || []));
    mergePage(hits, last);
    if (last.pageCount) pageCount = Math.min(MAX_PAGES, +last.pageCount || pageCount);
    progress((page / pageCount) * 100);
    if (stopSid && (last.id || hits[stopSid])) {
      const hit = last.id ? last : hits[stopSid];
      rememberHit(hits, stopSid, hit);
      return { ...hit, log };
    }
  }
  return { ...last, log };
}
export async function warmCache(tabId) {
  const cfg = await getConfig();
  if (!cfg.ownDomain || !tabId) return { ok: false, count: 0, error: "tab or domain missing" };
  return withFetchLock(async () => {
    const hits = await loadHits(cfg.ownDomain, cfg.updatedDays);
    const r = await fetchPages(tabId, cfg, cfg.updatedDays, hits, () => {}, "");
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
  const cfg = await getConfig();
  if (!cfg.ownDomain) return { ok: false, log: ["オプションで自社ドメインを設定してください"] };
  const sid = extractSharedId(link);
  if (!sid) return { ok: false, log: ["共有IDを抽出できません: " + link] };
  log.push("sharedId=" + sid + " own=" + cfg.ownDomain + " collab=" + cfg.domainB);
  let hits = await loadHits(cfg.ownDomain, cfg.updatedDays);
  let builtToday = false;
  if (!(await hasTodayCache(cfg.ownDomain))) {
    const tabForSearch = await currentTab();
    if (!tabForSearch) return { ok: false, log: [...log, "処理するタブがありません"] };
    log.push("当日分キャッシュなし → 作成");
    await withFetchLock(async () => {
      hits = await loadHits(cfg.ownDomain, cfg.updatedDays);
      const rToday = await fetchPages(tabForSearch.id, cfg, 1, hits, progress, "");
      await saveHits(cfg.ownDomain, hits, cfg.updatedDays);
      await markTodayCache(cfg.ownDomain);
      log.push(...(rToday.log || []));
    });
    builtToday = true;
  }
  let r = hits[sid];
  if (!r || !r.id) {
    if (!builtToday) {
      const tabForSearch = await currentTab();
      if (!tabForSearch) return { ok: false, log: [...log, "処理するタブがありません"] };
      log.push("cache miss → 当日分を更新");
      r = await withFetchLock(async () => {
        hits = await loadHits(cfg.ownDomain, cfg.updatedDays);
        if (hits[sid]) return hits[sid];
        const found = await fetchPages(tabForSearch.id, cfg, 1, hits, progress, sid);
        await saveHits(cfg.ownDomain, hits, cfg.updatedDays);
        await markTodayCache(cfg.ownDomain);
        return found;
      });
      log.push(...(r.log || []));
    }
  }
  if (r && r.id) {
    log.push("cache hit name=" + (r.name || ""));
    progress(100);
  }
  if (!r || !r.id) return { ok: false, log: [...log, "見つかりませんでした"] };
  const name = r.name || "";
  const url = "https://" + cfg.ownDomain + "/" + r.type + "/" + r.id;
  log.push("→ " + url + (name ? " name=" + name : ""));
  const tab = await currentTab();
  if (tab) await chrome.tabs.update(tab.id, { url, active: true });
  else await chrome.tabs.create({ url, active: true });
  return { ok: true, url, log, name, type: r.type };
}
