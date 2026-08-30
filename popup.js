/*
  ポップアップ。設定を chrome.storage.local に書き、状態文 lastStatus を表示する。
*/
const KEYS = ["enabled", "openEnabled", "closeEnabled", "rotateEnabled", "viewSec", "minCycleSec", "maxOpen", "genreId"];

function currentVersion() {
  return chrome.runtime.getManifest().version;
}

async function load() {
  document.getElementById("version").textContent = "v" + currentVersion();
  const s = await chrome.storage.local.get({
    enabled: true,
    openEnabled: true,
    closeEnabled: true,
    rotateEnabled: true,
    viewSec: 2,
    minCycleSec: 30,
    maxOpen: 20,
    genreId: "",
    lastStatus: "まだ実行していません"
  });
  KEYS.forEach((k) => {
    const el = document.getElementById(k);
    if (!el) return;
    if (el.type === "checkbox") el.checked = !!s[k];
    else el.value = s[k];
  });
  const ver = currentVersion();
  const raw = s.lastStatus || "";
  if (!raw.startsWith("v" + ver + " ")) {
    document.getElementById("status").textContent = "v" + ver + " このバージョンではまだ同期していません";
  } else {
    document.getElementById("status").textContent = raw;
  }
}

async function save() {
  const data = {};
  KEYS.forEach((k) => {
    const el = document.getElementById(k);
    data[k] = el.type === "checkbox" ? el.checked : el.value;
  });
  data.viewSec = Math.max(1, Number(data.viewSec) || 2);
  data.minCycleSec = Math.max(5, Number(data.minCycleSec) || 30);
  data.maxOpen = Math.max(1, Number(data.maxOpen) || 20);
  await chrome.storage.local.set(data);
  await chrome.runtime.sendMessage({ type: "ensure-offscreen" });
}

document.addEventListener("DOMContentLoaded", async () => {
  await load();
  await chrome.runtime.sendMessage({ type: "ensure-offscreen" });
  KEYS.forEach((k) => {
    document.getElementById(k).addEventListener("change", save);
  });
  document.getElementById("run").addEventListener("click", async () => {
    await save();
    document.getElementById("status").textContent = "実行中…";
    await chrome.runtime.sendMessage({ type: "run-now" });
    await load();
  });
});

chrome.storage.onChanged.addListener((ch) => {
  if (ch.lastStatus) {
    document.getElementById("status").textContent = ch.lastStatus.newValue || "";
  }
});
