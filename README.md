# SHOWROOM フォローオンライブ同期

人間と、あとから入った AI の両方が読める説明。

## この拡張がやること（だけ）

1. ログイン中に `https://www.showroom-live.com/api/follow/onlives?genre_id` を取る
2. 配信中なのにタブが無い部屋を開く
3. タブはあるが配信が終わった部屋を閉じる
4. 開いている配信タブを、公平に N 秒ずつ前面へ出す
5. 次の取得タイミングは `max(開いている配信タブ数 × N秒, 下限秒)` のあと
6. 同時オープン上限に達したら、視聴時間が長い部屋を「今は開かないリスト」へ移してタブを閉じる
7. 同時配信数が減ったら、無視リストから 1 件ずつ戻す

csrf_token はブラウザ起動ごとに1回。消えていたら取り、あれば使う（chrome.storage.session）。

旧「人間をやめるぜ」拡張の移植ではない。ギフト・通知・jQuery は扱わない。

## ファイル分担

- `sw.js` … 本体
- `offscreen.html` / `offscreen.js` … 秒単位タイマーだけ
- `content.js` … SHOWROOM タブ上で Cookie 付き fetch
- `popup.html` / `popup.js` … 設定と状態表示
- `manifest.json` … Manifest V3
