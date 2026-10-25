// executeScript でBoxタブのページ内に注入して実行する関数（同一オリジンのCookieが使われる）
export async function pageCheap(sharedId) {
  const log = [];
  try {
    const r = await fetch("/s/" + sharedId, { credentials: "include", redirect: "follow" });
    log.push("GET /s/" + sharedId + " -> " + r.status + " " + r.url);
    const u = r.url.match(/\/(folder|file)\/(\d+)/);
    if (u) return { type: u[1], id: u[2], log };
    const h = await r.text();
    const id = h.match(/"itemID"\s*:\s*"?(\d+)/), t = h.match(/"itemType"\s*:\s*"(\w+)"/);
    if (id) return { type: t ? t[1] : "folder", id: id[1], log };
    log.push("HTMLにitemIDなし (長さ " + h.length + ")");
  } catch (e) { log.push("cheap error: " + e); }
  return { log };
}
export async function pageSearch(sharedId, endpoints, queries, limit) {
  const log = [];
  // JSON中を再帰的に探索し、sharedIdを含む値を持つオブジェクトのid/typeを返す
  function walk(o, depth) {
    if (!o || typeof o !== "object" || depth > 12) return null;
    if (!Array.isArray(o)) {
      const s = JSON.stringify(o);
      if (s.includes(sharedId) && s.length < 20000) {
        const id = o.id ?? o.typedID ?? o.itemID ?? o.item_id;
        if (id != null && /\d/.test(String(id))) {
          const typ = String(o.type ?? o.itemType ?? o.typedID ?? "").toLowerCase();
          return { id: String(id).replace(/^[a-z]_/, ""), type: typ.includes("file") || String(o.typedID||"").startsWith("f_") ? "file" : "folder" };
        }
      }
    }
    for (const v of Object.values(o)) { const r = walk(v, depth + 1); if (r) return r; }
    return null;
  }
  for (const ep of endpoints) for (const q of queries) {
    const url = ep.replace("{q}", encodeURIComponent(q)).replace("{n}", limit);
    try {
      const r = await fetch(url, { credentials: "include", headers: { "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" } });
      const txt = await r.text();
      log.push("GET " + url + " -> " + r.status + " (" + txt.length + "B) " + txt.slice(0, 150).replace(/\s+/g, " "));
      if (!txt.includes(sharedId)) continue;
      let hit = null;
      try { hit = walk(JSON.parse(txt), 0); } catch { }
      if (!hit) { // JSONでない場合: sharedId 近傍の数値IDを推定
        const i = txt.indexOf(sharedId), win = txt.slice(Math.max(0, i - 3000), i + 3000);
        const m = win.match(/"(?:typedID|id|itemID)"\s*:\s*"?(?:([df])_)?(\d{5,})/);
        if (m) hit = { id: m[2], type: m[1] === "f" ? "file" : "folder" };
      }
      if (hit) { hit.log = log; return hit; }
      log.push("sharedIdは見つかったがIDを特定できず");
    } catch (e) { log.push("error " + url + ": " + e); }
  }
  return { log };
}
