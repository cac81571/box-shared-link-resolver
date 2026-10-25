// 設定の既定値と、共有リンクからの ID 抽出。
// ownDomain = 検索・遷移先（自社）。domainB = 共有リンクのホスト（コラボ先）。
function stripHost(s) {
  return String(s || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
}
export const DEFAULTS = {
  ownDomain: "",          // 例: my-corp.ent.box.com （https:// なし）
  domainB: "",            // 例: customer-corp.ent.box.com （https:// なし）
  // Box Web 内部API（非公開）。{folderid} {updatedDays} {page} を実行時に置換
  searchEndpoints: "/app-api/enduserapp/folder/{folderid}/search?sortColumn=date&sortDirection=desc&updatedTime={updatedDays}&page={page}",
  folderId: 0,            // 検索の起点フォルダ。0 = すべてのファイル
  updatedDays: 7          // 過去何日分をキャッシュするか
};
export async function getConfig() {
  const c = await chrome.storage.sync.get(DEFAULTS);
  // 保存値が空なら DEFAULTS を使う（昔の空保存で初期値が消えないようにする）
  c.ownDomain = stripHost(c.ownDomain) || stripHost(DEFAULTS.ownDomain);
  c.domainB = stripHost(c.domainB) || stripHost(DEFAULTS.domainB);
  c.folderId = c.folderId === "" || c.folderId == null ? 0 : +c.folderId;
  if (Number.isNaN(c.folderId)) c.folderId = 0;
  c.updatedDays = +c.updatedDays || 7;
  return c;
}
export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}
function ownHosts(ownDomain) {
  const h = String(ownDomain || "").toLowerCase();
  const set = new Set([h]);
  if (h.endsWith(".ent.box.com")) set.add(h.replace(/\.ent\.box\.com$/, ".app.box.com"));
  if (h.endsWith(".app.box.com")) set.add(h.replace(/\.app\.box\.com$/, ".ent.box.com"));
  return set;
}
function isBoxAppPath(url) {
  try {
    const path = new URL(url).pathname;
    if (path.startsWith("/s/") || path.startsWith("/login") || path.startsWith("/oauth")) return false;
  } catch { return false; }
  return true;
}
// 自社Boxのアプリ画面（共有リンクやログインは対象外）
export function isOwnBoxApp(url, ownDomain) {
  if (!ownDomain || !ownHosts(ownDomain).has(hostOf(url))) return false;
  return isBoxAppPath(url);
}
// 検索に使えるBoxタブ。自社ドメインのほか app.box.com なども可
export function isBoxSearchTab(url, ownDomain) {
  if (isOwnBoxApp(url, ownDomain)) return true;
  const host = hostOf(url);
  if (host !== "box.com" && !host.endsWith(".box.com")) return false;
  return isBoxAppPath(url);
}
// https://…/s/xxxx または ID 文字列だけから共有IDを取る
export function extractSharedId(s) {
  const m = String(s).match(/\/s\/([A-Za-z0-9]+)/);
  return m ? m[1] : (/^[A-Za-z0-9]{20,}$/.test(s.trim()) ? s.trim() : null);
}
