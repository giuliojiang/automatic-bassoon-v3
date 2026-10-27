'use strict';
/* automatic-bassoon-v2 — sheet music viewer (no build step, no external deps) */

const app = document.getElementById('app');

const VAULT_SALT = '880bcbd6b864f3260b1d990dda152e4c';
const VAULT_ITERATIONS = 20000000;
const PROBE_URL = 'probe.enc';
const PROBE_TEXT = 'sheet-vault-probe::ok';
const PROGRESS_KEY = 'ab2-progress-v1';

let manifest = null;
let keyHandler = null;
let vaultKey = null;

function setKeyHandler(fn) {
  if (keyHandler) document.removeEventListener('keydown', keyHandler);
  keyHandler = fn;
  if (fn) document.addEventListener('keydown', fn);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function getProgress() {
  try { return JSON.parse(localStorage.getItem(PROGRESS_KEY)) || {}; } catch { return {}; }
}
function saveProgress(name, idx) {
  try {
    const p = getProgress();
    p[name] = idx;
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(p));
  } catch { /* private mode etc. */ }
}

/* ================= PIN ================= */

async function deriveVaultKey(pin) {
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: hexToBytes(VAULT_SALT), iterations: VAULT_ITERATIONS, hash: 'SHA-256' },
    km, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function renderPin() {
  let entry = '';
  let verifying = false;
  app.innerHTML = `
    <div class="pin-screen" id="pinScreen">
      <div class="pin-title">Sheet Music</div>
      <div class="pin-dots" id="pinDots">${'<div class="pin-dot"></div>'.repeat(8)}</div>
      <div class="pin-loading" id="pinLoading" hidden>Loading…</div>
      <div class="pin-pad" id="pinPad"></div>
    </div>`;

  const dots = document.getElementById('pinDots').children;
  const pad = document.getElementById('pinPad');
  // WebCrypto needs a secure context; on plain HTTP the PIN can never verify,
  // so say so instead of shaking on every attempt.
  if (!window.crypto || !crypto.subtle) {
    pad.innerHTML = '<div class="pin-insecure">Unlocking needs a secure connection.<br>Please open<br><b>https://m.jstudios.ovh</b></div>';
    return;
  }
  const keys = ['1','2','3','4','5','6','7','8','9','C','0','⌫'];
  for (const k of keys) {
    const b = document.createElement('button');
    b.className = 'pin-key' + (k === 'C' || k === '⌫' ? ' fn' : '');
    b.textContent = k;
    b.addEventListener('click', () => press(k));
    pad.appendChild(b);
  }

  function draw() {
    for (let i = 0; i < 8; i++) dots[i].classList.toggle('filled', i < entry.length);
  }
  function deny() {
    const screen = document.getElementById('pinScreen');
    screen.classList.remove('shake');
    void screen.offsetWidth; // restart animation
    screen.classList.add('shake');
    entry = '';
    draw();
  }
  async function submit() {
    if (entry.length !== 8 || verifying) return;
    verifying = true;
    // Show the loading state and let the browser paint it before the
    // ~1s key derivation blocks the main thread.
    const loading = document.getElementById('pinLoading');
    loading.hidden = false;
    pad.style.visibility = 'hidden';
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      const key = await deriveVaultKey(entry);
      const res = await fetch(PROBE_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error('probe fetch failed');
      const buf = new Uint8Array(await res.arrayBuffer());
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: buf.slice(0, 12) },
        key, buf.slice(12));
      if (new TextDecoder().decode(pt) !== PROBE_TEXT) throw new Error('bad pin');
      vaultKey = key;
      renderLibrary();
    } catch (e) {
      deny();
    } finally {
      verifying = false;
      loading.hidden = true;
      pad.style.visibility = '';
    }
  }
  function press(k) {
    if (verifying) return;
    if (k === 'C') { entry = ''; }
    else if (k === '⌫') { entry = entry.slice(0, -1); }
    else if (entry.length < 8) { entry += k; if (entry.length === 8) { draw(); submit(); return; } }
    draw();
  }

  setKeyHandler(e => {
    if (/^[0-9]$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('⌫');
    else if (e.key === 'Enter') submit();
    else if (e.key === 'Escape') { entry = ''; draw(); }
  });
  draw();
}

/* ================= LIBRARY ================= */

let libraryQuery = ''; // persists when leaving/returning to the library

function sheetUrl(piece, file) {
  return 'sheets/' + encodeURIComponent(piece.name) + '/' + encodeURIComponent(file);
}

function renderLibrary() {
  let query = libraryQuery;
  app.innerHTML = `
    <div class="library">
      <h1>Sheet Music</h1>
      <div class="sub" id="libSub"></div>
      <input class="search" id="search" placeholder="Search…" autocomplete="off">
      <div class="quick-filters">
        <button class="qf" data-q="">ALL</button>
        <button class="qf" data-q="choir">Choir</button>
        <button class="qf" data-q="rs1">RS1</button>
      </div>
      <div class="grid" id="grid"></div>
      <div class="empty" id="empty" style="display:none">No pieces found.</div>
    </div>`;
  document.getElementById('libSub').textContent = manifest.pieces.length + ' pieces';
  document.getElementById('libSub').insertAdjacentHTML('afterend', `
      <div class="offline">
        <div class="offline-status" id="offlineStatus">Checking offline library…</div>
      </div>`);
  const grid = document.getElementById('grid');
  const empty = document.getElementById('empty');
  const search = document.getElementById('search');

  function drawGrid() {
    const pieces = (manifest.pieces || []).filter(p =>
      p.title.toLowerCase().includes(query.toLowerCase()));
    const progress = getProgress();
    grid.innerHTML = '';
    empty.style.display = pieces.length ? 'none' : 'block';
    cardDlBtns.clear();
    for (const p of pieces) {
      const card = document.createElement('div');
      card.className = 'card';
      const saved = progress[p.name];
      const resume = (saved > 0 && saved < p.pages.length)
        ? `<span class="resume"> · p.${saved + 1}</span>` : '';
      card.innerHTML = `
        <div class="card-body">
          <div class="card-title">${esc(p.title)}</div>
          <div class="card-meta">${p.pages.length} page${p.pages.length === 1 ? '' : 's'}${resume}</div>
          ${p.audios.length ? `<div class="audio-row">${p.audios.map(a =>
            `<a class="audio-chip" href="${esc(sheetUrl(p, a))}" target="_blank" rel="noopener" data-stop="1">▶ ${esc(a.replace(/\.mp3$/i, ''))}</a>`
          ).join('')}</div>` : ''}
        </div>`;
      card.addEventListener('click', e => {
        if (e.target.closest('[data-stop]')) return; // audio link: don't open viewer
        renderViewer(p);
      });
      const dlRow = document.createElement('div');
      dlRow.className = 'dl-row';
      const dlBtn = document.createElement('button');
      dlBtn.className = 'dl-btn';
      dlBtn.setAttribute('data-stop', '1');
      dlBtn.textContent = '…';
      dlBtn.addEventListener('click', () => onDlClick(p, dlBtn));
      dlRow.appendChild(dlBtn);
      card.querySelector('.card-body').appendChild(dlRow);
      cardDlBtns.set(p.name, dlBtn);
      grid.appendChild(card);
    }
    updateCardOfflineStates();
  }

  search.addEventListener('input', e => { setQuery(e.target.value); });
  const qf = document.querySelectorAll('.qf');
  function setQuery(q) {
    query = q;
    libraryQuery = q;
    search.value = q;
    qf.forEach(b => b.classList.toggle('active', b.dataset.q === q.toLowerCase()));
    drawGrid();
  }
  qf.forEach(b => b.addEventListener('click', () => setQuery(b.dataset.q)));
  setQuery(query); // restore persisted filter instead of clearing it
  initOfflineUI();
  setKeyHandler(null);
}


/* ================= OFFLINE ================= */
/* Per-piece offline support, via the service worker (service-worker.js).
 * Encrypted pages are cached as-is; decryption still happens in memory
 * after the PIN, so nothing about the vault changes. The cache is the
 * source of truth: a page counts as offline only once it is cached. */

const OFFLINE_CACHE = 'sheet-vault-v1';
const pieceDownloads = new Map(); // piece name -> { cancelled, done, total }
const cardDlBtns = new Map(); // piece name -> current card download button

function allSheetUrls() {
  const urls = [];
  for (const p of (manifest.pieces || [])) {
    for (const f of p.pages) urls.push(sheetUrl(p, f));
  }
  return urls;
}

async function offlineCachedSet() {
  // Set of cached sheet paths in 'sheets/<piece>/<file>' form, or null
  // when the Cache API is unavailable.
  try {
    if (!('caches' in window)) return null;
    const cache = await caches.open(OFFLINE_CACHE);
    const keys = await cache.keys();
    const out = new Set();
    for (const r of keys) {
      const path = new URL(r.url).pathname;
      const i = path.indexOf('/sheets/');
      if (i >= 0) out.add(path.slice(i + 1));
    }
    return out;
  } catch { return null; }
}

function pieceCachedCount(piece, cached) {
  let n = 0;
  for (const f of piece.pages) if (cached.has(sheetUrl(piece, f))) n++;
  return n;
}

function dlBtnLabel(piece, cached, dl) {
  if (dl) return '↓ ' + dl.done + '/' + piece.pages.length;
  const n = cached ? pieceCachedCount(piece, cached) : 0;
  if (n >= piece.pages.length) return '✓ Saved';
  if (n > 0) return '↓ Resume · ' + n + '/' + piece.pages.length;
  return '↓ Download';
}

async function updateCardOfflineStates() {
  const cached = await offlineCachedSet();
  const pieces = manifest.pieces || [];
  const total = pieces.reduce((s, p) => s + p.pages.length, 0);
  let savedTotal = 0;
  if (cached) for (const p of pieces) savedTotal += pieceCachedCount(p, cached);
  const statusEl = document.getElementById('offlineStatus');
  if (statusEl) {
    if (!cached) statusEl.textContent = 'Offline library is not available in this browser.';
    else if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) {
      statusEl.textContent = 'Offline support is installing — reload the page once, then come back here.';
    } else {
      statusEl.textContent = 'Offline: ' + savedTotal + ' of ' + total + ' pages saved on this device.';
    }
  }
  for (const [name, btn] of cardDlBtns) {
    const piece = pieces.find(p => p.name === name);
    if (!piece) continue;
    btn.textContent = dlBtnLabel(piece, cached, pieceDownloads.get(name));
  }
}

async function onDlClick(piece, btn) {
  const name = piece.name;
  const running = pieceDownloads.get(name);
  if (running) { running.cancelled = true; return; } // tap while downloading cancels
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) {
    const statusEl = document.getElementById('offlineStatus');
    if (statusEl) statusEl.textContent = 'Offline support is installing — reload the page once, then come back here.';
    return;
  }
  const cached = await offlineCachedSet();
  if (cached && pieceCachedCount(piece, cached) >= piece.pages.length) {
    // Saved -> tapping removes this piece's offline copy.
    const cache = await caches.open(OFFLINE_CACHE);
    await Promise.all(piece.pages.map(f => cache.delete(sheetUrl(piece, f))));
    await updateCardOfflineStates();
    return;
  }
  const dl = { cancelled: false, done: cached ? pieceCachedCount(piece, cached) : 0, total: piece.pages.length };
  pieceDownloads.set(name, dl);
  try {
    if (navigator.storage && navigator.storage.persist) {
      try { await navigator.storage.persist(); } catch {}
    }
  } catch {}
  const before = await offlineCachedSet();
  const todo = [];
  for (const f of piece.pages) {
    const u = sheetUrl(piece, f);
    if (!before || !before.has(u)) todo.push(u);
  }
  for (const u of todo) {
    if (dl.cancelled) break;
    try {
      const res = await fetch(u);
      if (!res.ok) throw new Error('http ' + res.status);
      await res.arrayBuffer();
      dl.done++;
    } catch { /* failed pages stay uncached; tap again to retry them */ }
    btn.textContent = dlBtnLabel(piece, null, dl);
  }
  pieceDownloads.delete(name);
  await updateCardOfflineStates();
}

function initOfflineUI() {
  if (!('serviceWorker' in navigator) || !('caches' in window)) {
    const statusEl = document.getElementById('offlineStatus');
    if (statusEl) statusEl.textContent = 'Offline library is not available in this browser.';
    return;
  }
  if (!navigator.serviceWorker.controller) {
    navigator.serviceWorker.addEventListener('controllerchange', () => updateCardOfflineStates());
  }
  updateCardOfflineStates();
}

/* ================= VIEWER ================= */

function renderViewer(piece) {
  const pages = piece.pages;
  const n = pages.length;
  let idx = 0;
  const saved = getProgress()[piece.name];
  if (Number.isInteger(saved) && saved >= 0 && saved < n) idx = saved;

  app.innerHTML = `
    <div class="viewer" id="viewer">
      <img class="page" id="page" draggable="false" alt="page">
    </div>`;
  const viewer = document.getElementById('viewer');
  const img = document.getElementById('page');

  const pageBlobs = new Map();
  const PAGE_BLOB_MAX = 24;
  function cachePageBlob(url, blobUrl) {
    pageBlobs.set(url, blobUrl);
    while (pageBlobs.size > PAGE_BLOB_MAX) {
      const oldest = pageBlobs.keys().next().value;
      URL.revokeObjectURL(pageBlobs.get(oldest));
      pageBlobs.delete(oldest);
    }
  }
  async function decryptedPageUrl(url) {
    const hit = pageBlobs.get(url);
    if (hit) { pageBlobs.delete(url); pageBlobs.set(url, hit); return hit; }
    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) throw new Error('fetch failed: ' + res.status);
    const buf = new Uint8Array(await res.arrayBuffer());
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: buf.slice(0, 12) }, vaultKey, buf.slice(12));
    const blobUrl = URL.createObjectURL(new Blob([pt], { type: 'image/png' }));
    cachePageBlob(url, blobUrl);
    return blobUrl;
  }
  function clearPageBlobs() {
    for (const u of pageBlobs.values()) URL.revokeObjectURL(u);
    pageBlobs.clear();
  }

  function preload(i) {
    if (i < 0 || i >= n) return;
    decryptedPageUrl(sheetUrl(piece, pages[i])).catch(() => {});
  }

  let showToken = 0;
  async function show(i) {
    if (i < 0) { bump('right'); return; }
    if (i > n - 1) { bump('left'); return; }
    const t = ++showToken;
    idx = Math.max(0, Math.min(n - 1, i));
    saveProgress(piece.name, idx);
    try {
      const url = await decryptedPageUrl(sheetUrl(piece, pages[idx]));
      if (t !== showToken) return; // superseded by a newer navigation
      img.src = url;
    } catch (e) { /* keep previous image on failure */ }
    preload(idx - 1);
    preload(idx + 1);
  }

  const prev = () => show(idx - 1);
  const next = () => show(idx + 1);
  const back = () => { clearPageBlobs(); renderLibrary(); };

  // Boundary nudge: trying to move past the first/last page nudges the
  // image toward the edge and springs it back.
  function bump(dir) {
    const cls = dir === 'left' ? 'bump-left' : 'bump-right';
    img.classList.remove('bump-left', 'bump-right');
    void img.offsetWidth; // restart the animation if it's already playing
    img.classList.add(cls);
  }
  img.addEventListener('animationend', () => img.classList.remove('bump-left', 'bump-right'));

  // Kindle-style tap zones: top = exit, bottom-left = back, bottom-right = forward
  let touchStart = null;
  viewer.addEventListener('touchstart', e => {
    const t = e.changedTouches[0];
    touchStart = { x: t.clientX, y: t.clientY };
  }, { passive: true });
  viewer.addEventListener('touchend', e => {
    if (!touchStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    touchStart = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      e.preventDefault();
      if (dx < 0) next(); else prev(); // swipe
      return;
    }
    if (Math.abs(dy) > 60) return; // vertical swipe: ignore
    // Cancel the synthesized click so the tap can't fall through to the
    // library underneath (it could land on the search box and pop the keyboard).
    e.preventDefault();
    tap(t.clientX, t.clientY);
  });
  viewer.addEventListener('click', e => tap(e.clientX, e.clientY));
  // touchend already handled the tap on touch devices; avoid double-firing
  let lastTap = 0;
  function tap(x, y) {
    const now = Date.now();
    if (now - lastTap < 350) return;
    lastTap = now;
    const h = window.innerHeight, w = window.innerWidth;
    if (y < h * 0.18) back();
    else if (x < w / 2) prev();
    else next();
  }
  viewer.addEventListener('contextmenu', e => e.preventDefault());

  // Keyboard, same as the original: arrows page, L = next, Esc = back.
  // Right/Down is throttled (3s) so a held key or page-turn pedal can't skip pages.
  let lastNextTs = 0;
  function nextThrottled() {
    if (Date.now() - lastNextTs > 3000) { lastNextTs = Date.now(); next(); }
  }
  setKeyHandler(e => {
    if (e.code === 'ArrowLeft' || e.code === 'ArrowUp') prev();
    else if (e.code === 'ArrowRight' || e.code === 'ArrowDown') nextThrottled();
    else if (e.code === 'KeyL') { lastNextTs = Date.now(); next(); }
    else if (e.code === 'Escape') back();
    else if (e.code === 'Home') show(0);
    else if (e.code === 'End') show(n - 1);
  });

  show(idx);
}

/* ================= BOOT ================= */

(async function boot() {
  try {
    const res = await fetch('manifest.json', { cache: 'no-cache' });
    manifest = await res.json();
  } catch (e) {
    app.innerHTML = '<div class="empty">Could not load manifest.json</div>';
    return;
  }
  renderPin();
})();
