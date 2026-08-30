const OFFSCREEN = "offscreen.html";
const API = "https://www.showroom-live.com/api/follow/onlives";
const CSRF_TOKEN = "https://www.showroom-live.com/api/csrf_token";
const ROOM_BASE = "https://www.showroom-live.com/";
const RESERVED = new Set(["", "r", "api", "onlive", "onlives", "follow", "event", "user", "room", "login", "signup", "search", "timetable", "time_table", "campaign", "inquiry", "help", "official", "payment", "gift", "ranking", "news", "s", "settings", "setting", "mypage", "notification", "notifications"]);
const DEFAULTS = { enabled: true, openEnabled: true, closeEnabled: true, rotateEnabled: true, viewSec: 2, minCycleSec: 30, maxOpen: 20, genreId: "", unignorePerCycle: 1 };
let machine = { phase: "sync", liveTabs: [], viewIndex: 0, viewMs: 2000, cycleEnd: 0, openQueue: [], opening: new Set(), lastOpenAt: 0 };
const OPEN_GAP_MS = 400;

async function hasOffscreen() {
  if (!chrome.runtime.getContexts) return false;
  const ctx = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [chrome.runtime.getURL(OFFSCREEN)] });
  return ctx.length > 0;
}
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  try {
    await chrome.offscreen.createDocument({ url: OFFSCREEN, reasons: ["DOM_SCRAPING"], justification: "2秒間隔のタブ巡回タイマーを維持する" });
  } catch (e) {
    const m = String(e && e.message ? e.message : e);
    if (!/already exists|Only a single/i.test(m)) console.warn(m);
  }
}
function parseRoomKey(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("showroom-live.com")) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (!parts.length) return null;
    if (parts[0] === "r" && parts[1]) return parts[1];
    if (RESERVED.has(parts[0])) return null;
    return parts[0];
  } catch { return null; }
}
function collectRooms(data) {
  const list = []; const seen = new Set();
  const push = (item) => {
    if (!item || typeof item !== "object") return;
    const key = item.room_url_key || item.room_url || item.url_key;
    if (!key || seen.has(key)) return;
    seen.add(key);
    list.push({ key: String(key), name: item.main_name || item.room_name || item.name || String(key) });
  };
  if (Array.isArray(data)) data.forEach(push);
  if (Array.isArray(data.rooms)) data.rooms.forEach(push);
  if (Array.isArray(data.onlives)) data.onlives.forEach((g) => { if (Array.isArray(g.lives)) g.lives.forEach(push); else push(g); });
  if (Array.isArray(data.lives)) data.lives.forEach(push);
  return list;
}
function looksLoggedIn(d) {
  if (!d || typeof d !== "object") return false;
  const t = d.csrf_token;
  return typeof t === "string" && t.length > 0;
}
async function waitTabComplete(tabId, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try { const t = await chrome.tabs.get(tabId); if (t.status === "complete") return true; } catch (_) { return false; }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
function isMissingTabError(e) {
  const m = String(e && e.message ? e.message : e);
  return /No tab with id/i.test(m) || /Invalid tab ID/i.test(m) || /Receiving end does not exist/i.test(m);
}
async function showroomTab() {
  const tabs = await chrome.tabs.query({ url: ["https://www.showroom-live.com/*"] });
  for (const t of tabs) {
    if (t.id == null) continue;
    try { return await chrome.tabs.get(t.id); } catch (_) {}
  }
  return chrome.tabs.create({ url: ROOM_BASE, active: false });
}
async function sendPageFetch(tabId, url) {
  return chrome.tabs.sendMessage(tabId, { type: "page-fetch", url });
}
async function pageFetch(url) {
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      const tab = await showroomTab();
      if (!tab || tab.id == null) throw new Error("SHOWROOMタブを開けない");
      const ready = await waitTabComplete(tab.id, 8000);
      if (!ready) throw new Error("タブの読み込み待ちに失敗");
      try { return await sendPageFetch(tab.id, url); }
      catch (e) {
        lastErr = e;
        try {
          await chrome.tabs.reload(tab.id);
          await waitTabComplete(tab.id, 8000);
          return await sendPageFetch(tab.id, url);
        } catch (e2) { lastErr = e2; }
      }
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    const data = await fetchJson(url);
    return { ok: true, status: 200, data, via: "worker" };
  } catch (e) {
    if (isMissingTabError(lastErr)) throw new Error("通信用タブが閉じられたので次の周でやり直します");
    throw new Error(String(lastErr && lastErr.message ? lastErr.message : lastErr || e));
  }
}
async function fetchJson(url) {
  const res = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}
async function loadSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
}
async function loadState() {
  const s = await chrome.storage.local.get({ watchMs: {}, ignoreList: [], prevLiveCount: 0 });
  return { watchMs: s.watchMs && typeof s.watchMs === "object" ? s.watchMs : {}, ignoreList: Array.isArray(s.ignoreList) ? s.ignoreList : [], prevLiveCount: Number(s.prevLiveCount) || 0 };
}
async function saveState(state) {
  await chrome.storage.local.set({ watchMs: state.watchMs, ignoreList: state.ignoreList, prevLiveCount: state.prevLiveCount, lastIgnoreCount: state.ignoreList.length });
}
function appVersion() {
  try { return chrome.runtime.getManifest().version; } catch (_) { return "?"; }
}
async function setStatus(text) {
  await chrome.storage.local.set({ lastStatus: "v" + appVersion() + " " + text });
}
function ignoreSet(list) {
  return new Set(list.map((x) => (typeof x === "string" ? x : x.key)));
}
function addIgnore(list, key, watchMs) {
  if (list.some((x) => (typeof x === "string" ? x : x.key) === key)) return list;
  list.push({ key, addedAt: Date.now(), watchMs: watchMs || 0 });
  return list;
}
function queueHas(key) {
  return machine.openQueue.indexOf(key) >= 0 || machine.opening.has(key);
}
function enqueueOpen(key) {
  if (!key || queueHas(key)) return false;
  machine.openQueue.push(key);
  return true;
}
function pruneQueue(liveKeys, blocked) {
  machine.openQueue = machine.openQueue.filter((key) => liveKeys.has(key) && !blocked.has(key));
  for (const key of [...machine.opening]) {
    if (!liveKeys.has(key) || blocked.has(key)) machine.opening.delete(key);
  }
}
async function currentOpenKeys() {
  const tabs = await chrome.tabs.query({ url: ["https://www.showroom-live.com/*", "https://*.showroom-live.com/*"] });
  const map = new Map();
  for (const tab of tabs) {
    const key = parseRoomKey(tab.url || "");
    if (key) map.set(key, tab);
  }
  return map;
}
async function closeDuplicateRoomTabs() {
  const tabs = await chrome.tabs.query({ url: ["https://www.showroom-live.com/*", "https://*.showroom-live.com/*"] });
  const byKey = new Map();
  let closed = 0;
  for (const tab of tabs) {
    const key = parseRoomKey(tab.url || "");
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, [tab]);
    else byKey.get(key).push(tab);
  }
  for (const [, group] of byKey) {
    if (group.length < 2) continue;
    const keep = group.find((t) => t.active) || group[0];
    for (const tab of group) {
      if (tab.id == null || tab.id === keep.id) continue;
      try { await chrome.tabs.remove(tab.id); closed += 1; } catch (_) {}
    }
  }
  return closed;
}
async function drainOpenQueue() {
  if (!machine.openQueue.length) return false;
  const now = Date.now();
  if (machine.lastOpenAt && now - machine.lastOpenAt < OPEN_GAP_MS) return true;
  const key = machine.openQueue.shift();
  if (!key) return false;
  const openKeys = await currentOpenKeys();
  if (openKeys.has(key)) { machine.opening.delete(key); return !!machine.openQueue.length; }
  machine.opening.add(key);
  machine.lastOpenAt = now;
  try { await chrome.tabs.create({ url: ROOM_BASE + key, active: false }); } catch (_) {}
  machine.opening.delete(key);
  return !!machine.openQueue.length;
}
