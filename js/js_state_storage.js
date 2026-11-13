pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
// =========================================================================
// CẦU NỐI TỰ ĐỘNG CHO VS CODE LIVE SERVER (127.0.0.1) & GITHUB PAGES
// =========================================================================
const GAS_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbwlhByeOZIdDs4dIpioMo4e-2On3ad317kjoFMobpPiNUjtYi3o8Aa_jCXuoUWRucVJ/exec"; // Ví dụ: https://script.google.com/macros/s/AKfy.../exec

if (typeof window.google === "undefined" || !window.google.script) {
  function createGasBridge(onSuccess, onFailure) {
    return new Proxy({}, {
      get: function(_, prop) {
        if (prop === "withSuccessHandler") {
          return function(fn) { return createGasBridge(fn, onFailure); };
        }
        if (prop === "withFailureHandler") {
          return function(fn) { return createGasBridge(onSuccess, fn); };
        }
        return function(...args) {
          fetch(GAS_WEB_APP_URL, {
            method: "POST",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify({ action: prop, args: args })
          })
          .then(res => res.json())
          .then(res => {
            if (res.ok) {
              if (onSuccess) onSuccess(res.data);
            } else {
              if (onFailure) onFailure(new Error(res.error || "Lỗi Server GAS"));
            }
          })
          .catch(err => {
            if (onFailure) onFailure(err);
          });
        };
      }
    });
  }
  window.google = { script: { run: createGasBridge(null, null) } };
}
// =========================================================================
let currentManifest = null;
let currentFileId = null;
let currentScale = 1.0;
let isDragging = false;
let startX = 0, startY = 0;
let scrollLeftStart = 0, scrollTopStart = 0;

let searchResults = [];
let currentMatchIndex = -1;
let pageObserver = null;
let lastSearchedQuery = "";

const LARGE_FILE_THRESHOLD_MB = 6.0;
let currentFileSizeMB = 0;

const DB_NAME = "Bcons_Prv_Cache_DB";
const PAGE_STORE = "page_bitmaps";
const PDF_STORE = "pdf_binaries";
const MAX_LOCAL_FILES = 3;
let dbPromise = null;
let cachedRenderScale = 1;
const STORE_NAME = "manifests_v13_vision";
const MAX_RAM_FILES = 5;
const SESSION_LRU_KEYS = [];
const SESSION_MANIFEST_CACHE = {};

let currentSessionEpoch = 0;
let activeFetchAbortController = null;
let currentFileName = "";
let cachedDriveToken = null;
let driveTokenExpiresAt = 0;
let currentTargetFolderId = "1qK7-AXau_htyfxhmllXLCp2w0dkb6d40";

let globalTesseractScheduler = null;
let tesseractPreloadPromise = null;
let currentPdfDoc = null;
let pdfLoadPromise = null;

let isZooming = false;
let scrollLock = false;
let zoomDebounceTimer = null;
let sharpenToken = 0;
let jumpToken = 0;
const activeRenderTasks = new Map();

let bgAudioCtx = null;
let bgSourceNode = null;

function scalesEqual(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.004;
}

function putSessionCache(fileId, manifest) {
  if (!fileId || !manifest) return;
  const idx = SESSION_LRU_KEYS.indexOf(fileId);
  if (idx !== -1) SESSION_LRU_KEYS.splice(idx, 1);
  SESSION_LRU_KEYS.unshift(fileId);
  SESSION_MANIFEST_CACHE[fileId] = manifest;

  while (SESSION_LRU_KEYS.length > MAX_RAM_FILES) {
    const evictedId = SESSION_LRU_KEYS.pop();
    if (evictedId && evictedId !== currentFileId) {
      delete SESSION_MANIFEST_CACHE[evictedId];
      console.log(`%c🧹 [LRU CACHE] Giải phóng RAM file: ${evictedId} (Đã có IndexedDB sao lưu)`, "color: #78909c;");
    }
  }
}

function getSessionCache(fileId) {
  if (!SESSION_MANIFEST_CACHE[fileId]) return null;
  const idx = SESSION_LRU_KEYS.indexOf(fileId);
  if (idx !== -1) {
    SESSION_LRU_KEYS.splice(idx, 1);
    SESSION_LRU_KEYS.unshift(fileId);
  }
  return SESSION_MANIFEST_CACHE[fileId];
}

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(function(resolve, reject) {
    const req = indexedDB.open(DB_NAME, 13);
    req.onupgradeneeded = function(e) {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "fileId" });
      }
      if (!db.objectStoreNames.contains(PDF_STORE)) {
        db.createObjectStore(PDF_STORE);
      }
      if (!db.objectStoreNames.contains(PAGE_STORE)) {
        db.createObjectStore(PAGE_STORE);
      }
    };
    req.onsuccess = function() { resolve(req.result); };
    req.onerror = function() { dbPromise = null; reject(req.error); };
    req.onblocked = function() {
      console.warn("IndexedDB blocked: Vui lòng đóng các tab khác đang mở ứng dụng.");
    };
  });
  return dbPromise;
}

function bitmapKey(fileId, pdfPage, scale) {
  return fileId + "|" + pdfPage + "|" + Math.round(Number(scale) * 100);
}

function idbGet(storeName, key) {
  return openDB().then(function(db) {
    return new Promise(function(resolve) {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = function() { resolve(req.result == null ? null : req.result); };
      req.onerror = function() { resolve(null); };
    });
  }).catch(function() { return null; });
}

function getLocalPdfBinary(fileId) {
  if (!fileId) return Promise.resolve(null);
  return idbGet(PDF_STORE, fileId);
}

function saveLocalPdfBinary(fileId, buffer) {
  if (!fileId || String(fileId).indexOf("local_") === 0 || !buffer) return Promise.resolve(false);
  // Kiểm tra an toàn: Nếu buffer đã bị detached thì bỏ qua, không slice để tránh lỗi
  if (buffer.byteLength === 0) return Promise.resolve(false);
  
  let copyBuf;
  try {
    copyBuf = buffer.slice(0);
  } catch (e) {
    return Promise.resolve(false);
  }

  return openDB().then(function(db) {
    return new Promise(function(resolve) {
      const tx = db.transaction(PDF_STORE, "readwrite");
      tx.oncomplete = function() { resolve(true); };
      tx.onerror = function() { resolve(false); };
      tx.objectStore(PDF_STORE).put(copyBuf, fileId);
    });
  }).then(function(ok) {
    rememberLocalFile(fileId);
    return ok;
  }).catch(function() { return false; });
}

function getLocalManifest(fileId) {
  return idbGet(STORE_NAME, fileId).then(function(row) {
    return row && row.manifest ? row.manifest : null;
  });
}

function saveLocalManifest(fileId, manifest) {
  if (!fileId) return Promise.resolve(false);
  return openDB().then(function(db) {
    return new Promise(function(resolve) {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.oncomplete = function() { resolve(true); };
      tx.onerror = function() { resolve(false); };
      tx.objectStore(STORE_NAME).put({ fileId: fileId, manifest: manifest });
    });
  }).catch(function() { return false; });
}

function getPageBitmap(fileId, pdfPage, scale) {
  if (!fileId || String(fileId).indexOf("local_") === 0) return Promise.resolve(null);
  if (!scalesEqual(scale, cachedRenderScale)) return Promise.resolve(null);
  return idbGet(PAGE_STORE, bitmapKey(fileId, pdfPage, scale));
}

function savePageBitmap(fileId, pdfPage, scale, canvas) {
  if (!fileId || String(fileId).indexOf("local_") === 0 || !canvas) return Promise.resolve(false);
  if (!scalesEqual(scale, cachedRenderScale)) return Promise.resolve(false);
  return new Promise(function(resolve) {
    canvas.toBlob(function(blob) {
      if (!blob) { resolve(false); return; }
      openDB().then(function(db) {
        const tx = db.transaction(PAGE_STORE, "readwrite");
        tx.oncomplete = function() { resolve(true); };
        tx.onerror = function() { resolve(false); };
        tx.objectStore(PAGE_STORE).put(blob, bitmapKey(fileId, pdfPage, scale));
      }).catch(function() { resolve(false); });
    }, "image/jpeg", 0.88);
  });
}

function hasFullBitmapCache(fileId, pages) {
  if (!fileId || String(fileId).indexOf("local_") === 0 || !pages || !pages.length) return Promise.resolve(false);
  return openDB().then(function(db) {
    return new Promise(function(resolve) {
      const store = db.transaction(PAGE_STORE, "readonly").objectStore(PAGE_STORE);
      let left = pages.length;
      let ok = true;
      pages.forEach(function(p) {
        const req = store.get(bitmapKey(fileId, p.pdfPageNum || p.pageNum, cachedRenderScale));
        req.onsuccess = function() {
          if (!req.result) ok = false;
          if (--left === 0) resolve(ok);
        };
        req.onerror = function() { resolve(false); };
      });
    });
  }).catch(function() { return false; });
}

function rememberLocalFile(fileId) {
  if (!fileId || String(fileId).indexOf("local_") === 0) return Promise.resolve(false);
  return openDB().then(function(db) {
    return new Promise(function(resolve) {
      const tx = db.transaction([PAGE_STORE, PDF_STORE], "readwrite");
      const pages = tx.objectStore(PAGE_STORE);
      const pdfs = tx.objectStore(PDF_STORE);
      const getLru = pages.get("__lru__");
      getLru.onsuccess = function() {
        let list = Array.isArray(getLru.result) ? getLru.result.filter(function(id) { return id !== fileId; }) : [];
        list.unshift(fileId);
        const removed = list.slice(MAX_LOCAL_FILES);
        list = list.slice(0, MAX_LOCAL_FILES);
        pages.put(list, "__lru__");
        removed.forEach(function(id) { pdfs.delete(id); });
        if (!removed.length) return;
        const cursorReq = pages.openCursor();
        cursorReq.onsuccess = function() {
          const cursor = cursorReq.result;
          if (!cursor) return;
          const key = String(cursor.key);
          for (let i = 0; i < removed.length; i++) {
            if (key.indexOf(removed[i] + "|") === 0) {
              cursor.delete();
              break;
            }
          }
          cursor.continue();
        };
      };
      tx.oncomplete = function() { resolve(true); };
      tx.onerror = function() { resolve(false); };
    });
  }).catch(function() { return false; });
}

async function compressManifest(manifest) {
  try {
    const jsonStr = JSON.stringify(manifest);
    const stream = new Blob([jsonStr]).stream().pipeThrough(new CompressionStream("gzip"));
    const buffer = await new Response(stream).arrayBuffer();
    const bytes = new Uint8Array(buffer);
    
    let binary = "";
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return "GZ:" + btoa(binary);
  } catch (e) {
    console.warn("Lỗi nén Gzip, fallback sang JSON thô:", e);
    return JSON.stringify(manifest);
  }
}

async function decompressManifest(dataString) {
  if (!dataString || typeof dataString !== "string") return dataString;
  const trimmed = dataString.trim();
  
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }

  try {
    const rawB64 = trimmed.startsWith("GZ:") ? trimmed.slice(3) : trimmed;
    const binaryStr = atob(rawB64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    const jsonText = await new Response(stream).text();
    return JSON.parse(jsonText);
  } catch (e) {
    console.error("Lỗi giải nén Gzip:", e);
    return JSON.parse(dataString);
  }
}

function startBackgroundKeepAlive() {
  try {
    const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtxClass) return;

    if (!bgAudioCtx) {
      bgAudioCtx = new AudioCtxClass();
      const buffer = bgAudioCtx.createBuffer(1, bgAudioCtx.sampleRate, bgAudioCtx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        data[i] = (Math.random() * 2 - 1) * 0.00002;
      }
      bgSourceNode = bgAudioCtx.createBufferSource();
      bgSourceNode.buffer = buffer;
      bgSourceNode.loop = true;
      bgSourceNode.connect(bgAudioCtx.destination);
      bgSourceNode.start();
    }
    
    if (bgAudioCtx.state === "suspended") {
      bgAudioCtx.resume().catch(() => {});
    }
  } catch (e) {}
}

function stopBackgroundKeepAlive() {
  try {
    if (bgAudioCtx && bgAudioCtx.state === "running") {
      bgAudioCtx.suspend();
    }
  } catch (e) {}
}

function showLoading(msg) {
  document.getElementById("loading-text").textContent = msg;
  document.getElementById("loading-overlay").style.display = "flex";
}

function hideLoading() {
  document.getElementById("loading-overlay").style.display = "none";
  stopBackgroundKeepAlive();
}

function setAntiExitGuard(enable) {
  if (enable) {
    window.onbeforeunload = function(e) {
      e.preventDefault();
      return (e.returnValue = "Hệ thống đang số hóa tài liệu. Bạn có chắc muốn rời đi?");
    };
  } else {
    window.onbeforeunload = null;
  }
}

function updateProcessProgress(percent, stageText, isSuccess = false) {
  const box = document.getElementById("proc-progress-box");
  const fill = document.getElementById("proc-bar-fill");
  const txtStage = document.getElementById("proc-stage-text");
  const txtPercent = document.getElementById("proc-percent-text");

  if (!box || !fill) return;
  box.style.display = "flex";

  const p = Math.max(0, Math.min(100, Math.round(percent)));
  fill.style.width = p + "%";
  txtPercent.textContent = p + "%";
  txtStage.textContent = stageText;

  if (isSuccess) {
    fill.classList.add("success");
    txtPercent.style.color = "#00e676";
    txtStage.textContent = "✔ " + stageText;
    setAntiExitGuard(false);
    setTimeout(() => {
      box.style.display = "none";
      fill.classList.remove("success");
      txtPercent.style.color = "#FFBA08";
    }, 2500);
  }
}