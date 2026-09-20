# 圃場写真ビューワー (KSAS Field Photo Viewer)

GitHub Pages で公開する、圃場写真を確認するための静的サイトです。
`/img/` に写真を追加していくだけで、**メニューバーから2つの見方**で写真を閲覧できます。

## 画面構成

| メニュー | 内容 |
|---|---|
| 🗺️ **地図から見る** | 地図上の📷ピンをタップ → その圃場の写真一式(サムネイル)を表示 → タップで拡大 |
| 🏷️ **撮影種別から見る** | 撮影種別(ドロップダウン)を選択 → 全圃場の該当写真を一覧表示 → タップで地図上の位置にジャンプ |

## 1. 構成

```
リポジトリのルート (GitHub Pages公開フォルダ)
├── index.html
├── KSAS_field_all.json      ← 圃場データ(緯度経度・圃場名など)
├── css/style.css
├── js/app.js                 ← 設定・ロジックはすべてここ
└── img/
    ├── 20260920_082945_Hosokawa_３０２_FieldHigh.jpg
    ├── 20260920_083000_Hosokawa_３０２_FieldWide.jpg
    └── ...(写真を追加していくだけでOK)
```

`index.html`・`KSAS_field_all.json`・`img/` は**同じ階層**に置いてください。

## 2. 写真のファイル名ルール

```
日付_時間_撮影者_圃場ID_撮影種別.拡張子
例) 20260920_082945_Hosokawa_３０２_FieldHigh.jpg
```

- 圃場ID は `KSAS_field_all.json` の `圃場名` と対応(全角/半角の違いは自動吸収)
- 撮影種別 は自由な文字列(例: FieldHigh, FieldWide, Disease, Soil など)。
  ここに入力した値がそのまま「撮影種別から見る」のドロップダウンに反映されます。
- 対応拡張子: `.jpg` `.jpeg` `.png` `.gif` `.webp`
- 命名規則に合わない、または `圃場名` と一致しないファイルは自動的にスキップされます
  (右上のステータス表示で件数を確認できます)。

## 3. 画像一覧の取得方法(自動・サーバー不要)

1. **`img/manifest.json`** があれば最優先で使用(任意)
2. ブラウザのセッションキャッシュ(10分以内なら再利用)
3. **GitHub API** (`git/trees` recursive) で `img/` 配下を自動取得

通常は 3. の自動取得のみで動作します(リポジトリが Public であれば認証不要)。
画像枚数が非常に多い、または API のレート制限(未認証: 60回/時/IP)が気になる場合は、
`img/manifest.example.json` を参考に `img/manifest.json` を用意してください。

## 4. 設定 (js/app.js 冒頭の `CONFIG`)

GitHubのユーザー名・リポジトリ名はURLから自動判定されます。判定できない場合のみ
`js/app.js` 冒頭を書き換えてください。

```js
const CONFIG = {
  owner: null,   // 例: "hosokawa" (nullなら自動判定)
  repo: null,    // 例: "field-photos" (nullなら自動判定)
  branches: ["main", "master", "gh-pages"],
  imgDir: "img",
  jsonPath: "./KSAS_field_all.json",
  manifestPath: "./img/manifest.json",
  cacheMinutes: 10,
};
```

## 5. GitHub Pages への公開手順

1. このフォルダの中身をリポジトリ直下にコミット・push
2. `img/` に写真を命名規則に沿って追加
3. GitHub リポジトリの Settings → Pages で公開ブランチを設定
4. 公開URL (`https://<ユーザー名>.github.io/<リポジトリ名>/`) にアクセス

## 6. 既知の制約

- 圃場名が重複している場合、同名のすべての圃場に同じ写真が紐付きます
  (提供データでは正規化後 318件すべて一意であることを確認済みです)。
- GitHub API は未認証時 60回/時/IP の制限があります。通常はキャッシュ(10分)で
  問題ありませんが、頻繁に確認する場合は `manifest.json` の利用を推奨します。
