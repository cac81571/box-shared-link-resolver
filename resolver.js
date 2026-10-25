// 共有リンクを自社ドメイン上の file/folder ID に解決して開く。
// 検索は表示中タブ（自社Box）で内部APIを呼ぶ。遷移先は常に ownDomain。
import { getConfig, extractSharedId } from "./config.js";
import { pageSearchOnce } from "./pagefuncs.js";
const MAX_PAGES = 100;
const PAGE_DELAY_MS = 200; // 毎秒6リクエスト制限より少し余裕を見る
const CACHE_KEY = "searchCache";
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 設定が変わったら別キャッシュとして扱う
function cacheKey(cfg) {
  return [cfg.ownDomain, cfg.domainB, cfg.folderId, cfg.updatedDays, cfg.searchEndpoints].join("|");
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
// 1ページ分の items を sharedId → {id,type,name} で蓄積する
function mergePage(cache, page) {
  for (const it of page.items || []) {
    if (it.sharedId) cache.items[it.sharedId] = { id: it.id, type: it.type, name: it.name };
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
  if (!cfg.ownDomain) return { ok: false, log: ["オプションで自社ドメインを設定してください"] };
  const sid = extractSharedId(link);
  if (!sid) return { ok: false, log: ["共有IDを抽出できません: " + link] };
  log.push("sharedId=" + sid + " own=" + cfg.ownDomain + " collab=" + cfg.domainB);
  const cache = await loadCache(cfg);
  let r = cache.items[sid];
  if (r) {
    log.push("cache hit name=" + (r.name || ""));
    progress(100);
  } else {
    const tabForSearch = await currentTab();
    if (!tabForSearch) return { ok: false, log: [...log, "処理するタブがありません"] };
    r = await searchPages(tabForSearch.id, sid, cfg, progress, cache, true);
    log.push(...(r.log || []));
    // 全ページキャッシュ済みでも無い → 期限切れの可能性があるので取り直す
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
  const url = "https://" + cfg.ownDomain + "/" + r.type + "/" + r.id;
  log.push("→ " + url + (name ? " name=" + name : ""));
  const tab = await currentTab();
  if (tab) await chrome.tabs.update(tab.id, { url, active: true });
  else await chrome.tabs.create({ url, active: true });
  return { ok: true, url, log, name, type: r.type };
}
