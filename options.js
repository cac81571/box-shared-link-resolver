import { DEFAULTS } from "./config.js";
const keys = Object.keys(DEFAULTS);
chrome.storage.sync.get(DEFAULTS).then(c => keys.forEach(k => document.getElementById(k).value = c[k]));
document.getElementById("save").onclick = async () => {
  const c = {}; keys.forEach(k => c[k] = document.getElementById(k).value);
  c.folderId = c.folderId === "" ? 0 : +c.folderId;
  if (Number.isNaN(c.folderId)) c.folderId = 0;
  c.updatedDays = +c.updatedDays || 7;
  c.domainB = c.domainB.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (c.domainB && !c.domainB.endsWith(".box.com")) {
    const ok = await chrome.permissions.request({ origins: ["https://" + c.domainB + "/*"] });
    if (!ok) { document.getElementById("msg").textContent = "権限が拒否されました"; return; }
  }
  await chrome.storage.sync.set(c);
  document.getElementById("msg").textContent = "保存しました";
};
