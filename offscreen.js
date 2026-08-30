/*
  役割: 秒単位の目覚まし時計。
  やらないこと: API取得、タブ操作、設定の読み書き。
  理由: この Chrome では offscreen から chrome.storage が見えず落ちた。
        本体は sw.js。ここは「pulse を打って指定ミリ秒寝る」だけ。
*/
let abortWait = null;

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    abortWait = () => {
      clearTimeout(t);
      resolve();
    };
  });
}

async function loop() {
  while (true) {
    let wait = 2000;
    try {
      const res = await chrome.runtime.sendMessage({ type: "pulse" });
      if (res && Number(res.sleepMs) > 0) wait = Number(res.sleepMs);
    } catch (_) {
      wait = 1000;
    }
    await sleep(wait);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "run-now" && abortWait) abortWait();
});

loop();
