/*
  部品ファイル。同期ループ自体は engine-2.js。
  ここにあるもの: 定数、巡回マシンのメモリ、専用ウィンドウ、タブ判定、Cookie 付き通信。
*/
const OFFSCREEN = "offscreen.html";
const API = "https://www.showroom-live.com/api/follow/onlives";
const CSRF_TOKEN = "https://www.showroom-live.com/api/csrf_token";
const ROOM_BASE = "https://www.showroom-live.com/";
// パス先頭がこれに当たる URL は配信ルームではない。専用ウィンドウへ移さない。
const RESERVED = new Set(["", "r", "api", "onlive", "onlives", "follow", "event", "user", "room", "login", "signup", "search", "timetable", "time_table", "campaign", "inquiry", "help", "official", "payment", "gift", "ranking", "news", "s", "settings", "setting", "mypage", "notification", "notifications"]);
const DEFAULTS = { enabled: true, openEnabled: true, closeEnabled: true, rotateEnabled: true, dedicatedWindow: true, viewSec: 2, minCycleSec: 30, maxOpen: 20, genreId: "", unignorePerCycle: 1 };
// Service Worker 再起動で消える。永続したい値は chrome.storage.local。
let machine = { phase: "sync", liveTabs: [], viewIndex: 0, viewMs: 2000, cycleEnd: 0, openQueue: [], opening: new Set(), lastOpenAt: 0, lastWindowError: "", lastOpenError: "" };
const OPEN_GAP_MS = 400;

// windowId はブラウザ再起動で無効になるので session に置く。local に残す意味はない。
async function getStoredWindowId() {
  const { showroomWindowId } = await chrome.storage.session.get({ showroomWindowId: 0 });
  return Number(showroomWindowId) || 0;
}
async function setStoredWindowId(id) {
  await chrome.storage.session.set({ showroomWindowId: Number(id) || 0 });
}
async function windowStillThere(id) {
  if (!id) return null;
  try { return await chrome.windows.get(id); } catch (_) { return null; }
}
async function ensureShowroomWindow() {
  // 作業ウィンドウのアクティブタブを巡回で奪わないための専用窓。
  // 「ルームタブが多い窓」を推測して再利用しない。作業窓を誤認するため。
  const s = await loadSettings();
  if (s.dedicatedWindow === false) {
    machine.lastWindowError = "専用ウィンドウがオフ";
    return null;
  }
  const stored = await getStoredWindowId();
  const existing = await windowStillThere(stored);
  if (existing && existing.id != null) {
    machine.lastWindowError = "";
    return existing;
  }
  // about:blank だと SW からの windows.create が即閉じることがある。トップを種にする。
  // 初回だけ前面へ出す。見えない位置に作ると「窓が開かない」になる。
  try {
    const created = await chrome.windows.create({ focused: true, type: "normal", url: ROOM_BASE });
    if (!created || created.id == null) {
      machine.lastWindowError = "windows.create が空を返した";
      return null;
    }
    await setStoredWindowId(created.id);
    machine.lastWindowError = "";
    return created;
  } catch (e) {
    machine.lastWindowError = String(e && e.message ? e.message : e);
    return null;
  }
}
function tabHref(tab) {
  // 読み込み中は url が空で pendingUrl に行き先だけ入ることがある。
  return (tab && (tab.pendingUrl || tab.url)) || "";
}
function tabRoomKey(tab) {
  return parseRoomKey(tabHref(tab));
}
function isTabLoading(tab) {
  if (!tab) return false;
  if (tab.status === "loading") return true;
  const url = tab.url || "";
  if ((!url || url === "about:blank" || url === "chrome://newtab/") && tab.pendingUrl) return true;
  return false;
}
function isSeedTab(tab) {
  // 読み込み中は url が空でも種ではない。消すと「開いた直後に落ちる」。
  if (isTabLoading(tab)) return false;
  if (tabRoomKey(tab)) return false;
  const u = tabHref(tab);
  if (!u || u === "about:blank" || u === "chrome://newtab/") return true;
  try {
    const x = new URL(u);
    if (!x.hostname.endsWith("showroom-live.com")) return false;
    return !x.pathname.split("/").filter(Boolean).length;
  } catch (_) {
    return false;
  }
}
async function pruneBlankTabs(windowId) {
  // windows.create はタブ無しにできない。種として置いたトップ/blank を、実タブが入ってから捨てる。
  // 最後の1枚が種なら消さない。窓自体が閉じる。ログイン用の予約パスは消さない。
  if (!windowId) return;
  try {
    const tabs = await chrome.tabs.query({ windowId });
    const readyRooms = tabs.filter((t) => tabRoomKey(t) && !isTabLoading(t));
    if (!readyRooms.length) return;
    const seeds = tabs.filter(isSeedTab);
    if (!seeds.length || seeds.length >= tabs.length) return;
    for (const tab of seeds) {
      if (tab.id == null) continue;
      if (isTabLoading(tab)) continue;
      try { await chrome.tabs.remove(tab.id); } catch (_) {}
    }
  } catch (_) {}
}
async function moveTabToWindow(tabId, windowId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId === windowId) return tab;
    return await chrome.tabs.move(tabId, { windowId, index: -1 });
  } catch (_) {
    return null;
  }
}
async function gatherRoomTabsToWindow() {
  // 予約パスのタブは通信・ログイン用に残す。ルームキーがあるタブだけ移す。
  const win = await ensureShowroomWindow();
  if (!win || win.id == null) return 0;
  const tabs = await chrome.tabs.query({ url: ["https://www.showroom-live.com/*", "https://*.showroom-live.com/*"] });
  let moved = 0;
  for (const tab of tabs) {
    if (tab.id == null) continue;
    if (!tabRoomKey(tab)) continue;
    if (tab.windowId === win.id) continue;
    if (await moveTabToWindow(tab.id, win.id)) moved += 1;
  }
  await pruneBlankTabs(win.id);
  return moved;
}

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
  // Cookie 付き fetch 用。専用窓の配信タブより、作業窓側の非ルームタブを先に使う。
  const dedicatedId = await getStoredWindowId();
  const tabs = await chrome.tabs.query({ url: ["https://www.showroom-live.com/*"] });
  const ranked = [];
  for (const t of tabs) {
    if (t.id == null) continue;
    const room = parseRoomKey(t.url || "");
    const inDedicated = dedicatedId && t.windowId === dedicatedId;
    ranked.push({ t, score: (room ? 2 : 0) + (inDedicated ? 1 : 0) });
  }
  ranked.sort((a, b) => a.score - b.score);
  for (const row of ranked) {
    try { return await chrome.tabs.get(row.t.id); } catch (_) {}
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
async function listShowroomTabs() {
  // url フィルタは読み込み中（url 未設定）を落とす。専用窓は窓IDでも拾う。
  const byId = new Map();
  const add = (t) => { if (t && t.id != null) byId.set(t.id, t); };
  const patterned = await chrome.tabs.query({ url: ["https://www.showroom-live.com/*", "https://*.showroom-live.com/*"] });
  patterned.forEach(add);
  const winId = await getStoredWindowId();
  if (winId) {
    try { (await chrome.tabs.query({ windowId: winId })).forEach(add); } catch (_) {}
  }
  return [...byId.values()];
}
async function currentOpenKeys() {
  const map = new Map();
  for (const tab of await listShowroomTabs()) {
    const key = tabRoomKey(tab);
    if (key) map.set(key, tab);
  }
  return map;
}
async function closeDuplicateRoomTabs() {
  const byKey = new Map();
  let closed = 0;
  for (const tab of await listShowroomTabs()) {
    const key = tabRoomKey(tab);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, [tab]);
    else byKey.get(key).push(tab);
  }
  for (const [, group] of byKey) {
    if (group.length < 2) continue;
    const keep = group.find((t) => t.status === "complete" && t.active)
      || group.find((t) => t.status === "complete")
      || group.find((t) => t.active)
      || group[0];
    for (const tab of group) {
      if (tab.id == null || tab.id === keep.id) continue;
      if (isTabLoading(tab)) continue;
      try { await chrome.tabs.remove(tab.id); closed += 1; } catch (_) {}
    }
  }
  return closed;
}
async function createRoomTab(key) {
  const opts = { url: ROOM_BASE + key, active: false };
  const win = await ensureShowroomWindow();
  if (win && win.id != null) opts.windowId = win.id;
  try {
    const tab = await chrome.tabs.create(opts);
    machine.lastOpenError = "";
    return tab;
  } catch (e) {
    machine.lastOpenError = String(e && e.message ? e.message : e);
    if (!opts.windowId) return null;
    // 指定窓が死んでいると tabs.create は落ちる。作業窓側に退避する。
    delete opts.windowId;
    try {
      const tab = await chrome.tabs.create(opts);
      machine.lastOpenError = "専用窓に置けず作業窓へ開いた";
      return tab;
    } catch (e2) {
      machine.lastOpenError = String(e2 && e2.message ? e2.message : e2);
      return null;
    }
  }
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
  await createRoomTab(key);
  machine.opening.delete(key);
  return !!machine.openQueue.length;
}
async function drainOpenQueueBurst(budgetMs) {
  // 予約だけ残して次の pulse に任せるると、offscreen が止まっているとき窓もタブもゼロのままになる。
  const end = Date.now() + Math.max(0, Number(budgetMs) || 0);
  while (machine.openQueue.length && Date.now() <= end) {
    const before = machine.openQueue.length;
    await drainOpenQueue();
    if (machine.openQueue.length >= before) {
      const wait = machine.lastOpenAt ? OPEN_GAP_MS - (Date.now() - machine.lastOpenAt) : 0;
      if (wait > 0 && Date.now() + wait <= end) {
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      break;
    }
    if (machine.openQueue.length) {
      const left = end - Date.now();
      if (left < OPEN_GAP_MS) break;
      await new Promise((r) => setTimeout(r, OPEN_GAP_MS));
    }
  }
}
