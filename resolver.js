import { getConfig, extractSharedId } from "./config.js";
import { pageSearchOnce } from "./pagefuncs.js";
const MAX_PAGES = 100;
const PAGE_DELAY_MS = 200; // 毎秒6リクエスト制限より少し余裕を見る
const sleep = ms => new Promise(r => setTimeout(r, ms));
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
async function search(tabId, sid, cfg, progress) {
  const ep = (cfg.searchEndpoints || "").split("\n").map(s => s.trim()).filter(Boolean)[0] || "";
  const log = [];
  let pageCount = 1, last = {};
  for (let page = 1; page <= pageCount && page <= MAX_PAGES; page++) {
    progress(((page - 1) / pageCount) * 100);
    if (page > 1) await sleep(PAGE_DELAY_MS);
    last = await run(tabId, pageSearchOnce, [sid, ep, cfg.folderId, cfg.updatedDays, page]);
    log.push(...(last.log || []));
    if (last.pageCount) pageCount = Math.min(MAX_PAGES, +last.pageCount || pageCount);
    progress((page / pageCount) * 100);
    if (last.id) return { ...last, log };
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
  const tab = await findBoxTab(cfg.domainB);
  const r = await search(tab.id, sid, cfg, progress);
  log.push(...(r.log || []));
  if (!r.id) return { ok: false, log: [...log, "見つかりませんでした"] };
  const name = r.name || "";
  const url = "https://" + cfg.domainB + "/" + r.type + "/" + r.id;
  log.push("→ " + url + (name ? " name=" + name : ""));
  await chrome.tabs.update(tab.id, { url, active: true });
  return { ok: true, url, log, name, type: r.type };
}
