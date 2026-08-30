/*
  SHOWROOM のページ上で動く。ログインCookieが付くのはここ。
  Service Worker からの fetch は別オリジン扱いになり、Cookie が付かないことがある。
*/
function pageFetch(url) {
  return fetch(url, { credentials: "include", cache: "no-store" }).then(async (res) => {
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) { data = text; }
    return { ok: res.ok, status: res.status, data };
  });
}

function looksLoggedIn(d) {
  if (!d || typeof d !== "object") return false;
  const t = d.csrf_token;
  return typeof t === "string" && t.length > 0;
}

chrome.runtime.onMessage.addListener((msg, _s, send) => {
  if (!msg || !msg.type) return;
  if (msg.type === "page-fetch") {
    pageFetch(msg.url).then(send).catch((e) => send({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "check-login") {
    pageFetch("https://www.showroom-live.com/api/csrf_token")
      .then((r) => send({ ok: r.ok && looksLoggedIn(r.data), data: r.data, status: r.status }))
      .catch((e) => send({ ok: false, error: String(e) }));
    return true;
  }
});
