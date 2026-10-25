import { getConfig, extractSharedId } from "./config.js";
import { pageCheap, pageSearch } from "./pagefuncs.js";
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
export async function resolve(link) {
  const log = [];
  const cfg = await getConfig();
  if (!cfg.domainB) return { ok: false, log: ["オプションでドメインBを設定してください"] };
  const sid = extractSharedId(link);
  if (!sid) return { ok: false, log: ["共有IDを抽出できません: " + link] };
  log.push("sharedId=" + sid + " domain=" + cfg.domainB);
  const tab = await findBoxTab(cfg.domainB);
  let r = await run(tab.id, pageCheap, [sid]); log.push(...r.log);
  if (!r.id) {
    const eps = cfg.searchEndpoints.split("\n").map(s => s.trim()).filter(Boolean);
    const qs = (cfg.searchQueries || "*").split(",").map(s => s.trim()).filter(Boolean);
    r = await run(tab.id, pageSearch, [sid, eps, qs.length ? qs : ["*"], cfg.limit]); log.push(...r.log);
  }
  if (!r.id) return { ok: false, log: [...log, "見つかりませんでした"] };
  const url = "https://" + cfg.domainB + "/" + r.type + "/" + r.id;
  log.push("→ " + url);
  await chrome.tabs.update(tab.id, { url, active: true });
  return { ok: true, url, log };
}
