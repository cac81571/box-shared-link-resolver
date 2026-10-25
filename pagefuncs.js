// executeScript でBoxタブのページ内に注入して実行する関数（同一オリジンのCookieが使われる）
export async function pageSearchOnce(sharedId, endpoint, folderId, updatedDays, page) {
  const log = [];
  function itemHit(o) {
    if (!o || typeof o !== "object") return null;
    const id = o.id ?? o.typedID ?? o.itemID ?? o.item_id;
    if (id == null || !/\d/.test(String(id))) return null;
    const typ = String(o.type ?? o.itemType ?? o.typedID ?? "").toLowerCase();
    return { id: String(id).replace(/^[a-z]_/, ""), type: typ.includes("file") || String(o.typedID || "").startsWith("f_") ? "file" : "folder", name: String(o.name || o.itemName || "") };
  }
  const exactSidRe = new RegExp("/s/" + sharedId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:[/?#\"']|$)");
  function sharedLinkId(s) {
    const m = String(s || "").match(/\/s\/([A-Za-z0-9]+)/);
    return m ? m[1] : null;
  }
  function hasExactSharedId(s) {
    return sharedLinkId(s) === sharedId;
  }
  // JSON中を再帰的に探索し、共有IDが完全一致するオブジェクトのid/typeを返す
  function walk(o, depth) {
    if (!o || typeof o !== "object" || depth > 12) return null;
    if (!Array.isArray(o) && hasExactSharedId(o.sharedLink)) return itemHit(o);
    for (const v of Object.values(o)) { const r = walk(v, depth + 1); if (r) return r; }
    return null;
  }
  function findHit(txt) {
    try {
      const data = JSON.parse(txt);
      if (Array.isArray(data.items)) {
        for (const o of data.items) {
          if (hasExactSharedId(o && o.sharedLink)) return itemHit(o);
        }
      }
      const hit = walk(data, 0);
      if (hit) return hit;
    } catch { }
    const i = txt.search(exactSidRe);
    if (i < 0) return null;
    const win = txt.slice(Math.max(0, i - 3000), i + 3000);
    const m = win.match(/"(?:typedID|id|itemID)"\s*:\s*"?(?:([df])_)?(\d{5,})/);
    return m ? { id: m[2], type: m[1] === "f" ? "file" : "folder", name: "" } : null;
  }
  function pageUrl(base, n) {
    if (base.includes("{page}")) return base.replace(/\{page\}/g, String(n));
    const u = new URL(base, location.origin);
    u.searchParams.set("page", String(n));
    return u.pathname + u.search + u.hash;
  }
  const base = endpoint.replace("{folderid}", encodeURIComponent(folderId)).replace("{updatedDays}", encodeURIComponent(updatedDays));
  const url = pageUrl(base, page);
  try {
    const r = await fetch(url, { credentials: "include", headers: { "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" } });
    const txt = await r.text();
    let pageCount = 1, resultCount = null;
    let meta = "";
    try {
      const data = JSON.parse(txt);
      if (data.pageCount) pageCount = +data.pageCount || 1;
      if (data.resultCount != null) resultCount = data.resultCount;
      meta = " page=" + (data.pageNumber ?? page) + "/" + pageCount + " resultCount=" + (resultCount ?? "?");
    } catch { }
    log.push("GET " + url + " -> " + r.status + " (" + txt.length + "B)" + meta + " " + txt.slice(0, 120).replace(/\s+/g, " "));
    const hit = findHit(txt);
    if (exactSidRe.test(txt) && !hit) log.push("sharedIdは見つかったがIDを特定できず");
    return { id: hit && hit.id, type: hit && hit.type, name: (hit && hit.name) || "", page, pageCount, resultCount, log };
  } catch (e) {
    log.push("error " + url + ": " + e);
    return { page, pageCount: page, log };
  }
}
