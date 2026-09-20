/* =========================================================================
 * 圃場写真ビューワー (KSAS Field Photo Viewer)
 * -------------------------------------------------------------------------
 * ・同じ階層の KSAS_field_all.json から圃場(緯度経度)一覧を読み込みます
 * ・/img/ フォルダの画像一覧は GitHub API から自動取得します
 *   (画像ファイル名: 日付_時間_撮影者_圃場ID_撮影種別.拡張子 の命名規則を前提)
 * ・写真が実際に存在する圃場だけを地図上のピンとして表示します
 * ========================================================================= */

"use strict";

/* -------------------------------------------------------------------------
 * 0. 設定 (必要に応じてここだけ書き換えてください)
 * ---------------------------------------------------------------------- */
const CONFIG = {
  // GitHub のユーザー名 / リポジトリ名。null の場合は URL から自動判定します。
  owner: null,
  repo: null,
  // 画像一覧取得を試みるブランチの候補(先頭から順に試行)
  branches: ["main", "master", "gh-pages"],
  // 画像が入っているフォルダ名 (このHTMLから見た相対パスにもなります)
  imgDir: "img",
  // 圃場データJSONのパス (同じ階層に配置)
  jsonPath: "./KSAS_field_all.json",
  // 任意: img配下に手動 or CI生成の manifest.json を置くと、
  // GitHub APIより優先してこちらを使用します(件数が非常に多い場合や
  // API制限を避けたい場合に有効)。中身は文字列配列 ["a.jpg","b.jpg",...]
  // か {"files":[...]} の形式。存在しなければ自動的に無視されます。
  manifestPath: "./img/manifest.json",
  // 画像一覧のキャッシュ保持時間(分) - 再取得の頻度を下げAPI制限を回避
  cacheMinutes: 10,
  // 対応する画像拡張子
  imageExtRegex: /\.(jpe?g|png|gif|webp)$/i,
};

/* -------------------------------------------------------------------------
 * 1. 文字列正規化 (全角/半角 揺れ吸収)
 * ---------------------------------------------------------------------- */
function toHalfWidth(str) {
  return str
    .replace(/[\uFF01-\uFF5E]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
    )
    .replace(/\u3000/g, " ");
}

function normalizeId(str) {
  if (!str) return "";
  return toHalfWidth(String(str)).trim().replace(/\s+/g, "").toLowerCase();
}

/* -------------------------------------------------------------------------
 * 2. GitHub リポジトリ情報の自動判定
 * ---------------------------------------------------------------------- */
function detectRepoInfo() {
  const host = location.hostname; // 例: yourname.github.io
  const owner = CONFIG.owner || host.split(".")[0];
  const segments = location.pathname.split("/").filter(Boolean);
  let repo = CONFIG.repo;
  if (!repo) {
    // プロジェクトページ (https://owner.github.io/reponame/...) の場合は
    // 最初のパスセグメントがリポジトリ名。
    // ユーザー/組織ページ (owner.github.io がルートで公開) の場合は
    // リポジトリ名は "owner.github.io" になる。
    repo = segments.length > 0 ? segments[0] : `${owner}.github.io`;
  }
  return { owner, repo };
}

/* -------------------------------------------------------------------------
 * 3. 画像ファイル名の解析
 *    例: 20260920_082945_Hosokawa_３０２_FieldHigh.jpg
 *        -> date=20260920, time=082945, photographer=Hosokawa,
 *           fieldId=３０２, shotType=FieldHigh
 * ---------------------------------------------------------------------- */
function parseImageFilename(filename) {
  const dot = filename.lastIndexOf(".");
  const base = dot >= 0 ? filename.slice(0, dot) : filename;
  const parts = base.split("_");
  if (parts.length < 5) return null; // 命名規則に合わないファイルは無視

  const [date, time, photographer, fieldId, ...rest] = parts;
  if (!/^\d{8}$/.test(date) || !/^\d{6}$/.test(time)) return null;

  return {
    filename,
    date, // YYYYMMDD
    time, // HHMMSS
    photographer,
    fieldId,
    fieldIdNorm: normalizeId(fieldId),
    shotType: rest.join("_"),
    url: `./${CONFIG.imgDir}/${filename}`,
    // ソート・表示用
    dateTimeLabel: formatDateTime(date, time),
    sortKey: `${date}${time}`,
  };
}

function formatDateTime(date, time) {
  if (!date || !time) return "";
  const y = date.slice(0, 4),
    m = date.slice(4, 6),
    d = date.slice(6, 8);
  const hh = time.slice(0, 2),
    mm = time.slice(2, 4);
  return `${y}/${m}/${d} ${hh}:${mm}`;
}

/* -------------------------------------------------------------------------
 * 4. 画像一覧の取得 (manifest.json 優先 → キャッシュ → GitHub API)
 * ---------------------------------------------------------------------- */
async function loadImageFilenames() {
  // 4-1. manifest.json があれば最優先で使う
  try {
    const res = await fetch(CONFIG.manifestPath, { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      const files = Array.isArray(data) ? data : data.files;
      if (Array.isArray(files)) {
        setStatus(`manifest.json から画像一覧を取得しました (${files.length}件)`);
        return files;
      }
    }
  } catch (e) {
    /* manifest が無ければ無視して次へ */
  }

  // 4-2. セッションキャッシュ確認
  const cacheKey = "ksas_img_list_cache_v1";
  try {
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      const { timestamp, files } = JSON.parse(cached);
      if (Date.now() - timestamp < CONFIG.cacheMinutes * 60 * 1000) {
        setStatus(`画像一覧をキャッシュから取得しました (${files.length}件)`);
        return files;
      }
    }
  } catch (e) {
    /* ignore */
  }

  // 4-3. GitHub API (Git Trees, recursive) から取得
  const { owner, repo } = detectRepoInfo();
  let lastErr = null;
  for (const branch of CONFIG.branches) {
    try {
      setStatus(`GitHub (${owner}/${repo} @ ${branch}) から画像一覧を取得中…`);
      const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
      const res = await fetch(url, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!res.ok) {
        lastErr = new Error(
          `GitHub API エラー (${res.status}) : ${owner}/${repo}@${branch}`
        );
        continue;
      }
      const data = await res.json();
      if (data.truncated) {
        console.warn(
          "GitHub tree の結果が truncated (省略) されています。画像数が非常に多い場合はmanifest.jsonの利用を検討してください。"
        );
      }
      const prefix = CONFIG.imgDir.replace(/\/+$/, "") + "/";
      const files = (data.tree || [])
        .filter(
          (item) =>
            item.type === "blob" &&
            item.path.startsWith(prefix) &&
            CONFIG.imageExtRegex.test(item.path)
        )
        .map((item) => item.path.slice(prefix.length));

      if (files.length > 0) {
        sessionStorage.setItem(
          cacheKey,
          JSON.stringify({ timestamp: Date.now(), files })
        );
        setStatus(`GitHub API から画像一覧を取得しました (${files.length}件 / branch: ${branch})`);
        return files;
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw (
    lastErr ||
    new Error("画像一覧を取得できませんでした (img フォルダが空か、設定が誤っている可能性があります)")
  );
}

/* -------------------------------------------------------------------------
 * 5. 圃場JSON読み込み + インデックス作成
 * ---------------------------------------------------------------------- */
async function loadFieldData() {
  const res = await fetch(CONFIG.jsonPath, { cache: "no-store" });
  if (!res.ok) throw new Error(`圃場データの取得に失敗しました: ${CONFIG.jsonPath}`);
  const list = await res.json();
  return list.filter(
    (f) => typeof f.latitude === "number" && typeof f.longitude === "number"
  );
}

/* -------------------------------------------------------------------------
 * 6. メイン処理
 * ---------------------------------------------------------------------- */
const state = {
  map: null,
  cluster: null,
  fields: [], // 元データ
  fieldsByNormName: new Map(), // normalizeId(圃場名) -> [field, ...]
  photosByFieldRecord: new Map(), // field(オブジェクト参照) -> [photo, ...]
  fieldsWithPhotos: [], // {field, photos, marker}
  markerByFieldNo: new Map(),
};

function setStatus(text) {
  const el = document.getElementById("status-text");
  if (el) el.textContent = text;
}

function showError(message) {
  const el = document.getElementById("error-banner");
  el.textContent = "⚠ " + message;
  el.classList.remove("hidden");
  console.error(message);
}

function hideError() {
  document.getElementById("error-banner").classList.add("hidden");
}

async function loadDataAndRender() {
  let fields, filenames;
  try {
    [fields, filenames] = await Promise.all([
      loadFieldData(),
      loadImageFilenames(),
    ]);
  } catch (e) {
    showError(e.message || String(e));
    setStatus("読み込みに失敗しました");
    return;
  }

  state.fields = fields;

  // 圃場名 -> フィールド配列 のインデックス作成 (全角/半角揺れ対応)
  fields.forEach((f) => {
    const key = normalizeId(f["圃場名"]);
    if (!key) return;
    if (!state.fieldsByNormName.has(key)) state.fieldsByNormName.set(key, []);
    state.fieldsByNormName.get(key).push(f);
  });

  // 画像ファイル名を解析し、圃場に紐付け
  let unmatchedCount = 0;
  let invalidCount = 0;
  filenames.forEach((filename) => {
    const photo = parseImageFilename(filename);
    if (!photo) {
      invalidCount++;
      return;
    }
    const matches = state.fieldsByNormName.get(photo.fieldIdNorm);
    if (!matches || matches.length === 0) {
      unmatchedCount++;
      return;
    }
    matches.forEach((field) => {
      if (!state.photosByFieldRecord.has(field)) {
        state.photosByFieldRecord.set(field, []);
      }
      state.photosByFieldRecord.get(field).push(photo);
    });
  });

  // 写真が1枚以上ある圃場だけを抽出
  state.fieldsWithPhotos = [];
  state.photosByFieldRecord.forEach((photos, field) => {
    photos.sort((a, b) => (a.sortKey < b.sortKey ? 1 : -1)); // 新しい順
    state.fieldsWithPhotos.push({ field, photos });
  });
  state.fieldsWithPhotos.sort((a, b) =>
    String(a.field["圃場名"]).localeCompare(String(b.field["圃場名"]), "ja")
  );

  renderMarkers(state.fieldsWithPhotos);
  renderSidebarList(state.fieldsWithPhotos);
  renderSummary(filenames.length, invalidCount, unmatchedCount);

  hideError();
  setStatus(
    `${state.fieldsWithPhotos.length} 圃場 / ${filenames.length -
      invalidCount} 枚の写真を表示中`
  );
}

/* -------------------------------------------------------------------------
 * 7. 地図の初期化
 * ---------------------------------------------------------------------- */
function initMap() {
  const map = L.map("map", { zoomControl: true }).setView(
    [34.898, 135.058],
    15
  );

  const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 20,
  }).addTo(map);

  const sat = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      attribution: "Tiles &copy; Esri",
      maxZoom: 20,
    }
  );

  L.control
    .layers(
      { "地図": osm, "衛星写真": sat },
      {},
      { position: "topright" }
    )
    .addTo(map);

  state.cluster = L.markerClusterGroup({ maxClusterRadius: 45 });
  map.addLayer(state.cluster);
  state.map = map;
}

function photoIcon() {
  return L.divIcon({
    className: "marker-photo-icon-wrap",
    html: '<div class="marker-photo-icon"><span>📷</span></div>',
    iconSize: [30, 30],
    iconAnchor: [15, 28],
    popupAnchor: [0, -26],
  });
}

/* -------------------------------------------------------------------------
 * 8. マーカー描画
 * ---------------------------------------------------------------------- */
function renderMarkers(entries) {
  state.cluster.clearLayers();
  state.markerByFieldNo.clear();

  entries.forEach(({ field, photos }) => {
    const marker = L.marker([field.latitude, field.longitude], {
      icon: photoIcon(),
    });

    const latest = photos[0];
    const addr = field["住所"] ? `${field["住所"]} / ` : "";
    const popupHtml = `
      <div class="popup-title">🌾 ${escapeHtml(field["圃場名"])}</div>
      <div>${addr}${escapeHtml(field["圃場カテゴリ"] || "")}</div>
      <div>${escapeHtml(field["作付計画_品種"] || "")}${
      field["担当者"] ? " / 担当: " + escapeHtml(field["担当者"]) : ""
    }</div>
      <img class="popup-thumb" src="${latest.url}" loading="lazy" alt="${escapeHtml(
      field["圃場名"]
    )}" />
      <div>📷 ${photos.length}枚 (最新: ${latest.dateTimeLabel})</div>
      <button class="popup-open-btn" data-field-no="${field.No}">すべての写真を見る</button>
    `;
    marker.bindPopup(popupHtml, { maxWidth: 260 });

    state.cluster.addLayer(marker);
    state.markerByFieldNo.set(field.No, marker);
  });
}

function escapeHtml(str) {
  return String(str ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c])
  );
}

/* -------------------------------------------------------------------------
 * 9. サイドバー一覧
 * ---------------------------------------------------------------------- */
function renderSidebarList(entries) {
  const ul = document.getElementById("field-list");
  ul.innerHTML = "";
  entries.forEach(({ field, photos }) => {
    const li = document.createElement("li");
    li.dataset.fieldNo = field.No;
    li.innerHTML = `
      <div><span class="fname">${escapeHtml(field["圃場名"])}</span><span class="fcount">${
      photos.length
    }枚</span></div>
      <div class="fmeta">${escapeHtml(field["住所"] || field["圃場カテゴリ"] || "")}${
      field["担当者"] ? " ・ " + escapeHtml(field["担当者"]) : ""
    }</div>
    `;
    li.addEventListener("click", () => {
      state.map.setView([field.latitude, field.longitude], 18, {
        animate: true,
      });
      const marker = state.markerByFieldNo.get(field.No);
      if (marker) {
        // クラスタ内でも確実に開けるようにズーム後に開く
        setTimeout(() => {
          if (state.cluster.hasLayer(marker)) {
            state.cluster.zoomToShowLayer(marker, () => marker.openPopup());
          }
        }, 150);
      }
    });
    ul.appendChild(li);
  });
}

function renderSummary(totalFiles, invalidCount, unmatchedCount) {
  const el = document.getElementById("sidebar-summary");
  el.innerHTML = `
    写真あり圃場: <b>${state.fieldsWithPhotos.length}</b> 件<br/>
    画像ファイル: <b>${totalFiles}</b> 件
    ${invalidCount ? `(命名規則エラー ${invalidCount}件)` : ""}
    ${unmatchedCount ? `(圃場未一致 ${unmatchedCount}件)` : ""}
  `;
}

/* -------------------------------------------------------------------------
 * 10. 検索フィルタ
 * ---------------------------------------------------------------------- */
function applySearchFilter(keyword) {
  const kw = normalizeId(keyword);
  if (!kw) {
    renderSidebarList(state.fieldsWithPhotos);
    renderMarkers(state.fieldsWithPhotos);
    return;
  }
  const filtered = state.fieldsWithPhotos.filter(({ field }) => {
    const haystack = normalizeId(
      [
        field["圃場名"],
        field["住所"],
        field["担当者"],
        field["圃場カテゴリ"],
        field["作付計画_品種"],
      ]
        .filter(Boolean)
        .join(" ")
    );
    return haystack.includes(kw);
  });
  renderSidebarList(filtered);
  renderMarkers(filtered);
}

/* -------------------------------------------------------------------------
 * 11. ギャラリー & ライトボックス
 * ---------------------------------------------------------------------- */
let currentGalleryPhotos = [];
let currentLightboxIndex = 0;

function openGallery(field) {
  const photos = state.photosByFieldRecord.get(field) || [];
  currentGalleryPhotos = photos;

  document.getElementById(
    "gallery-title"
  ).textContent = `🌾 ${field["圃場名"]} の写真`;
  document.getElementById("gallery-meta").innerHTML = `
    ${escapeHtml(field["住所"] || "")} ${escapeHtml(field["圃場カテゴリ"] || "")} /
    ${escapeHtml(field["作付計画_品種"] || "")}
    ${field["担当者"] ? " / 担当: " + escapeHtml(field["担当者"]) : ""}
    ・ 全 ${photos.length} 枚
  `;

  const grid = document.getElementById("gallery-grid");
  grid.innerHTML = "";
  photos.forEach((photo, idx) => {
    const item = document.createElement("div");
    item.className = "gallery-item";
    item.innerHTML = `
      <img src="${photo.url}" loading="lazy" alt="${escapeHtml(photo.filename)}" />
      <div class="gi-caption">
        <b>${escapeHtml(photo.shotType || "")}</b><br/>
        ${photo.dateTimeLabel}<br/>
        撮影者: ${escapeHtml(photo.photographer)}
      </div>
    `;
    item.addEventListener("click", () => openLightbox(idx));
    grid.appendChild(item);
  });

  document.getElementById("gallery-modal").classList.remove("hidden");
}

function closeGallery() {
  document.getElementById("gallery-modal").classList.add("hidden");
}

function openLightbox(index) {
  currentLightboxIndex = index;
  updateLightbox();
  document.getElementById("lightbox").classList.remove("hidden");
}

function closeLightbox() {
  document.getElementById("lightbox").classList.add("hidden");
}

function updateLightbox() {
  const photo = currentGalleryPhotos[currentLightboxIndex];
  if (!photo) return;
  document.getElementById("lightbox-img").src = photo.url;
  document.getElementById("lightbox-img").alt = photo.filename;
  document.getElementById("lightbox-caption").innerHTML = `
    ${escapeHtml(photo.shotType || "")} ・ ${photo.dateTimeLabel} ・ 撮影者: ${escapeHtml(
    photo.photographer
  )}
    (${currentLightboxIndex + 1} / ${currentGalleryPhotos.length})
  `;
}

function lightboxNav(delta) {
  if (currentGalleryPhotos.length === 0) return;
  currentLightboxIndex =
    (currentLightboxIndex + delta + currentGalleryPhotos.length) %
    currentGalleryPhotos.length;
  updateLightbox();
}

/* -------------------------------------------------------------------------
 * 12. イベント登録
 * ---------------------------------------------------------------------- */
function bindUiEvents() {
  document.getElementById("search-box").addEventListener("input", (e) => {
    applySearchFilter(e.target.value);
  });

  document.getElementById("sidebar-toggle-btn").addEventListener("click", () => {
    document.getElementById("sidebar").classList.toggle("collapsed");
  });

  document.getElementById("refresh-btn").addEventListener("click", async () => {
    sessionStorage.removeItem("ksas_img_list_cache_v1");
    setStatus("再読み込み中…");
    state.fieldsByNormName.clear();
    state.photosByFieldRecord.clear();
    await loadDataAndRender();
  });

  // 地図ポップアップ内「すべての写真を見る」ボタン (イベント委譲)
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".popup-open-btn");
    if (!btn) return;
    const no = Number(btn.dataset.fieldNo);
    const field = state.fields.find((f) => f.No === no);
    if (field) openGallery(field);
  });

  document
    .getElementById("gallery-close-btn")
    .addEventListener("click", closeGallery);
  document.getElementById("gallery-modal").addEventListener("click", (e) => {
    if (e.target.id === "gallery-modal") closeGallery();
  });

  document
    .getElementById("lightbox-close-btn")
    .addEventListener("click", closeLightbox);
  document
    .getElementById("lightbox-prev-btn")
    .addEventListener("click", () => lightboxNav(-1));
  document
    .getElementById("lightbox-next-btn")
    .addEventListener("click", () => lightboxNav(1));
  document.getElementById("lightbox").addEventListener("click", (e) => {
    if (e.target.id === "lightbox") closeLightbox();
  });
  document.addEventListener("keydown", (e) => {
    if (document.getElementById("lightbox").classList.contains("hidden")) return;
    if (e.key === "Escape") closeLightbox();
    if (e.key === "ArrowLeft") lightboxNav(-1);
    if (e.key === "ArrowRight") lightboxNav(1);
  });
}

/* -------------------------------------------------------------------------
 * 13. 起動
 * ---------------------------------------------------------------------- */
document.addEventListener("DOMContentLoaded", () => {
  initMap(); // 地図の初期化は最初の1回のみ
  bindUiEvents();
  loadDataAndRender();
});
