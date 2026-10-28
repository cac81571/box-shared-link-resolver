// ポップアップ UI。共有リンク入力 → background の resolve → 結果表示。
import { getConfig } from "./config.js";
import { hasTodayCatalog } from "./resolver.js";
const $ = id => document.getElementById(id);
const SAMPLE_ID = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
// 表示中タブのアドレスバーが https://コラボ先ドメイン/s/ のときだけ初期表示する
async function tabSharedLink(host) {
  if (!host) return "";
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const t = ((tabs[0] && tabs[0].url) || "").trim();
  const prefix = "https://" + host + "/s/";
  return t.startsWith(prefix) ? t.split("#")[0] : "";
}
function pad(n) { return String(n).padStart(2, "0"); }
function fmtDateTime(ms) {
  const d = new Date(ms);
  return d.getFullYear() + "/" + pad(d.getMonth() + 1) + "/" + pad(d.getDate())
    + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}
async function showFetchedAt() {
  const cfg = await getConfig();
  const v = await chrome.storage.local.get("catalogFetchedAt");
  const at = cfg.ownDomain && (v.catalogFetchedAt || {})[cfg.ownDomain];
  $("fetchedAt").textContent = at ? "カタログ取得 " + fmtDateTime(at) : "カタログ未取得";
}
getConfig().then(async c => {
  const own = c.ownDomain;
  const host = c.domainB;
  $("l").placeholder = "https://" + (host || "(コラボ先ドメイン)") + "/s/" + SAMPLE_ID;
  if (!own || !host) {
    $("go").disabled = true;
    $("msg").className = "hint";
    $("msg").textContent = "はじめに「設定」リンクをクリックして「自社ドメイン」と「コラボ先ドメイン」を登録してください";
  }
  const el = $("l");
  const link = await tabSharedLink(host);
  if (link) {
    el.value = link;
    el.focus();
    el.select();
  } else {
    el.focus();
  }
});
showFetchedAt();
let busy = false; // 検索終了後に遅延してきた progress で表示を上書きしない
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
function setBusy(p) {
  if (!busy) return;
  $("msg").className = "busy";
  if (p && p.phase === "import") {
    $("msg").textContent = "カタログ取得中";
    return;
  }
  if (p && p.phase === "recent") {
    let s = "更新日が過去" + (p.days || "?") + "日の項目を検索しています";
    if (p.page) {
      s += "（" + (p.type ? p.type + " : " : "") + p.page + "/" + (p.pageCount || "?") + " ページ";
      const r = fmtRemain(p.remainMs);
      if (r) s += "  " + r;
      s += "）";
    }
    $("msg").textContent = s;
    return;
  }
  $("msg").textContent = "共有カタログを検索しています";
}
chrome.storage.onChanged.addListener(c => {
  if (c.progress) setBusy(c.progress.newValue);
  if (c.catalogFetchedAt) showFetchedAt();
});
$("close").onclick = e => { e.preventDefault(); window.close(); };
$("l").addEventListener("keydown", e => {
  if (e.key === "Enter") {
    e.preventDefault();
    $("go").click();
  }
});
$("go").onclick = async () => {
  busy = true;
  const cfg = await getConfig();
  const needImport = cfg.ownDomain && !await hasTodayCatalog(cfg.ownDomain);
  setBusy({ phase: needImport ? "import" : "catalog" });
  const r = await new Promise(resolve => {
    chrome.runtime.sendMessage({ type: "resolve", link: $("l").value }, res => {
      const err = chrome.runtime.lastError;
      if (err) resolve({ ok: false, error: err.message });
      else resolve(res || { ok: false });
    });
  });
  busy = false;
  showFetchedAt();
  if (r.ok) {
    $("msg").className = "ok";
    const kind = r.type === "file" ? "ファイル" : "フォルダ";
    $("msg").textContent = r.name
      ? "見つかりました。" + kind + "「" + r.name + "」を開きます。"
      : "見つかりました。" + kind + "を開きます。";
    setTimeout(() => window.close(), 3000);
    return;
  }
  if (r.needLogin) {
    $("msg").className = "hint";
    $("msg").textContent = "Box にログインしてください";
    return;
  }
  $("msg").className = "";
  $("msg").textContent = r.notFound
    ? "見つかりませんでした。設定の「更新日：過去〇日」を広げてみてください。"
    : (r.error || "見つかりませんでした");
};
