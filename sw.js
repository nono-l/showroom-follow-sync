/*
  Service Worker の入口だけ。
  Manifest V3 の background.service_worker は 1 ファイル指定なので、
  本体を engine-1 / engine-2 に分け、ここで両方を読み込む。
  順番固定: engine-2 は engine-1 の関数・定数を前提にする。
*/
importScripts("engine-1.js", "engine-2.js");
