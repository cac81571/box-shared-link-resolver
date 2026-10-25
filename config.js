// 設定の既定値と、共有リンクからの ID 抽出。
// ownDomain = 検索・遷移先（自社）。domainB = 共有リンクのホスト（コラボ先）。
function stripHost(s) {
  return String(s || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}
export const DEFAULTS = {
  ownDomain: "",          // 例: my-corp.ent.box.com （https:// なし）
  domainB: "",            // 例: customer-corp.ent.box.com （https:// なし）
  // Box Web 内部API（非公開）。{folderid} {updatedDays} {page} を実行時に置換
  searchEndpoints: "/app-api/enduserapp/folder/{folderid}/search?sortColumn=date&sortDirection=desc&updatedTime={updatedDays}&page={page}",
  folderId: 0,            // 検索の起点フォルダ。0 = すべてのファイル
  updatedDays: 7          // 過去何日分を検索するか
};
export async function getConfig() {
  const c = await chrome.storage.sync.get(DEFAULTS);
  c.ownDomain = stripHost(c.ownDomain);
  c.domainB = stripHost(c.domainB);
  c.folderId = c.folderId === "" || c.folderId == null ? 0 : +c.folderId;
  if (Number.isNaN(c.folderId)) c.folderId = 0;
  c.updatedDays = +c.updatedDays || 7;
  return c;
}
// https://…/s/xxxx または ID 文字列だけから共有IDを取る
export function extractSharedId(s) {
  const m = String(s).match(/\/s\/([A-Za-z0-9]+)/);
  return m ? m[1] : (/^[A-Za-z0-9]{20,}$/.test(s.trim()) ? s.trim() : null);
}
