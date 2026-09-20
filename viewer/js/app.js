/* =========================================================================
 * 圃場写真ビューワー (KSAS Field Photo Viewer) - シンプル版
 * -------------------------------------------------------------------------
 * ・同じ階層の KSAS_field_all.json から圃場(緯度経度)一覧を読み込みます
 * ・/img/ フォルダの画像一覧は GitHub API から自動取得します
 *   (画像ファイル名: 日付_時間_撮影者_圃場ID_撮影種別.拡張子 の命名規則が前提)
 * ・画面は2つだけ:
 *    ① 地図から見る    : ピンをタップ → その圃場の写真一式を表示
 *    ② 撮影種別から見る : 撮影種別を選択 → 該当写真を一覧表示 → タップで地図表示
 * ========================================================================= */

"use strict";

/* ------------------------------------------------------------------ *
 * 設定 (必要に応じてここだけ書き換えてください)
 * ------------------------------------------------------------------ */
const CONFIG = {
  owner: null,               // GitHubユーザー名。nullならURLから自動判定
  repo: null,                // リポジトリ名。nullならURLから自動判定
  branches: ["main", "master", "gh-pages"],
  imgDir: "img",
  jsonPath: "./KSAS_field_all.json",
  manifestPath: "./img/manifest.json", // 任意。あれば優先使用
  cacheMinutes: 10,
  imageExtRegex: /\.(jpe?g|png|gif|webp)$/i,
};

/* ------------------------------------------------------------------ *
 * 文字列正規化 (全角/半角 揺れ吸収)
 * ------------------------------------------------------------------ */
function toHalfWidth(str) {
  return str
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, " ");
}
function normalizeId(str) {
  if (!str) return "";
  return toHalfWidth(String(str)).trim().replace(/\s+/g, "").toLowerCase();
}
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* ------------------------------------------------------------------ *
 * GitHub リポジトリ情報の自動判定
 * ------------------------------------------------------------------ */
function detectRepoInfo() {
  const host = location.hostname;
  const owner = CONFIG.owner || host.split(".")[0];
  const segments = location.pathname.split("/").filter(Boolean);
  const repo = CONFIG.repo || (segments.length > 0 ? segments[0] : `${owner}.github.io`);
  return { owner, repo };
}

/* ------------------------------------------------------------------ *
 * 画像ファイル名の解析
 * 例: 20260920_082945_Hosokawa_３０２_FieldHigh.jpg
 * ------------------------------------------------------------------ */
function parseImageFilename(filename) {
  const dot = filename.lastIndexOf(".");
  const base = dot >= 0 ? filename.slice(0, dot) : filename;
  const parts = base.split("_");
  if (parts.length < 5) return null;

  const [date, time, photographer, fieldId, ...rest] = parts;
  if (!/^\d{8}$/.test(date) || !/^\d{6}$/.test(time)) return null;

  return {
    filename,
    date, time, photographer,
    fieldId,
    fieldIdNorm: normalizeId(fieldId),
    shotType: rest.join("_"),
    url: `./${CONFIG.imgDir}/${filename}`,
    dateTimeLabel: formatDateTime(date, time),
    sortKey: `${date}${time}`,
  };
}
function formatDateTime(date, time) {
  if (!date || !time) return "";
  const y = date.slice(0, 4), m = date.slice(4, 6), d = date.slice(6, 8);
  const hh = time.slice(0, 2), mm = time.slice(2, 4);
  return `${y}/${m}/${d} ${hh}:${mm}`;
}

/* ------------------------------------------------------------------ *
 * 画像一覧の取得 (manifest.json 優先 → キャッシュ → GitHub API)
 * ------------------------------------------------------------------ */
async function loadImageFilenames() {
  try {
    const res = await fetch(CONFIG.manifestPath, { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      const files = Array.isArray(data) ? data : data.files;
      if (Array.isArray(files)) {
        setStatus(`manifest.json から取得 (${files.length}件)`);
        return files;
      }
    }
  } catch (e) { /* manifestが無ければ次へ */ }

  const cacheKey = "ksas_img_list_cache_v1";
  try {
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      const { timestamp, files } = JSON.parse(cached);
      if (Date.now() - timestamp < CONFIG.cacheMinutes * 60 * 1000) {
        setStatus(`キャッシュから取得 (${files.length}件)`);
        return files;
      }
    }
  } catch (e) { /* ignore */ }

  const { owner, repo } = detectRepoInfo();
  let lastErr = null;
  for (const branch of CONFIG.branches) {
    try {
      setStatus(`GitHub (${owner}/${repo}@${branch}) から取得中…`);
      const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
      const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });

      if (res.status === 403) {
        // 403 はレート制限 または プライベートリポジトリ等が原因。
        // ブランチを変えても解消しないため即座に打ち切り、原因を判定してわかりやすく通知する。
        const remaining = res.headers.get("x-ratelimit-remaining");
        const resetHeader = res.headers.get("x-ratelimit-reset");
        let detail;
        if (remaining === "0") {
          const resetTime = resetHeader
            ? new Date(Number(resetHeader) * 1000).toLocaleTimeString("ja-JP")
            : "しばらく後";
          detail = `GitHub APIの利用回数制限に達しました(未認証は60回/時間/IP)。${resetTime} 頃に制限が解除されます。`;
        } else {
          detail = `GitHub APIから403 (アクセス拒否) が返されました。リポジトリが Private になっているか、リポジトリ名/ユーザー名の設定が誤っている可能性があります。`;
        }
        throw new Error(
          `${detail} 恒久的な対策として img/manifest.json を自動生成する GitHub Actions ワークフロー(.github/workflows/update-manifest.yml)を同梱していますので、そちらの利用を推奨します。`
        );
      }

      if (!res.ok) { lastErr = new Error(`GitHub APIエラー (${res.status})`); continue; }
      const data = await res.json();
      const prefix = CONFIG.imgDir.replace(/\/+$/, "") + "/";
      const files = (data.tree || [])
        .filter((item) => item.type === "blob" && item.path.startsWith(prefix) && CONFIG.imageExtRegex.test(item.path))
        .map((item) => item.path.slice(prefix.length));
      if (files.length > 0) {
        sessionStorage.setItem(cacheKey, JSON.stringify({ timestamp: Date.now(), files }));
        setStatus(`GitHubから取得 (${files.length}件)`);
        return files;
      }
    } catch (e) { lastErr = e; if (/GitHub APIの利用回数制限|403/.test(e.message)) throw e; }
  }
  throw lastErr || new Error("画像一覧を取得できませんでした (imgフォルダが空か設定が誤っている可能性があります)");
}

/* ------------------------------------------------------------------ *
 * 圃場JSON読み込み
 * ------------------------------------------------------------------ */
async function loadFieldData() {
  const res = await fetch(CONFIG.jsonPath, { cache: "no-store" });
  if (!res.ok) throw new Error(`圃場データの取得に失敗しました: ${CONFIG.jsonPath}`);
  const list = await res.json();
  return list.filter((f) => typeof f.latitude === "number" && typeof f.longitude === "number");
}

/* ------------------------------------------------------------------ *
 * 状態
 * ------------------------------------------------------------------ */
const state = {
  map: null,
  fields: [],
  fieldsByNormName: new Map(),
  photosByFieldNo: new Map(),   // fieldNo -> [photo...]
  fieldsWithPhotos: [],         // [{field, photos}]
  markerByFieldNo: new Map(),
  shotTypes: [],                // ユニークな撮影種別一覧
  photosByShotType: new Map(),  // shotType -> [{field, photo}]
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

/* ------------------------------------------------------------------ *
 * データ読み込み & 集計
 * ------------------------------------------------------------------ */
async function loadDataAndRender() {
  let fields, filenames;
  try {
    [fields, filenames] = await Promise.all([loadFieldData(), loadImageFilenames()]);
  } catch (e) {
    showError(e.message || String(e));
    setStatus("読み込みに失敗しました");
    return;
  }

  state.fields = fields;
  state.fieldsByNormName.clear();
  state.photosByFieldNo.clear();
  state.photosByShotType.clear();

  fields.forEach((f) => {
    const key = normalizeId(f["圃場名"]);
    if (!key) return;
    if (!state.fieldsByNormName.has(key)) state.fieldsByNormName.set(key, []);
    state.fieldsByNormName.get(key).push(f);
  });

  let invalidCount = 0, unmatchedCount = 0;
  filenames.forEach((filename) => {
    const photo = parseImageFilename(filename);
    if (!photo) { invalidCount++; return; }
    const matches = state.fieldsByNormName.get(photo.fieldIdNorm);
    if (!matches || matches.length === 0) { unmatchedCount++; return; }

    matches.forEach((field) => {
      if (!state.photosByFieldNo.has(field.No)) state.photosByFieldNo.set(field.No, []);
      state.photosByFieldNo.get(field.No).push(photo);

      const st = photo.shotType || "(種別不明)";
      if (!state.photosByShotType.has(st)) state.photosByShotType.set(st, []);
      state.photosByShotType.get(st).push({ field, photo });
    });
  });

  state.fieldsWithPhotos = [];
  state.photosByFieldNo.forEach((photos, fieldNo) => {
    photos.sort((a, b) => (a.sortKey < b.sortKey ? 1 : -1));
    const field = fields.find((f) => f.No === fieldNo);
    if (field) state.fieldsWithPhotos.push({ field, photos });
  });
  state.fieldsWithPhotos.sort((a, b) =>
    String(a.field["圃場名"]).localeCompare(String(b.field["圃場名"]), "ja")
  );

  state.shotTypes = Array.from(state.photosByShotType.keys()).sort((a, b) =>
    a.localeCompare(b, "ja")
  );

  renderMarkers();
  renderShotTypeSelect();

  hideError();
  const totalPhotos = filenames.length - invalidCount;
  setStatus(`${state.fieldsWithPhotos.length}圃場 / ${totalPhotos}枚の写真` +
    (unmatchedCount ? ` (未一致${unmatchedCount}件)` : ""));
}

/* ------------------------------------------------------------------ *
 * ① 地図から見る
 * ------------------------------------------------------------------ */
function initMap() {
  const map = L.map("map", { zoomControl: true }).setView([34.898, 135.058], 15);

  const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 20,
  }).addTo(map);

  const sat = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { attribution: "Tiles &copy; Esri", maxZoom: 20 }
  );

  L.control.layers({ "地図": osm, "衛星写真": sat }, {}, { position: "topright" }).addTo(map);

  state.map = map;

  // 地図タブが非表示の状態で初期化されるため、表示時にサイズを再計算する
  setTimeout(() => map.invalidateSize(), 200);
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

function buildPopupHtml(field, photos) {
  const addr = field["住所"] ? `${field["住所"]} ・ ` : "";
  const thumbs = photos
    .slice(0, 5)
    .map(
      (p, i) =>
        `<img src="${p.url}" loading="lazy" data-field-no="${field.No}" data-photo-index="${i}" alt="${escapeHtml(p.shotType)}" />`
    )
    .join("");
  return `
    <div class="popup-title">🌾 ${escapeHtml(field["圃場名"])}</div>
    <div class="popup-sub">${addr}${escapeHtml(field["作付計画_品種"] || "")}${
    field["担当者"] ? " / " + escapeHtml(field["担当者"]) : ""
  } ・ 📷${photos.length}枚</div>
    <div class="popup-photo-grid">${thumbs}</div>
  `;
}

function renderMarkers() {
  // 既存マーカーを削除
  state.markerByFieldNo.forEach((m) => state.map.removeLayer(m));
  state.markerByFieldNo.clear();

  state.fieldsWithPhotos.forEach(({ field, photos }) => {
    const marker = L.marker([field.latitude, field.longitude], { icon: photoIcon() });
    marker.bindPopup(buildPopupHtml(field, photos), { maxWidth: 280 });
    marker.addTo(state.map);
    state.markerByFieldNo.set(field.No, marker);
  });
}

function focusFieldOnMap(field) {
  switchView("map");
  state.map.setView([field.latitude, field.longitude], 18, { animate: true });
  const marker = state.markerByFieldNo.get(field.No);
  if (marker) setTimeout(() => marker.openPopup(), 250);
}

/* ------------------------------------------------------------------ *
 * ② 撮影種別から見る
 * ------------------------------------------------------------------ */
function renderShotTypeSelect() {
  const select = document.getElementById("shottype-select");
  const prev = select.value;
  select.innerHTML = "";
  if (state.shotTypes.length === 0) {
    select.innerHTML = `<option value="">(写真がありません)</option>`;
    renderBytypeGrid("");
    return;
  }
  state.shotTypes.forEach((st) => {
    const opt = document.createElement("option");
    opt.value = st;
    opt.textContent = `${st} (${state.photosByShotType.get(st).length}枚)`;
    select.appendChild(opt);
  });
  select.value = state.shotTypes.includes(prev) ? prev : state.shotTypes[0];
  renderBytypeGrid(select.value);
}

function renderBytypeGrid(shotType) {
  const grid = document.getElementById("bytype-grid");
  const countEl = document.getElementById("bytype-count");
  grid.innerHTML = "";

  const items = state.photosByShotType.get(shotType) || [];
  countEl.textContent = items.length ? `全 ${items.length} 枚` : "";

  if (items.length === 0) {
    grid.innerHTML = `<div id="bytype-empty">この撮影種別の写真はありません</div>`;
    return;
  }

  // 圃場名でソートして表示
  const sorted = [...items].sort((a, b) =>
    String(a.field["圃場名"]).localeCompare(String(b.field["圃場名"]), "ja")
  );

  sorted.forEach(({ field, photo }) => {
    const card = document.createElement("div");
    card.className = "bytype-card";
    card.innerHTML = `
      <img src="${photo.url}" loading="lazy" alt="${escapeHtml(field["圃場名"])}" />
      <div class="bc-body">
        <div class="bc-field">🌾 ${escapeHtml(field["圃場名"])}</div>
        <div class="bc-meta">
          ${escapeHtml(field["住所"] || field["圃場カテゴリ"] || "")}<br/>
          ${photo.dateTimeLabel} ・ ${escapeHtml(photo.photographer)}
        </div>
      </div>
    `;
    card.addEventListener("click", () => focusFieldOnMap(field));
    grid.appendChild(card);
  });
}

/* ------------------------------------------------------------------ *
 * メニュー(ビュー)切替
 * ------------------------------------------------------------------ */
function switchView(viewName) {
  document.querySelectorAll(".view").forEach((el) => el.classList.remove("active"));
  document.getElementById(`view-${viewName}`).classList.add("active");

  document.querySelectorAll(".menu-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === viewName);
  });

  if (viewName === "map" && state.map) {
    setTimeout(() => state.map.invalidateSize(), 50);
  }
}

/* ------------------------------------------------------------------ *
 * ライトボックス (拡大表示)
 * ------------------------------------------------------------------ */
let lightboxPhotos = [];
let lightboxIndex = 0;

function openLightboxForField(fieldNo, index) {
  const photos = state.photosByFieldNo.get(Number(fieldNo)) || [];
  if (photos.length === 0) return;
  lightboxPhotos = photos;
  lightboxIndex = Number(index) || 0;
  updateLightbox();
  document.getElementById("lightbox").classList.remove("hidden");
}
function closeLightbox() {
  document.getElementById("lightbox").classList.add("hidden");
}
function updateLightbox() {
  const photo = lightboxPhotos[lightboxIndex];
  if (!photo) return;
  document.getElementById("lightbox-img").src = photo.url;
  document.getElementById("lightbox-img").alt = photo.filename;
  document.getElementById("lightbox-caption").textContent =
    `${photo.shotType || ""} ・ ${photo.dateTimeLabel} ・ 撮影者: ${photo.photographer} ` +
    `(${lightboxIndex + 1}/${lightboxPhotos.length})`;
}
function lightboxNav(delta) {
  if (lightboxPhotos.length === 0) return;
  lightboxIndex = (lightboxIndex + delta + lightboxPhotos.length) % lightboxPhotos.length;
  updateLightbox();
}

/* ------------------------------------------------------------------ *
 * イベント登録
 * ------------------------------------------------------------------ */
function bindUiEvents() {
  document.querySelectorAll(".menu-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  document.getElementById("shottype-select").addEventListener("change", (e) => {
    renderBytypeGrid(e.target.value);
  });

  // 地図ポップアップ内サムネイル → ライトボックス (イベント委譲)
  document.addEventListener("click", (e) => {
    const img = e.target.closest(".popup-photo-grid img");
    if (img) {
      openLightboxForField(img.dataset.fieldNo, img.dataset.photoIndex);
    }
  });

  document.getElementById("lightbox-close-btn").addEventListener("click", closeLightbox);
  document.getElementById("lightbox-prev-btn").addEventListener("click", () => lightboxNav(-1));
  document.getElementById("lightbox-next-btn").addEventListener("click", () => lightboxNav(1));
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

/* ------------------------------------------------------------------ *
 * 起動
 * ------------------------------------------------------------------ */
document.addEventListener("DOMContentLoaded", () => {
  initMap();
  bindUiEvents();
  loadDataAndRender();
});
