import { getConfig, extractSharedId } from "./config.js";
import { pageSearchOnce } from "./pagefuncs.js";
const MAX_PAGES = 100;
const PAGE_DELAY_MS = 200; // 毎秒6リクエスト制限より少し余裕を見る
const CACHE_KEY = "searchCache";
const sleep = ms => new Promise(r => setTimeout(r, ms));
function cacheKey(cfg) {
  return [cfg.domainB, cfg.folderId, cfg.updatedDays, cfg.searchEndpoints].join("|");
}
async function loadCache(cfg) {
  const v = await chrome.storage.local.get(CACHE_KEY);
  const c = v[CACHE_KEY];
  if (!c || c.key !== cacheKey(cfg)) return { key: cacheKey(cfg), items: {}, pages: {}, pageCount: 0 };
  return { key: c.key, items: c.items || {}, pages: c.pages || {}, pageCount: +c.pageCount || 0 };
}
function saveCache(cache) {
  return chrome.storage.local.set({ [CACHE_KEY]: cache });
}
function mergePage(cache, page) {
  for (const it of page.items || []) {
    if (it.sharedId) cache.items[it.sharedId] = { id: it.id, type: it.type, name: it.name };
  }
  if (page.page) cache.pages[page.page] = true;
  if (page.pageCount) cache.pageCount = Math.min(MAX_PAGES, +page.pageCount || cache.pageCount);
}
async function findBoxTab(domain) {
  const tabs = await chrome.tabs.query({ url: "https://" + domain + "/*" });
  if (tabs.length) return tabs[0];
  const t = await chrome.tabs.create({ url: "https://" + domain + "/folder/0", active: true });
  await new Promise(r => { const f = (id, i) => { if (id === t.id && i.status === "complete") { chrome.tabs.onUpdated.removeListener(f); r(); } }; chrome.tabs.onUpdated.addListener(f); });
  return t;
}
async function run(tabId, func, args) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func, args });
  return res.result || { log: ["no result"] };
}
async function searchPages(tabId, sid, cfg, progress, cache, skipCached) {
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
    mergePage(cache, last);
    pageCount = cache.pageCount || pageCount;
    progress((page / pageCount) * 100);
    if (last.id || cache.items[sid]) {
      const hit = last.id ? last : cache.items[sid];
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
  if (!cfg.domainB) return { ok: false, log: ["オプションでコラボレーション先のドメインを設定してください"] };
  const sid = extractSharedId(link);
  if (!sid) return { ok: false, log: ["共有IDを抽出できません: " + link] };
  log.push("sharedId=" + sid + " domain=" + cfg.domainB);
  const cache = await loadCache(cfg);
  let r = cache.items[sid];
  if (r) {
    log.push("cache hit name=" + (r.name || ""));
    progress(100);
  } else {
    const tabForSearch = await findBoxTab(cfg.domainB);
    r = await searchPages(tabForSearch.id, sid, cfg, progress, cache, true);
    log.push(...(r.log || []));
    if (!r.id && cache.pageCount && Object.keys(cache.pages).length >= cache.pageCount) {
      cache.pages = {};
      log.push("cache miss → 再検索");
      r = await searchPages(tabForSearch.id, sid, cfg, progress, cache, false);
      log.push(...(r.log || []));
    }
    await saveCache(cache);
  }
  if (!r.id) return { ok: false, log: [...log, "見つかりませんでした"] };
  const name = r.name || "";
  const url = "https://" + cfg.domainB + "/" + r.type + "/" + r.id;
  log.push("→ " + url + (name ? " name=" + name : ""));
  const tab = await findBoxTab(cfg.domainB);
  await chrome.tabs.update(tab.id, { url, active: true });
  return { ok: true, url, log, name, type: r.type };
}
