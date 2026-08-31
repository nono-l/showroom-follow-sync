/*
  同期と巡回の本体。engine-1.js のあとに読むこと。
  フェーズは sync → view → wait。offscreen が pulse を打ち、ここが次の睡眠ミリ秒を返す。
*/
async function ensureCsrfOnce() {
  // ブラウザ起動単位で1回。token 自体は認証ヘッダにまだ使わず、ログイン確認の印にする。
  const { csrfToken } = await chrome.storage.session.get({ csrfToken: "" });
  if (csrfToken) return { ok: true, token: csrfToken };
  try {
    const r = await pageFetch(CSRF_TOKEN);
    const token = r && r.data && r.data.csrf_token;
    if (r && r.ok && typeof token === "string" && token) {
      await chrome.storage.session.set({ csrfToken: token });
      return { ok: true, token };
    }
    return { ok: false, note: r && r.status ? " HTTP" + r.status : "" };
  } catch (e) {
    return { ok: false, note: " " + String(e && e.message ? e.message : e) };
  }
}

async function syncRooms() {
  // 配信一覧を取り、開く・閉じる・無視リスト・専用窓への移動までを1周でやる。
  const s = await loadSettings();
  const state = await loadState();
  const stamp = new Date().toLocaleTimeString("ja-JP");
  const minCycleMs = Math.max(1000, Number(s.minCycleSec) * 1000 || 30000);
  const viewMs = Math.max(500, Number(s.viewSec) * 1000 || 2000);
  if (!s.enabled) {
    await setStatus(stamp + " 停止中");
    return { liveTabs: [], cycleMs: 2000, viewMs, rotateEnabled: false };
  }
  const login = await ensureCsrfOnce();
  if (!login.ok) {
    await setStatus(stamp + " 未ログイン" + (login.note || "") + "（SHOWROOMのタブでログインした状態にしてください）");
    return { liveTabs: [], cycleMs: minCycleMs, viewMs, rotateEnabled: false };
  }
  const params = new URLSearchParams();
  if (s.genreId !== "" && s.genreId != null) params.set("genre_id", String(s.genreId));
  const apiUrl = params.toString() ? API + "?" + params.toString() : API + "?genre_id";
  let data;
  try {
    const r = await pageFetch(apiUrl);
    if (!r || !r.ok) throw new Error("HTTP " + ((r && r.status) || "?"));
    data = r.data;
  } catch (e) {
    await setStatus(stamp + " 取得失敗 " + e.message);
    return { liveTabs: [], cycleMs: minCycleMs, viewMs, rotateEnabled: false };
  }
  const lives = collectRooms(data);
  const liveKeys = new Set(lives.map((r) => r.key));
  const cap = Math.max(1, Number(s.maxOpen) || 20);
  state.ignoreList = state.ignoreList.filter((x) => liveKeys.has(typeof x === "string" ? x : x.key));
  Object.keys(state.watchMs).forEach((k) => { if (!liveKeys.has(k)) delete state.watchMs[k]; });
  const dupClosed = await closeDuplicateRoomTabs();
  const tabs = await chrome.tabs.query({ url: ["https://www.showroom-live.com/*", "https://*.showroom-live.com/*"] });
  const openKeys = new Map();
  for (const tab of tabs) {
    const key = parseRoomKey(tab.url || "");
    if (key) openKeys.set(key, tab);
  }
  let opened = 0;
  let closed = dupClosed;
  let ignoredIn = 0;
  let ignoredOut = 0;
  if (s.closeEnabled) {
    for (const [key, tab] of openKeys) {
      if (!liveKeys.has(key) && tab.id != null) {
        try { await chrome.tabs.remove(tab.id); closed += 1; openKeys.delete(key); } catch (_) {}
      }
    }
  }
  const liveCount = lives.length;
  if (liveCount < state.prevLiveCount || openKeys.size < cap) {
    const n = Math.max(1, Number(s.unignorePerCycle) || 1);
    const canTake = Math.max(0, cap - openKeys.size);
    if (liveCount < state.prevLiveCount || canTake > 0) {
      const drop = Math.min(n, state.ignoreList.length, Math.max(canTake, liveCount < state.prevLiveCount ? n : canTake));
      if (drop > 0) { state.ignoreList.splice(0, drop); ignoredOut += drop; }
    }
  }
  let blocked = ignoreSet(state.ignoreList);
  if (s.openEnabled) {
    const waiting = lives.filter((r) => !openKeys.has(r.key) && !blocked.has(r.key));
    if (openKeys.size >= cap && waiting.length) {
      const occupying = [...openKeys.keys()].map((key) => ({ key, watch: Number(state.watchMs[key]) || 0 })).sort((a, b) => b.watch - a.watch);
      for (const row of occupying) {
        if (blocked.has(row.key)) continue;
        addIgnore(state.ignoreList, row.key, state.watchMs[row.key]);
        blocked.add(row.key);
        ignoredIn += 1;
        const tab = openKeys.get(row.key);
        if (tab && tab.id != null) {
          try { await chrome.tabs.remove(tab.id); closed += 1; openKeys.delete(row.key); } catch (_) {}
        }
        machine.openQueue = machine.openQueue.filter((k) => k !== row.key);
        machine.opening.delete(row.key);
        if (openKeys.size < cap) break;
      }
    }
    blocked = ignoreSet(state.ignoreList);
    pruneQueue(liveKeys, blocked);
    const used = () => openKeys.size + machine.openQueue.length + machine.opening.size;
    for (const room of lives) {
      if (openKeys.has(room.key) || blocked.has(room.key) || queueHas(room.key)) continue;
      if (used() >= cap) { addIgnore(state.ignoreList, room.key, state.watchMs[room.key]); ignoredIn += 1; continue; }
      if (enqueueOpen(room.key)) {
        opened += 1;
        if (state.watchMs[room.key] == null) state.watchMs[room.key] = 0;
      }
    }
  }
  blocked = ignoreSet(state.ignoreList);
  pruneQueue(liveKeys, blocked);
  for (const [key, tab] of [...openKeys]) {
    if (blocked.has(key) && tab.id != null) {
      try { await chrome.tabs.remove(tab.id); closed += 1; openKeys.delete(key); } catch (_) {}
    }
  }
  const moved = await gatherRoomTabsToWindow();
  const liveTabs = [];
  for (const room of lives) {
    if (blocked.has(room.key)) continue;
    const tab = openKeys.get(room.key);
    if (tab && tab.id != null) liveTabs.push({ id: tab.id, key: room.key });
  }
  const rotateMs = liveTabs.length * viewMs;
  const cycleMs = Math.max(minCycleMs, rotateMs);
  state.prevLiveCount = liveCount;
  await saveState(state);
  await setStatus(stamp + " 配信" + liveCount + " / キュー" + opened + "残" + machine.openQueue.length + " / 閉じる" + closed + " / 移動" + moved + " / 無視+" + ignoredIn + " / 無視戻し" + ignoredOut + " / 無視中" + state.ignoreList.length + " / 次取得 " + Math.round(cycleMs / 1000) + "秒");
  return { liveTabs, cycleMs, viewMs, rotateEnabled: s.rotateEnabled !== false && liveTabs.length > 0 };
}

function nextSleep(ms) {
  if (!machine.openQueue.length) return { sleepMs: ms };
  const untilOpen = Math.max(50, OPEN_GAP_MS - (Date.now() - (machine.lastOpenAt || 0)));
  return { sleepMs: Math.min(ms, untilOpen) };
}

async function pulse() {
  await ensureOffscreen();
  const s = await loadSettings();
  if (!s.enabled) {
    machine.phase = "sync";
    machine.openQueue = [];
    machine.opening.clear();
    await setStatus(new Date().toLocaleTimeString("ja-JP") + " 停止中");
    return nextSleep(2000);
  }
  if (machine.openQueue.length) await drainOpenQueue();
  if (machine.phase === "sync") {
    const r = await syncRooms();
    machine.liveTabs = r.liveTabs || [];
    machine.viewMs = r.viewMs;
    machine.cycleEnd = Date.now() + r.cycleMs;
    machine.viewIndex = 0;
    machine.phase = r.rotateEnabled ? "view" : "wait";
    if (machine.phase === "wait") return nextSleep(Math.max(200, machine.cycleEnd - Date.now()));
    return nextSleep(50);
  }
  if (machine.phase === "view") {
    await closeDuplicateRoomTabs();
    const tab = machine.liveTabs[machine.viewIndex];
    if (!tab) {
      machine.phase = "wait";
      return nextSleep(Math.max(200, machine.cycleEnd - Date.now()));
    }
    try { await chrome.tabs.update(tab.id, { active: true }); } catch (_) {}
    if (tab.key) {
      const state = await loadState();
      state.watchMs[tab.key] = (Number(state.watchMs[tab.key]) || 0) + machine.viewMs;
      await saveState(state);
    }
    machine.viewIndex += 1;
    if (machine.viewIndex >= machine.liveTabs.length) machine.phase = "wait";
    return nextSleep(machine.viewMs);
  }
  const left = machine.cycleEnd - Date.now();
  if (left <= 0) {
    machine.phase = "sync";
    return nextSleep(50);
  }
  return nextSleep(Math.min(left, 5000));
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({
    lastStatus: "v" + appVersion() + " 拡張を読み込みました。まだこのバージョンでは同期していません"
  });
  await ensureOffscreen();
});
chrome.runtime.onStartup.addListener(ensureOffscreen);
chrome.runtime.onMessage.addListener((msg, _s, send) => {
  if (!msg || !msg.type) return;
  if (msg.type === "ensure-offscreen") {
    ensureOffscreen().then(() => send({ ok: true })).catch((e) => send({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "run-now") {
    machine.phase = "sync";
    pulse().then(send).catch((e) => send({ sleepMs: 1000, error: String(e) }));
    return true;
  }
  if (msg.type === "pulse") {
    pulse().then(send).catch((e) => send({ sleepMs: 1000, error: String(e) }));
    return true;
  }
});
if (chrome.windows && chrome.windows.onRemoved) {
  chrome.windows.onRemoved.addListener(async (id) => {
    const stored = await getStoredWindowId();
    if (stored === id) await setStoredWindowId(0);
  });
}
ensureOffscreen();
