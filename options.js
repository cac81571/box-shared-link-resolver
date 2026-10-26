// 設定画面。DEFAULTS のキーと同名の入力欄を読み書きする。
import { DEFAULTS, CATALOG_FILE_NAME } from "./config.js";
import { loadCatalog, exportCatalogJson, importCatalogJson } from "./resolver.js";
const keys = Object.keys(DEFAULTS);
const settingsReady = chrome.storage.sync.get(DEFAULTS).then(c => {
  keys.forEach(k => {
    const empty = (k === "ownDomain" || k === "domainB") && !String(c[k] || "").trim();
    document.getElementById(k).value = empty ? DEFAULTS[k] : c[k];
  });
});
async function persistSettings(silent) {
  await settingsReady;
  const c = {}; keys.forEach(k => c[k] = document.getElementById(k).value);
  c.folderId = c.folderId === "" ? 0 : +c.folderId;
  if (Number.isNaN(c.folderId)) c.folderId = 0;
  c.updatedDays = +c.updatedDays || 7;
  c.searchTypes = String(c.searchTypes || "").split(/[,、]+/).map(s => s.trim()).filter(Boolean).join(",") || DEFAULTS.searchTypes;
  c.catalogDays = +c.catalogDays || 365;
  c.catalogFolderId = c.catalogFolderId === "" ? "" : +c.catalogFolderId;
  if (Number.isNaN(c.catalogFolderId)) c.catalogFolderId = "";
  const strip = s => String(s || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  c.ownDomain = strip(c.ownDomain);
  c.domainB = strip(c.domainB);
  if (!c.ownDomain) {
    document.getElementById(silent ? "catalogMsg" : "msg").textContent = "自社ドメインが未設定です";
    return false;
  }
  // *.box.com 以外は任意ホスト権限が必要
  for (const host of [c.ownDomain, c.domainB]) {
    if (host && !host.endsWith(".box.com")) {
      const ok = await chrome.permissions.request({ origins: ["https://" + host + "/*"] });
      if (!ok) { document.getElementById("msg").textContent = "権限が拒否されました"; return false; }
    }
  }
  await chrome.storage.sync.set(c);
  if (!silent) document.getElementById("msg").textContent = "保存しました";
  return true;
}
document.getElementById("save").onclick = async () => {
  if (await persistSettings()) showCatalog();
};
function pad(n) { return String(n).padStart(2, "0"); }
function fmtDateTime(ms) {
  const d = new Date(ms);
  return d.getFullYear() + "/" + pad(d.getMonth() + 1) + "/" + pad(d.getDate())
    + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}
async function saveForm() {
  return persistSettings(true);
}
function lastCatalogLine(w) {
  if (!w || !w.at) return "";
  const st = w.aborted ? "中断" : (w.skipped ? "スキップ" : (w.ok ? "成功" : "失敗"));
  const act = w.action === "import" ? "取り込み" : (w.action === "collect" ? "収集" : "登録");
  let s = "最終" + act + ": " + fmtDateTime(w.at) + "  " + st + "  " + (w.count || 0) + "件";
  if (w.fileId) s += "\nファイル ID: " + w.fileId;
  if (w.sharedLink) s += "\n共有リンク: " + w.sharedLink;
  if (w.error) s += "\n" + w.error;
  return s;
}
async function showCatalog() {
  const cfg = {};
  Object.keys(DEFAULTS).forEach(k => {
    const el = document.getElementById(k);
    if (el) cfg[k] = el.value;
  });
  const own = (cfg.ownDomain || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase() || DEFAULTS.ownDomain;
  const v = await chrome.storage.local.get(["lastCatalog", "catalogFetchedAt"]);
  const items = own ? await loadCatalog(own) : {};
  const n = Object.keys(items).length;
  const times = Object.values(items).map(it => it && it.updatedAt).filter(Boolean);
  const head = lastCatalogLine(v.lastCatalog);
  const fetched = own && (v.catalogFetchedAt || {})[own];
  const lines = [];
  if (head) { lines.push(head); lines.push(""); }
  lines.push("ファイル名: " + CATALOG_FILE_NAME);
  lines.push("取得日時: " + (fetched ? fmtDateTime(fetched) : "未取得"));
  lines.push("件数: " + n);
  if (times.length) {
    lines.push("更新日 最古: " + fmtDateTime(Math.min(...times)));
    lines.push("更新日 最新: " + fmtDateTime(Math.max(...times)));
  } else if (!n) {
    lines.push("まだありません。「収集」または「Box から取り込む」で作成されます。");
  }
  document.getElementById("catalogInfo").textContent = lines.join("\n").trim();
}
let cataloging = false;
let aborting = false;
function sendBg(msg) {
  return new Promise(resolve => {
    const once = retry => {
      chrome.runtime.sendMessage(msg, res => {
        const err = chrome.runtime.lastError;
        if (err && retry && /Receiving end does not exist/i.test(err.message)) {
          setTimeout(() => once(false), 200);
          return;
        }
        if (err) resolve({ ok: false, error: err.message });
        else resolve(res || { ok: false, error: "応答がありません。拡張を再読み込みしてください。" });
      });
    };
    once(true);
  });
}
function fmtRemain(ms) {
  if (!(ms > 0)) return "";
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return "残り約" + s + "秒";
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return "残り約" + m + "分" + (r ? r + "秒" : "");
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return "残り約" + h + "時間" + (rm ? rm + "分" : "");
}
function fmtPageProgress(p) {
  if (!p || !p.page) return "";
  let s = (p.type ? p.type + " : " : "") + p.page + "/" + (p.pageCount || "?") + " ページ";
  const r = fmtRemain(p.remainMs);
  if (r) s += "  " + r;
  return s;
}
function applyProgress(p) {
  if (!cataloging || aborting) return;
  const extra = fmtPageProgress(p);
  const prefix = document.getElementById("catalogMsg").dataset.busy || "処理中";
  document.getElementById("catalogMsg").textContent = extra ? prefix + "（" + extra + "）" : prefix;
}
async function runCatalog(type, busyText, okText) {
  const btns = ["catalogCollect", "catalogPublish", "catalogImport", "catalogClearImport"].map(id => document.getElementById(id));
  const abortBtn = document.getElementById("catalogAbort");
  const msg = document.getElementById("catalogMsg");
  btns.forEach(b => { b.disabled = true; });
  abortBtn.disabled = type !== "collectCatalog";
  cataloging = true;
  aborting = false;
  msg.dataset.busy = busyText;
  msg.textContent = busyText;
  if (!await saveForm()) {
    cataloging = false;
    btns.forEach(b => { b.disabled = false; });
    abortBtn.disabled = true;
    if (msg.textContent === busyText) msg.textContent = "設定を保存できませんでした";
    return { ok: false, error: msg.textContent };
  }
  const keep = setInterval(() => sendBg({ type: "ping" }), 20000);
  const r = await sendBg({ type });
  clearInterval(keep);
  msg.textContent = r && r.ok
    ? (r.aborted
      ? "中断しました（" + (r.count || 0) + "件）"
      : r.skipped
        ? "更新がないため取り込みをスキップしました（" + (r.count || 0) + "件）"
        : okText.replace("{n}", String(r.count || 0)) + (r.sharedLink ? "  " + r.sharedLink : ""))
    : (r && r.error) || "応答がありません。拡張を再読み込みしてください。";
  cataloging = false;
  btns.forEach(b => { b.disabled = false; });
  abortBtn.disabled = true;
  showCatalog();
  return r;
}
document.getElementById("catalogAbort").onclick = () => {
  aborting = true;
  document.getElementById("catalogAbort").disabled = true;
  document.getElementById("catalogMsg").textContent = "中断しています";
  sendBg({ type: "abortCollect" });
};
document.getElementById("catalogCollect").onclick = () =>
  runCatalog("collectCatalog", "収集しています", "収集しました（{n}件）");
document.getElementById("catalogPublish").onclick = () =>
  runCatalog("uploadCatalog", "Box に登録しています", "登録しました（{n}件）");
document.getElementById("catalogImport").onclick = () =>
  runCatalog("importCatalog", "Box から取り込んでいます", "取り込みました（{n}件）");
document.getElementById("catalogSaveJson").onclick = async () => {
  const json = await exportCatalogJson();
  const blob = new Blob([json], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = CATALOG_FILE_NAME;
  a.click();
  URL.revokeObjectURL(a.href);
  document.getElementById("catalogMsg").textContent = "JSON を保存しました";
};
document.getElementById("catalogClearImport").onclick = async () => {
  if (!confirm("取り込み済みのカタログと取得日時を削除します。よろしいですか？")) return;
  await chrome.storage.local.remove(["sharedCatalog", "todayCatalogOn", "catalogFetchedAt", "catalogFileModifiedAt", "lastCatalog"]);
  document.getElementById("catalogMsg").textContent = "取り込み情報を消しました";
  await showCatalog();
};
document.getElementById("catalogLoadJson").onclick = () => document.getElementById("catalogFile").click();
document.getElementById("catalogFile").onchange = async () => {
  const f = document.getElementById("catalogFile").files[0];
  document.getElementById("catalogFile").value = "";
  if (!f) return;
  try {
    const r = await importCatalogJson(await f.text());
    document.getElementById("catalogMsg").textContent = r.ok
      ? "JSON を読み込みました（" + r.count + "件）"
      : (r.error || "読み込めませんでした");
  } catch (e) {
    document.getElementById("catalogMsg").textContent = String(e);
  }
  showCatalog();
};
chrome.storage.onChanged.addListener((c, area) => {
  if (c.progress && cataloging) applyProgress(c.progress.newValue);
  if (area === "local" && (c.sharedCatalog || c.lastCatalog || c.catalogFetchedAt)) showCatalog();
});
showCatalog();
document.getElementById("schedUrl").textContent = chrome.runtime.getURL("options.html") + "?job=collect-publish";
if (new URLSearchParams(location.search).get("job") === "collect-publish") {
  settingsReady.then(() =>
    runCatalog("collectCatalog", "自動実行: 収集しています", "収集しました（{n}件）").then(r => {
      if (r && r.ok && !r.aborted) return runCatalog("uploadCatalog", "自動実行: Box に登録しています", "登録しました（{n}件）");
    })
  );
}
