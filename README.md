# 圃場データ収集アプリ 仕様書

**アプリ名**: Paddy Field Data Collector
**構成ファイル**: `index.html`（フロントエンド） / `GAS_code.gs`（バックエンド） / `KSAS_field.json`（圃場マスタ）
**最終更新**: 2026年9月

---

## 1. 概要

圃場（田んぼ）を巡回しながら、稲の生育状況を **写真4点＋位置情報＋圃場ID** としてスマートフォンから記録し、Google Drive（画像）と Google スプレッドシート（記録一覧）へ自動保存するWebアプリケーションΩです。iOS / Android の両方に対応しています。

### システム構成

```
[スマホ・ブラウザ]                [Google 側]
 index.html  ──POST(JSON)──▶  GAS Web App (doPost)
   │                              ├─ 画像 → Google Drive
   ├─ KSAS_field.json 読込        └─ 記録 → スプレッドシート
   └─ 端末GPS / 地図表示
```

---

## 2. 画面構成と入力項目

### 2.1 ヘッダー
- タイトル表示と、右上に「🔑 設定変更」リンク（ユーザー名・送信キーの変更）。
- 直下に「記録者: ○○」を常時表示し、誰として記録されるかを明示。

### 2.2 位置情報・地図エリア
- **地図（Leaflet + OpenStreetMap）** を表示（高さ **380px** の大きめ表示）。
- 圃場マスタ（`KSAS_field.json`）の座標入り圃場を **丸ピン** でプロット。
- ピン下に **品種→色の凡例** を自動生成。
- 現在の緯度・経度を数値表示し、座標ソース（端末GPS / 地図選択）を併記。
- 「現在地取得」ボタンで端末GPSを再取得。

### 2.3 圃場ID入力
- テキスト入力欄。**地図上のピンをタップすると圃場名が自動入力** される。

### 2.4 画像撮影エリア（4点）
| No | 項目 | inputのID | GAS/JSONキー |
|----|------|-----------|--------------|
| 1 | 穂先 | `imgEar` | `imgEar` |
| 2 | 根本 | `imgRoot` | `imgRoot` |
| 3 | 高さ | `imgHeight` | `imgHeight` |
| 4 | 圃場全景 | `imgView` | `imgView` |

- 各項目にネイティブの「ファイルを選択」ではなく **「📷 撮影」ボタン** を表示。
- 撮影後はファイル名を「✓ ファイル名」、未撮影は「未撮影」と表示。

### 2.5 送信
- 「Commit」ボタンで送信。送信中は「画像圧縮・送信中...」を表示。

---

## 3. 機能仕様

### 3.1 ユーザー名・送信キー（利用者情報）
- 初回送信時に **入力モーダル** を表示し、「ユーザー名」と「送信キー（SECRET_KEY）」を入力させる。
- 入力値は `localStorage` に保存され、**2回目以降は入力不要**。
  - 送信キー: `fieldCollector_secretKey`
  - ユーザー名: `fieldCollector_userName`
- モーダル内でキー入力を保存すると、中断していた送信処理を自動で再開。
- 送信キーはパスワード形式（伏字）で入力。「キーを表示する」で平文表示に切替可能。
- ヘッダー「🔑 設定変更」からいつでも更新可能。

### 3.2 位置情報（GPS）取得と許可フロー
- ページ読み込み時に **Permissions API** で許可状態を確認。
  - `denied`（拒否済み）: 警告表示に加え **許可案内モーダルを起動**。
  - `granted` / `prompt`: 位置情報の取得を実行。
  - Permissions API 非対応端末（一部iOS Safari）: 直接 `getCurrentPosition` にフォールバック。
- 許可状態の変化（`onchange`）を検知して自動で再取得を試みる。
- 許可されていない場合、`PERMISSION_DENIED` を検知して **必ずモーダルを起動**（Android / iOS 両対応）。
- モーダルは端末を自動判定し、該当OS（iOS / Android）の手順を「この端末」バッジ付きで強調表示。「再試行」ボタンを備える。

### 3.3 カメラ直接起動（iOS / Android 両対応）
- 各 file input に `accept="image/*;capture=camera"` と `capture="environment"` を併用。
- これにより Android 14以降のChromeで写真選択（Photo Picker）が開いてしまう問題を回避し、**両OSでタップ時にカメラを直接起動**。

### 3.4 地図・圃場ピン表示
- 同フォルダの `KSAS_field.json` を `fetch` で読み込み。
- `latitude` / `longitude` が入っている圃場のみを丸ピンで表示。
- 読み込み失敗時は凡例欄にエラー案内を表示。

### 3.5 ピンのタップ → 圃場ID自動入力
- ピンをタップ、またはポップアップ内「この圃場を選択」ボタンで、その圃場の **`圃場名` を圃場IDへ自動入力**。
- ピンのタップは圃場名の選択のみで、**送信用の座標は変更しない**。

### 3.6 品種によるピンの色分け
- `作付計画_品種` カラムの値ごとに色を自動割り当て。
- 品種が未設定（`null`/空）の圃場は「未設定」としてまとめて色分け。
- 地図下に「品種 → 色」の凡例を自動生成。

### 3.7 座標の優先順位（重要）
スプレッドシートへ書き込む緯度経度は以下の優先順で決定：

1. **端末GPSで取得した座標（最優先）** … `deviceLat` / `deviceLng`
2. 地図クリック/ドラッグで選んだ座標（GPS未取得時のフォールバック） … `selectedLat` / `selectedLng`

- ピンのタップは座標に影響しない。
- 送信ペイロードに `coordSource`（`device-gps` / `map-select`）を付与し、由来を判別可能。

### 3.8 画像圧縮
- 送信前に Canvas で **長辺1280px・JPEG品質75%** に圧縮。
- 透過PNG対策として背景を白で塗りつぶし。
- 4枚を `Promise.all` で並列圧縮し送信時間を短縮。

---

## 4. データ送受信

### 4.1 送信ペイロード（フロント → GAS）
`POST`（`mode: "no-cors"`, `Content-Type: application/json`）で以下を送信：

```json
{
  "secretKey": "送信キー",
  "userName": "記録者名",
  "fieldId": "圃場ID（圃場名）",
  "lat": "34.898154",
  "lng": "135.060832",
  "coordSource": "device-gps",
  "imgEar": "data:image/jpeg;base64,...",
  "imgRoot": "data:image/jpeg;base64,...",
  "imgHeight": "data:image/jpeg;base64,...",
  "imgView": "data:image/jpeg;base64,..."
}
```

### 4.2 GAS（バックエンド）処理
1. `secretKey` を検証（不一致ならエラー）。
2. `fieldId` / `lat` / `lng` / `userName` の必須チェック。
3. 4枚の画像を Base64 デコードし Google Drive へ保存（ファイル名: `圃場ID_カテゴリ.jpg`）。
4. スプレッドシートへ1行追記。

### 4.3 スプレッドシート列構成
| 列 | A | B | C | D | E | F | G | H | I |
|----|---|---|---|---|---|---|---|---|---|
| 内容 | 日時 | ユーザー名 | 圃場ID | 緯度 | 経度 | 稲穂URL | 根本URL | 高さURL | 圃場前景URL |

---

## 5. 設定項目

### 5.1 フロント（index.html の `CONFIG`）
| キー | 内容 |
|------|------|
| `GAS_WEB_APP_URL` | GAS Web App のデプロイURL |
| `FIELD_JSON_URL` | 圃場マスタのパス（既定: `KSAS_field.json`） |
| `SECRET_KEY_STORAGE_NAME` | 送信キーの localStorage キー名 |
| `USER_NAME_STORAGE_NAME` | ユーザー名の localStorage キー名 |
| `DEFAULT_LAT` / `DEFAULT_LNG` | 地図の初期中心（既定: 兵庫県加東市付近） |
| `IMAGE_MAX_SIDE` | 圧縮後の長辺px（既定: 1280） |
| `IMAGE_QUALITY` | JPEG品質（既定: 0.75） |

### 5.2 バックエンド（GAS_code.gs）
| 定数 | 内容 |
|------|------|
| `FOLDER_ID` | 画像保存先のDriveフォルダID |
| `SECRET_KEY` | 送信キー（フロントと一致必須） |
| `SPREADSHEET_ID` | 記録先スプレッドシートID |

---

## 6. デプロイ・運用上の注意

- **`KSAS_field.json` は必ず `index.html` と同じ階層に配置**（相対パスで読み込むため）。
- `file://` で直接開くと `fetch` がブロックされる場合があるため、**Webサーバー経由で公開**して動作確認する。
- GAS はフロントの送信キーと一致させ、Web アプリとしてデプロイ（アクセス: 全員 / 実行: 自分）。
- `mode: "no-cors"` のため、フロントは GAS のレスポンス（成功/失敗）を読み取れない。保存失敗も画面上は成功表示になる点に留意。
- スプレッドシートに過去データがある場合、現在の列構成（B列=ユーザー名、H列=高さURL）と列がずれるため、新シートの利用または列整理を推奨。

---

## 7. 対応環境

| 項目 | 対応 |
|------|------|
| OS | iOS（Safari） / Android（Chrome） |
| 地図 | Leaflet 1.9.4 + OpenStreetMap |
| カメラ | 撮影ボタンからカメラ直接起動 |
| 位置情報 | 端末GPS優先、許可モーダルで案内 |
| オフライン | 非対応（送信・地図・マスタ読込にネット接続が必要） |
