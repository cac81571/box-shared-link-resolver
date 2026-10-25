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
};
