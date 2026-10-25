// 設定とBox内部エンドポイント（非公開・推測を含む）をここに集約
export const DEFAULTS = {
  domainB: "",            // 例: mycompany.ent.box.com （https:// なし）
  // {q} は検索語, {n} は件数。複数行=順に試す。Box Web内部APIは非公開のため要調整
  searchEndpoints: [
    "/app-api/enduserapp/search?query={q}&limit={n}",
    "/app-api/enduserapp/recents?limit={n}",
    "/index.php?rm=box_search&query={q}"
  ].join("\n"),
  searchQueries: "*",     // カンマ区切り。空なら '*'
  limit: 200
};
export async function getConfig() {
  const c = await chrome.storage.sync.get(DEFAULTS);
  c.domainB = (c.domainB || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return c;
}
export function extractSharedId(s) {
  const m = String(s).match(/\/s\/([A-Za-z0-9]+)/);
  return m ? m[1] : (/^[A-Za-z0-9]{20,}$/.test(s.trim()) ? s.trim() : null);
}
