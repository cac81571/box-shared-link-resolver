const $ = id => document.getElementById(id);
const SAMPLE_ID = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
function configuredHost(domainB) {
  return String(domainB || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}
function readClipboardText() {
  const ta = document.createElement("textarea");
  ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0";
  document.body.appendChild(ta);
  ta.focus();
  document.execCommand("paste");
  const v = ta.value;
  ta.remove();
  return v;
}
function clipboardSharedLink(host) {
  if (!host) return "";
  const t = readClipboardText().trim();
  const prefix = "https://" + host + "/s/";
  return t.startsWith(prefix) ? t : "";
}
chrome.storage.sync.get({ domainB: "" }).then(c => {
  const host = configuredHost(c.domainB);
  $("l").placeholder = "https://" + (host || "(コラボレーション先のドメイン)") + "/s/" + SAMPLE_ID;
  if (!host) {
    $("go").disabled = true;
    $("msg").className = "hint";
    $("msg").textContent = "はじめに「設定」リンクをクリックして「コラボレーション先のドメイン」を登録してください";
  }
  const el = $("l");
  const link = clipboardSharedLink(host);
  if (link) {
    el.value = link;
    el.focus();
    el.select();
  } else {
    el.focus();
  }
});
let busy = false;
function setBusy(pct) {
  if (!busy) return;
  $("msg").className = "busy";
  $("msg").textContent = "検索中(" + pct + "%) ...";
}
chrome.runtime.onMessage.addListener(m => {
  if (m.type === "progress") setBusy(m.pct);
});
$("close").onclick = e => { e.preventDefault(); window.close(); };
$("go").onclick = async () => {
  busy = true;
  setBusy(0);
  const r = await chrome.runtime.sendMessage({ type: "resolve", link: $("l").value });
  busy = false;
  $("log").textContent = (r.log || []).join("\n");
  if (r.ok) {
    $("msg").className = "ok";
    const kind = r.type === "file" ? "ファイル" : "フォルダ";
    $("msg").textContent = r.name
      ? "見つかりました。" + kind + "「" + r.name + "」を開きます。"
      : "見つかりました。" + kind + "を開きます。";
    setTimeout(() => window.close(), 3000);
    return;
  }
  $("msg").className = "";
  $("msg").textContent = "見つかりませんでした";
};
