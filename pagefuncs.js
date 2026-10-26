// 表示中の Box タブへ executeScript で注入する関数。
// 相対パス fetch なので、そのタブのオリジン（自社ドメイン）と Cookie が使われる。
export async function pageSearchOnce(sharedId, endpoint, folderId, updatedDays, page) {
  const log = [];
  // typedID は d_フォルダ / f_ファイル。id から接頭辞を外して遷移用 ID にする
  function toMs(v, depth) {
    if (v == null || v === "" || depth > 3) return 0;
    if (typeof v === "number" && Number.isFinite(v)) {
      if (v > 1e12 && v < 2e13) return Math.round(v);
      if (v > 1e9 && v < 2e10) return Math.round(v * 1000);
      return 0;
    }
    if (typeof v === "string") {
      const s = v.trim();
      const asp = s.match(/\/Date\((\d+)/);
      if (asp) return +asp[1];
      if (/^\d{10,13}$/.test(s)) return toMs(+s, depth + 1);
      const jp = s.match(/(\d{4})[年/\-](\d{1,2})[月/\-](\d{1,2})/);
      if (jp) return new Date(+jp[1], +jp[2] - 1, +jp[3]).getTime();
      if (/^\d{4}-\d{2}-\d{2}/.test(s) || /T\d{2}:/.test(s)) {
        const t = Date.parse(s);
        return Number.isNaN(t) ? 0 : t;
      }
      return 0;
    }
    if (typeof v === "object") {
      for (const k of ["milliseconds", "ms", "time", "value", "date", "timestamp"]) {
        const ms = toMs(v[k], depth + 1);
        if (ms) return ms;
      }
    }
    return 0;
  }
  function itemUpdatedAt(o) {
    if (!o || typeof o !== "object") return 0;
    // Box 検索は contentUpdated / date が Unix 秒の文字列
    return toMs(o.contentUpdated, 0) || toMs(o.date, 0) || toMs(o.searchIndexUpdated, 0);
  }
  function linkText(s) {
    if (s && typeof s === "object") return s.url || s.downloadURL || s.vanityURL || "";
    return s;
  }
  function itemHit(o) {
    if (!o || typeof o !== "object") return null;
    const id = o.id ?? o.typedID ?? o.itemID ?? o.item_id;
    if (id == null || !/\d/.test(String(id))) return null;
    const typ = String(o.type ?? o.itemType ?? o.typedID ?? "").toLowerCase();
    return { id: String(id).replace(/^[a-z]_/, ""), type: typ.includes("file") || String(o.typedID || "").startsWith("f_") ? "file" : "folder", name: String(o.name || o.itemName || ""), updatedAt: itemUpdatedAt(o) };
  }
  // /s/ID の直後が区切り文字のときだけ一致。sharedId 空なら収集のみ
  const exactSidRe = sharedId
    ? new RegExp("/s/" + sharedId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:[/?#\"']|$)")
    : /(?!)/;
  function sharedLinkId(s) {
    const m = String(linkText(s) || "").match(/\/s\/([A-Za-z0-9]+)/);
    return m ? m[1] : null;
  }
  function hasExactSharedId(s) {
    return !!sharedId && sharedLinkId(s) === sharedId;
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
    let r, lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        r = await fetch(url, { credentials: "include", headers: { "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" } });
        if (r.status === 429 || r.status === 503) {
          lastErr = new Error("HTTP " + r.status);
          r = null;
          await new Promise(ok => setTimeout(ok, 2000 * (attempt + 1)));
          continue;
        }
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        await new Promise(ok => setTimeout(ok, 2000 * (attempt + 1)));
      }
    }
    if (!r) throw lastErr;
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
    // 共有リンク付き items だけ返す
    const items = [];
    try {
      const data = JSON.parse(txt);
      const list = data.items || data.entries || [];
      for (const o of list) {
        const sid = sharedLinkId(o && (o.sharedLink || o.shared_link));
        const it = itemHit(o);
        if (sid && it) items.push({ sharedId: sid, id: it.id, type: it.type, name: it.name, updatedAt: it.updatedAt });
      }
    } catch { }
    const hit = findHit(txt);
    if (exactSidRe.test(txt) && !hit) log.push("sharedIdは見つかったがIDを特定できず");
    return { id: hit && hit.id, type: hit && hit.type, name: (hit && hit.name) || "", updatedAt: (hit && hit.updatedAt) || 0, items, page, pageCount, resultCount, log };
  } catch (e) {
    log.push("error " + url + ": " + e);
    return { page, failed: true, log };
  }
}

// MAIN world へ注入する。kind は "publish" | "import"。helpers はクロージャ不可なので関数内に置く
export function pageCatalogJob(kind, folderId, fileName) {
  const PUB_SRC = "box-slr-pub";
  const PUB_DONE = "box-slr-pub-done";
  const IMP_START = "box-slr-imp-start";
  const IMP_SRC = "box-slr-imp";
  const IMP_DONE = "box-slr-imp-done";
  const log = [];
  function push(s) { log.push(s); }
  function parseJson(s) { try { return JSON.parse(s); } catch { return null; } }
  function joinChunks(chunks, total) {
    let s = "";
    for (let i = 0; i < total; i++) s += chunks[i] || "";
    return s;
  }
  function getRequestToken() {
    const c = window.Box && window.Box.config;
    if (c && (c.requestToken || c.request_token)) return c.requestToken || c.request_token;
    try {
      const html = document.documentElement.innerHTML.slice(0, 400000);
      const m = html.match(/["']requestToken["']\s*:\s*["']([^"']+)["']/);
      if (m) return m[1];
    } catch { }
    return "";
  }
  function pickToken(data) {
    const writes = [], reads = [];
    function walk(o, depth) {
      if (!o || typeof o !== "object" || depth > 6) return;
      if (typeof o.write === "string" && o.write.length > 20) writes.push(o.write);
      if (typeof o.read === "string" && o.read.length > 20) reads.push(o.read);
      if (typeof o.accessToken === "string" && o.accessToken.length > 20) writes.push(o.accessToken);
      for (const v of Object.values(o)) if (v && typeof v === "object") walk(v, depth + 1);
    }
    walk(data, 0);
    return writes[0] || reads[0] || "";
  }
  function enduserHeaders(rt) {
    const h = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Box-Client-Name": "enduserapp",
      "X-Box-Client-Version": "23.810.1"
    };
    if (rt) {
      h["Request-Token"] = rt;
      h["X-Request-Token"] = rt;
      h["X-Csrf-Token"] = rt;
    }
    return h;
  }
  async function getScopedToken() {
    const rt = getRequestToken();
    if (!rt) { push("requestToken なし。自社 Box の画面を前面にしてやり直してください"); return ""; }
    try {
      const r = await fetch("/index.php?rm=box_upload_get_scoped_token", {
        method: "POST",
        credentials: "include",
        headers: enduserHeaders(rt),
        body: JSON.stringify({ folder_id: String(folderId) })
      });
      const txt = await r.text();
      push("SCOPED -> " + r.status + " " + txt.slice(0, 80).replace(/\s+/g, " "));
      const data = parseJson(txt);
      if (data && data.access_token) return data.access_token;
    } catch (e) { push("SCOPED error " + e); }
    return "";
  }
  async function getReadToken(fileId) {
    const rt = getRequestToken();
    if (!rt || !fileId) return "";
    try {
      const r = await fetch("/app-api/enduserapp/elements/tokens", {
        method: "POST",
        credentials: "include",
        headers: enduserHeaders(rt),
        body: JSON.stringify({ fileIDs: [String(fileId)] })
      });
      const txt = await r.text();
      push("TOKENS -> " + r.status);
      return pickToken(parseJson(txt));
    } catch (e) { push("TOKENS error " + e); }
    return "";
  }
  function credFor(url) {
    return /^https?:\/\//i.test(url) && url.indexOf(location.origin) !== 0 ? "omit" : "include";
  }
  async function apiJson(url, opt, token) {
    const headers = { Accept: "application/json", ...(opt.headers || {}) };
    if (token) headers.Authorization = "Bearer " + token;
    const r = await fetch(url, { credentials: credFor(url), ...opt, headers });
    const txt = await r.text();
    return { status: r.status, ok: r.ok, data: parseJson(txt), txt: txt.slice(0, 300), raw: txt };
  }
  function fileFromEntries(data) {
    const lists = [data && data.entries, data && data.items, data && data.item_collection && data.item_collection.entries].filter(Boolean);
    for (const list of lists) {
      for (const it of list) {
        if (it && String(it.name || "") === fileName && it.id) {
          return { id: String(it.id).replace(/^f_/, ""), sharedLink: (it.shared_link && it.shared_link.url) || (it.sharedLink && (it.sharedLink.url || it.sharedLink)) || "" };
        }
      }
    }
    return null;
  }
  function conflictId(data) {
    const c = data && data.context_info && (data.context_info.conflicts || [])[0];
    return c && c.id ? String(c.id) : "";
  }
  async function findFile(token) {
    const urls = [
      "/app-api/enduserapp/folder/" + encodeURIComponent(folderId) + "/items",
      "/app-api/enduserapp/folder/" + encodeURIComponent(folderId),
      "https://api.box.com/2.0/folders/" + encodeURIComponent(folderId) + "/items?fields=id,name,type,shared_link&limit=1000"
    ];
    for (const url of urls) {
      try {
        const { ok, data, status, txt } = await apiJson(url, { method: "GET" }, token);
        push("FIND " + url.replace("https://api.box.com", "api") + " -> " + status + " " + txt.replace(/\s+/g, " ").slice(0, 80));
        if (!ok || !data) continue;
        const hit = fileFromEntries(data);
        if (hit && hit.id) return hit;
      } catch (e) { push("FIND error " + e); }
    }
    return null;
  }
  async function ensureShare(fileId, token) {
    const tries = [
      { url: "https://api.box.com/2.0/files/" + encodeURIComponent(fileId), body: { shared_link: { access: "company", permissions: { can_download: true } } } },
      { url: "/api/2.0/files/" + encodeURIComponent(fileId), body: { shared_link: { access: "company", permissions: { can_download: true } } } },
      { url: "/app-api/enduserapp/item/f_" + encodeURIComponent(fileId), body: { sharedLink: { access: "company" } } }
    ];
    for (const t of tries) {
      try {
        const { ok, data, status } = await apiJson(t.url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(t.body) }, token);
        push("SHARE -> " + status);
        if (!ok) continue;
        const url = (data && data.shared_link && data.shared_link.url) || (data && data.sharedLink && (data.sharedLink.url || data.sharedLink)) || "";
        if (url) return url;
      } catch (e) { push("SHARE error " + e); }
    }
    return "";
  }
  function makeForm(jsonText) {
    const fd = new FormData();
    fd.append("attributes", JSON.stringify({
      name: fileName,
      parent: { id: String(folderId) },
      content_modified_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
    }));
    fd.append("file", new Blob([jsonText], { type: "application/json" }), fileName);
    return fd;
  }
  async function preflight(existingId, size, token) {
    const path = existingId
      ? "https://api.box.com/2.0/files/" + encodeURIComponent(existingId) + "/content"
      : "https://api.box.com/2.0/files/content";
    const body = existingId
      ? { name: fileName, size }
      : { name: fileName, parent: { id: String(folderId) }, size };
    const attempts = [
      { useToken: false },
      { useToken: true }
    ];
    for (const a of attempts) {
      if (a.useToken && !token) continue;
      try {
        const headers = {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Box-Client-Name": "ContentUploader",
          "X-Box-Client-Version": "28.0.0-beta.12"
        };
        if (a.useToken) headers.Authorization = "Bearer " + token;
        const r = await fetch(path, { method: "OPTIONS", credentials: "omit", headers, body: JSON.stringify(body) });
        const txt = await r.text();
        const data = parseJson(txt);
        push("PREFLIGHT -> " + r.status + (a.useToken ? " bearer" : "") + " " + txt.slice(0, 80).replace(/\s+/g, " "));
        if (r.status === 409) return { conflictId: conflictId(data), data };
        if (data && data.upload_url) return { ok: r.ok, upload_url: data.upload_url, upload_token: data.upload_token || "", data };
      } catch (e) { push("PREFLIGHT error " + e + (a.useToken ? " bearer" : "")); }
    }
    return {};
  }
  async function postUpload(url, jsonText, token) {
    const headers = {
      "X-Box-Client-Name": "ContentUploader",
      "X-Box-Client-Version": "28.0.0-beta.12"
    };
    if (token) headers.Authorization = "Bearer " + token;
    const r = await fetch(url, { method: "POST", credentials: "omit", headers, body: makeForm(jsonText) });
    const txt = await r.text();
    const data = parseJson(txt);
    push("UPLOAD -> " + r.status + " " + txt.slice(0, 80).replace(/\s+/g, " "));
    return { ok: r.ok, status: r.status, data, txt };
  }
  async function uploadContent(jsonText, existingId, token) {
    const size = new Blob([jsonText]).size;
    let pre = {};
    try { pre = await preflight(existingId, size, token); } catch (e) { push("PREFLIGHT throw " + e); }
    if (pre.conflictId && pre.conflictId !== existingId) return uploadContent(jsonText, pre.conflictId, token);
    const targets = [];
    if (pre.upload_url) targets.push({ url: pre.upload_url, tok: "" }, { url: pre.upload_url, tok: pre.upload_token || token });
    targets.push({
      url: existingId
        ? "https://upload.app.box.com/api/2.0/files/" + encodeURIComponent(existingId) + "/content"
        : "https://upload.app.box.com/api/2.0/files/content",
      tok: token
    });
    for (const t of targets) {
      try {
        const up = await postUpload(t.url, jsonText, t.tok);
        if (up.status === 409) {
          const cid = conflictId(up.data);
          if (cid && cid !== existingId) return uploadContent(jsonText, cid, token);
        }
        const entry = up.data && ((up.data.entries && up.data.entries[0]) || up.data);
        const id = entry && entry.id ? String(entry.id) : existingId;
        if (up.ok && id) return { id, name: (entry && entry.name) || fileName };
      } catch (e) { push("UPLOAD error " + e); }
    }
    return null;
  }
  async function downloadById(fileId, token) {
    const urls = [
      "https://api.box.com/2.0/files/" + encodeURIComponent(fileId) + "/content",
      "/api/2.0/files/" + encodeURIComponent(fileId) + "/content"
    ];
    for (const url of urls) {
      try {
        const headers = { Accept: "*/*" };
        if (token) headers.Authorization = "Bearer " + token;
        const r = await fetch(url, { credentials: credFor(url), headers, redirect: "follow" });
        push("GET content -> " + r.status);
        if (!r.ok) continue;
        const txt = await r.text();
        if (txt && txt.trim().startsWith("{")) return txt;
      } catch (e) { push("GET error " + e); }
    }
    return "";
  }
  function fail(msg) {
    const tail = log.slice(-3).join(" / ");
    return { ok: false, error: tail ? msg + "（" + tail + "）" : msg, log };
  }
  async function doPublish(jsonText) {
    try {
      const token = await getScopedToken();
      if (!token) return fail("Box の書き込み用トークンを取得できませんでした");
      const existing = await findFile(token);
      const uploaded = await uploadContent(jsonText, (existing && existing.id) || "", token);
      if (!uploaded || !uploaded.id) return fail("Box への登録に失敗しました");
      const sharedLink = await ensureShare(uploaded.id, token) || (existing && existing.sharedLink) || "";
      return { ok: true, fileId: uploaded.id, name: uploaded.name, sharedLink, log };
    } catch (e) {
      return fail(String(e));
    }
  }
  async function doImport() {
    const scoped = await getScopedToken();
    const existing = await findFile(scoped);
    if (!existing || !existing.id) return fail("カタログファイルが見つかりません");
    const readTok = await getReadToken(existing.id) || scoped;
    const txt = await downloadById(existing.id, readTok);
    if (!txt) return fail("カタログをダウンロードできませんでした");
    const CHUNK = 256 * 1024;
    const total = Math.ceil(txt.length / CHUNK) || 1;
    for (let i = 0; i < total; i++) {
      window.postMessage({ source: IMP_SRC, i, total, chunk: txt.slice(i * CHUNK, (i + 1) * CHUNK) }, "*");
    }
    return { ok: true, fileId: existing.id, sharedLink: existing.sharedLink || "", bytes: txt.length, log };
  }
  if (kind === "publish") {
    if (window.__boxSlrPubHandler) window.removeEventListener("message", window.__boxSlrPubHandler);
    const chunks = {};
    async function onMsg(e) {
      const d = e.data;
      if (!d || d.source !== PUB_SRC) return;
      chunks[d.i] = d.chunk;
      if (!d.total || Object.keys(chunks).length < d.total) return;
      window.removeEventListener("message", onMsg);
      window.__boxSlrPubHandler = null;
      try {
        window.postMessage({ source: PUB_DONE, result: await doPublish(joinChunks(chunks, d.total)) }, "*");
      } catch (err) {
        window.postMessage({ source: PUB_DONE, result: { ok: false, error: String(err), log } }, "*");
      }
    }
    window.__boxSlrPubHandler = onMsg;
    window.addEventListener("message", onMsg);
    return { ready: true };
  }
  if (window.__boxSlrImpHandler) window.removeEventListener("message", window.__boxSlrImpHandler);
  async function onStart(e) {
    if (!e.data || e.data.source !== IMP_START) return;
    window.removeEventListener("message", onStart);
    window.__boxSlrImpHandler = null;
    try {
      window.postMessage({ source: IMP_DONE, result: await doImport() }, "*");
    } catch (err) {
      window.postMessage({ source: IMP_DONE, result: { ok: false, error: String(err), log } }, "*");
    }
  }
  window.__boxSlrImpHandler = onStart;
  window.addEventListener("message", onStart);
  return { ready: true };
}
