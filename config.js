// 設定とBox内部エンドポイント（非公開・推測を含む）をここに集約
export const DEFAULTS = {
  domainB: "",            // 例: customer-corp.ent.box.com （https:// なし）
  // {folderid} はフォルダID, {updatedDays} は過去日数, {page} はページ番号。Box Web内部APIは非公開のため要調整
  searchEndpoints: "/app-api/enduserapp/folder/{folderid}/search?sortColumn=date&sortDirection=desc&updatedTime={updatedDays}&page={page}",
  folderId: 0,
  updatedDays: 7
};
export async function getConfig() {
  const c = await chrome.storage.sync.get(DEFAULTS);
  c.domainB = (c.domainB || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  c.folderId = c.folderId === "" || c.folderId == null ? 0 : +c.folderId;
  if (Number.isNaN(c.folderId)) c.folderId = 0;
  c.updatedDays = +c.updatedDays || 7;
  return c;
}
export function extractSharedId(s) {
  const m = String(s).match(/\/s\/([A-Za-z0-9]+)/);
  return m ? m[1] : (/^[A-Za-z0-9]{20,}$/.test(s.trim()) ? s.trim() : null);
}
