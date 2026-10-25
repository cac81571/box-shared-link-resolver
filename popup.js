const $ = id => document.getElementById(id);
chrome.storage.local.get("lastLog").then(v => { if (v.lastLog) $("log").textContent = "[前回]\n" + v.lastLog; });
$("go").onclick = async () => {
  $("log").textContent = "処理中...";
  const r = await chrome.runtime.sendMessage({ type: "resolve", link: $("l").value });
  $("log").textContent = (r.ok ? "OK " + r.url : "NG") + "\n" + r.log.join("\n");
  chrome.storage.local.set({ lastLog: r.log.join("\n") });
};
