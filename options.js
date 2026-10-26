// 設定画面。DEFAULTS のキーと同名の入力欄を読み書きする。
import { DEFAULTS } from "./config.js";
const keys = Object.keys(DEFAULTS);
chrome.storage.sync.get(DEFAULTS).then(c => keys.forEach(k => {
  const empty = (k === "ownDomain" || k === "domainB") && !String(c[k] || "").trim();
  document.getElementById(k).value = empty ? DEFAULTS[k] : c[k];
}));
document.getElementById("save").onclick = async () => {
  const c = {}; keys.forEach(k => c[k] = document.getElementById(k).value);
  c.folderId = c.folderId === "" ? 0 : +c.folderId;
  if (Number.isNaN(c.folderId)) c.folderId = 0;
  c.updatedDays = +c.updatedDays || 7;
  const strip = s => String(s || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  c.ownDomain = strip(c.ownDomain);
  c.domainB = strip(c.domainB);
  // *.box.com 以外は任意ホスト権限が必要
  for (const host of [c.ownDomain, c.domainB]) {
    if (host && !host.endsWith(".box.com")) {
      const ok = await chrome.permissions.request({ origins: ["https://" + host + "/*"] });
      if (!ok) { document.getElementById("msg").textContent = "権限が拒否されました"; return; }
    }
  }
  await chrome.storage.sync.set(c);
  document.getElementById("msg").textContent = "保存しました";
  showCache();
};
function pad(n) { return String(n).padStart(2, "0"); }
function fmtDateTime(ms) {
  const d = new Date(ms);
  return d.getFullYear() + "/" + pad(d.getMonth() + 1) + "/" + pad(d.getDate())
    + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}
function fmtDay(ms) {
  const d = new Date(ms);
  return d.getFullYear() + "/" + pad(d.getMonth() + 1) + "/" + pad(d.getDate());
}
function lastWarmLine(w) {
  if (!w || !w.at) return "";
  const st = w.ok ? "成功" : "失敗";
  const dated = w.dated != null ? "  更新日あり " + w.dated + "件" : "";
  let s = "最終作成: " + fmtDateTime(w.at) + "  " + st + "  " + (w.count || 0) + "件" + dated;
  if (w.error) s += "\n" + w.error;
  return s;
}
async function showCache() {
  const v = await chrome.storage.local.get(["sharedIdHits", "lastWarm"]);
  const all = v.sharedIdHits || {};
  const domains = Object.keys(all);
  const head = lastWarmLine(v.lastWarm);
  if (!domains.length) {
    document.getElementById("cacheInfo").textContent = (head ? head + "\n\n" : "") + "まだありません。「開く」または「キャッシュ作成」で作成されます。";
    return;
  }
  const lines = [];
  if (head) { lines.push(head); lines.push(""); }
  for (const domain of domains) {
    const hits = all[domain] || {};
    const times = Object.values(hits).map(it => it && it.updatedAt).filter(Boolean);
    const n = Object.keys(hits).length;
    const noDate = n - times.length;
    lines.push(domain);
    lines.push("件数: " + n);
    if (times.length) {
      const min = Math.min(...times);
      const max = Math.max(...times);
      lines.push("更新日 最古: " + fmtDateTime(min));
      lines.push("更新日 最新: " + fmtDateTime(max));
      const byDay = {};
      for (const t of times) {
        const day = fmtDay(t);
        byDay[day] = (byDay[day] || 0) + 1;
      }
      lines.push("更新日別:");
      for (const day of Object.keys(byDay).sort()) lines.push("  " + day + "  " + byDay[day] + "件");
      if (noDate) lines.push("更新日なし: " + noDate + "件");
    } else if (n) {
      lines.push("更新日: まだありません。自社Boxを開き直すと記録されます。");
    } else {
      lines.push("中身は空です");
    }
    lines.push("");
  }
  document.getElementById("cacheInfo").textContent = lines.join("\n").trim();
}
let building = false;
chrome.runtime.onMessage.addListener(m => {
  if (m.type === "progress" && building) {
    document.getElementById("cacheMsg").textContent = "キャッシュを作成しています（" + m.pct + "%）";
  }
});
document.getElementById("cacheBuild").onclick = async () => {
  const btn = document.getElementById("cacheBuild");
  const cacheMsg = document.getElementById("cacheMsg");
  btn.disabled = true;
  building = true;
  cacheMsg.textContent = "キャッシュを作成しています（0%）";
  try {
    const r = await chrome.runtime.sendMessage({ type: "warmCache" });
    cacheMsg.textContent = r && r.ok
      ? "キャッシュを作成しました（" + (r.count || 0) + "件）"
      : (r && r.error) || "応答がありません。拡張を再読み込みしてください。";
  } catch (e) {
    cacheMsg.textContent = String(e);
  }
  building = false;
  btn.disabled = false;
  showCache();
};
document.getElementById("cacheClear").onclick = async () => {
  if (!confirm("共有リンクキャッシュをすべて削除します。よろしいですか？")) return;
  await chrome.storage.local.remove(["sharedIdHits", "searchCache", "lastWarm", "todayCacheOn"]);
  document.getElementById("cacheClearMsg").textContent = "キャッシュを消しました";
  document.getElementById("cacheMsg").textContent = "";
  showCache();
};
chrome.storage.onChanged.addListener((c, area) => {
  if (area === "local" && (c.sharedIdHits || c.lastWarm)) showCache();
});
showCache();
