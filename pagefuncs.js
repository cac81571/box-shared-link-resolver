// 表示中の Box タブへ executeScript で注入する関数。
// 相対パス fetch なので、そのタブのオリジン（自社ドメイン）と Cookie が使われる。
export async function pageSearchOnce(sharedId, endpoint, folderId, updatedDays, page) {
  const log = [];
  // typedID は d_フォルダ / f_ファイル。id から接頭辞を外して遷移用 ID にする
  function itemHit(o) {
    if (!o || typeof o !== "object") return null;
    const id = o.id ?? o.typedID ?? o.itemID ?? o.item_id;
    if (id == null || !/\d/.test(String(id))) return null;
    const typ = String(o.type ?? o.itemType ?? o.typedID ?? "").toLowerCase();
    return { id: String(id).replace(/^[a-z]_/, ""), type: typ.includes("file") || String(o.typedID || "").startsWith("f_") ? "file" : "folder", name: String(o.name || o.itemName || "") };
  }
  // /s/ID の直後が区切り文字のときだけ一致（部分一致で別リンクを拾わない）
  const exactSidRe = new RegExp("/s/" + sharedId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:[/?#\"']|$)");
  function sharedLinkId(s) {
    const m = String(s || "").match(/\/s\/([A-Za-z0-9]+)/);
    return m ? m[1] : null;
  }
  function hasExactSharedId(s) {
    return sharedLinkId(s) === sharedId;
  }
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
    // 共有リンク付き items だけキャッシュ用に返す
    const items = [];
    try {
      const data = JSON.parse(txt);
      for (const o of data.items || []) {
        const sid = sharedLinkId(o && o.sharedLink);
        const it = itemHit(o);
        if (sid && it) items.push({ sharedId: sid, id: it.id, type: it.type, name: it.name });
      }
    } catch { }
    const hit = findHit(txt);
    if (exactSidRe.test(txt) && !hit) log.push("sharedIdは見つかったがIDを特定できず");
    return { id: hit && hit.id, type: hit && hit.type, name: (hit && hit.name) || "", items, page, pageCount, resultCount, log };
  } catch (e) {
    log.push("error " + url + ": " + e);
    return { page, pageCount: page, log };
  }
}
