// 共有リンクを自社ドメイン上の file/folder ID に解決して開く。
// 検索は表示中タブ（自社Box）で内部APIを呼ぶ。遷移先は常に ownDomain。
import { getConfig, extractSharedId } from "./config.js";
import { pageSearchOnce } from "./pagefuncs.js";
const MAX_PAGES = 100;
const PAGE_DELAY_MS = 200; // 毎秒6リクエスト制限より少し余裕を見る
const CACHE_KEY = "searchCache";   // ページ取得状況（設定が変わると作り直す）
const HITS_KEY = "sharedIdHits";  // 共有ID→実体。自社ドメイン単位で消さず残す
const sleep = ms => new Promise(r => setTimeout(r, ms));
function cacheKey(cfg) {
  return [cfg.ownDomain, cfg.domainB, cfg.folderId, cfg.updatedDays, cfg.searchEndpoints].join("|");
}
async function loadCache(cfg) {
  const v = await chrome.storage.local.get(CACHE_KEY);
  const c = v[CACHE_KEY];
  if (!c || c.key !== cacheKey(cfg)) return { key: cacheKey(cfg), pages: {}, pageCount: 0 };
  return { key: c.key, pages: c.pages || {}, pageCount: +c.pageCount || 0 };
}
function saveCache(cache) {
  return chrome.storage.local.set({ [CACHE_KEY]: cache });
}
async function loadHits(ownDomain) {
  const v = await chrome.storage.local.get([HITS_KEY, CACHE_KEY]);
  const all = v[HITS_KEY] || {};
  const hits = { ...(all[ownDomain] || {}) };
  // 旧 searchCache.items があれば引き継ぐ
  const old = v[CACHE_KEY] && v[CACHE_KEY].items;
  if (old) {
    for (const sid of Object.keys(old)) {
      const it = old[sid];
      if (!hits[sid] && it && it.id) hits[sid] = { id: it.id, type: it.type, name: it.name || "" };
    }
  }
  return hits;
}
async function saveHits(ownDomain, hits) {
  const v = await chrome.storage.local.get(HITS_KEY);
  const all = v[HITS_KEY] || {};
  all[ownDomain] = hits;
  return chrome.storage.local.set({ [HITS_KEY]: all });
}
function rememberHit(hits, sid, item) {
  if (!sid || !item || !item.id) return;
  hits[sid] = { id: item.id, type: item.type, name: item.name || "" };
}
function mergePage(cache, hits, page) {
  for (const it of page.items || []) {
    if (it.sharedId) rememberHit(hits, it.sharedId, it);
  }
  if (page.page) cache.pages[page.page] = true;
  if (page.pageCount) cache.pageCount = Math.min(MAX_PAGES, +page.pageCount || cache.pageCount);
}
async function currentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}
// MAIN world で実行し、表示中ページと同じ Cookie で fetch する
async function run(tabId, func, args) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func, args });
  return res.result || { log: ["no result"] };
}
// skipCached=true なら既に取ったページは飛ばす。ヒットしたらそのページで止める
async function searchPages(tabId, sid, cfg, progress, cache, hits, skipCached) {
  const ep = (cfg.searchEndpoints || "").split("\n").map(s => s.trim()).filter(Boolean)[0] || "";
  const log = [];
  let pageCount = cache.pageCount || 1;
  let last = {};
  for (let page = 1; page <= pageCount && page <= MAX_PAGES; page++) {
    if (skipCached && cache.pages[page]) continue;
    progress(((page - 1) / pageCount) * 100);
    if (page > 1) await sleep(PAGE_DELAY_MS);
    last = await run(tabId, pageSearchOnce, [sid, ep, cfg.folderId, cfg.updatedDays, page]);
    log.push(...(last.log || []));
    mergePage(cache, hits, last);
    pageCount = cache.pageCount || pageCount;
    progress((page / pageCount) * 100);
    if (last.id || hits[sid]) {
      const hit = last.id ? last : hits[sid];
      rememberHit(hits, sid, hit);
      return { ...hit, log };
    }
  }
  return { ...last, log };
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
  const [cache, hits] = await Promise.all([loadCache(cfg), loadHits(cfg.ownDomain)]);
  let r = hits[sid];
  if (r) {
    log.push("cache hit name=" + (r.name || ""));
    progress(100);
  } else {
    const tabForSearch = await currentTab();
    if (!tabForSearch) return { ok: false, log: [...log, "処理するタブがありません"] };
    r = await searchPages(tabForSearch.id, sid, cfg, progress, cache, hits, true);
    log.push(...(r.log || []));
    // 全ページ取得済みでも無い → 期限切れの可能性があるので取り直す
    if (!r.id && cache.pageCount && Object.keys(cache.pages).length >= cache.pageCount) {
      cache.pages = {};
      log.push("cache miss → 再検索");
      r = await searchPages(tabForSearch.id, sid, cfg, progress, cache, hits, false);
      log.push(...(r.log || []));
    }
    rememberHit(hits, sid, r);
    await Promise.all([saveCache(cache), saveHits(cfg.ownDomain, hits)]);
  }
  if (!r.id) return { ok: false, log: [...log, "見つかりませんでした"] };
  const name = r.name || "";
  const url = "https://" + cfg.ownDomain + "/" + r.type + "/" + r.id;
  log.push("→ " + url + (name ? " name=" + name : ""));
  const tab = await currentTab();
  if (tab) await chrome.tabs.update(tab.id, { url, active: true });
  else await chrome.tabs.create({ url, active: true });
  return { ok: true, url, log, name, type: r.type };
}
