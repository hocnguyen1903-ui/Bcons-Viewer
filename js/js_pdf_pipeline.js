// =========================================================================
// 1. CÁC HÀM GIAO TIẾP VỚI GOOGLE DRIVE VÀ CLOUD VISION
// =========================================================================

async function uploadPdfDirectToDrive(fileObj, fileName, folderId) {
  const token = await getDriveTokenAsync();
  const metadata = {
    name: fileName,
    parents: [folderId]
  };
  const boundary = "-------BconsBoundary" + Date.now();
  const delimiter = "\r\n--" + boundary + "\r\n";
  const close_delim = "\r\n--" + boundary + "--";

  const metadataPart = delimiter +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata);

  const fileData = await fileObj.arrayBuffer();
  const preBytes = new TextEncoder().encode(metadataPart + delimiter + 'Content-Type: application/pdf\r\n\r\n');
  const postBytes = new TextEncoder().encode(close_delim);

  const bodyBlob = new Blob([preBytes, fileData, postBytes]);
  const slashes = String.fromCharCode(47, 47);
  const uploadUrl = "https:" + slashes + "www.googleapis.com/upload/drive/v3/files?uploadType=multipart";

  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "multipart/related; boundary=" + boundary
    },
    body: bodyBlob
  });

  if (!res.ok) throw new Error("Lỗi tải lên Drive HTTP " + res.status);
  const data = await res.json();
  return {
    success: true,
    fileId: data.id,
    name: data.name,
    size: (fileObj.size / (1024 * 1024)).toFixed(2) + " MB"
  };
}

/**
 * Thêm file đã số hóa hoàn chỉnh vào danh sách Sidebar
 */
function addUploadedFileToSidebar(fileId, fileName, sizeStr) {
  const container = document.getElementById("file-list");
  if (!container) return;
  const item = document.createElement("div");
  item.className = "file-item";
  item.onclick = function() {
    startBackgroundKeepAlive();
    loadFile(fileId, fileName, parseFloat(sizeStr), true, fileId);
  };
  item.innerHTML = `<div style="margin-bottom:3px; font-size:7px;">${fileName}</div><div style="color:#00e676; font-size:6px;">${sizeStr} (Đã số hóa)</div>`;
  container.insertBefore(item, container.firstChild);
}

function getDriveTokenAsync() {
  if (cachedDriveToken && Date.now() < driveTokenExpiresAt) {
    return Promise.resolve(cachedDriveToken);
  }
  return new Promise(function(resolve, reject) {
    google.script.run
      .withSuccessHandler(function(token) {
        cachedDriveToken = token;
        driveTokenExpiresAt = Date.now() + (45 * 60 * 1000);
        resolve(token);
      })
      .withFailureHandler(reject)
      .getDriveAccessToken();
  });
}

function invalidateDriveToken() {
  cachedDriveToken = null;
  driveTokenExpiresAt = 0;
}

async function fetchDriveMedia(fileId, token) {
  const slashes = String.fromCharCode(47, 47);
  const mediaUrl = "https:" + slashes + "www.googleapis.com/drive/v3/files/" + fileId + "?alt=media&supportsAllDrives=true";
  return fetch(mediaUrl, {
    method: "GET",
    headers: { "Authorization": "Bearer " + token },
    signal: activeFetchAbortController ? activeFetchAbortController.signal : undefined
  });
}

async function fetchPdfByByteRanges(fileId) {
  const token = await getDriveTokenAsync();
  const signal = activeFetchAbortController ? activeFetchAbortController.signal : undefined;
  const slashes = String.fromCharCode(47, 47);
  const metaUrl = "https:" + slashes + "www.googleapis.com/drive/v3/files/" + fileId + "?fields=size&supportsAllDrives=true";
  
  const meta = await fetch(metaUrl, {
    headers: { Authorization: "Bearer " + token },
    signal: signal
  });
  if (!meta.ok) throw new Error("META HTTP " + meta.status);
  const info = await meta.json();
  const size = Number(info.size || 0);
  if (!size) throw new Error("Không rõ kích thước PDF");

  const SLICE = 2 * 1024 * 1024;
  const total = Math.ceil(size / SLICE);
  const chunks = [];
  for (let start = 0, n = 1; start < size; start += SLICE, n++) {
    if (signal && signal.aborted) throw new Error("ABORTED_BY_USER");
    const end = Math.min(size, start + SLICE) - 1;
    showLoading("ĐANG NẠP TÀI LIỆU...");
    const res = await fetch("https:" + slashes + "www.googleapis.com/drive/v3/files/" + fileId + "?alt=media&supportsAllDrives=true", {
      headers: {
        Authorization: "Bearer " + token,
        Range: "bytes=" + start + "-" + end
      },
      signal: signal
    });
    if (!(res.status === 206 || res.status === 200)) throw new Error("HTTP " + res.status);
    const buf = await res.arrayBuffer();
    if (res.status === 200 && buf.byteLength > (end - start + 1)) return buf;
    chunks.push(new Uint8Array(buf));
  }

  const out = new Uint8Array(size);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    out.set(chunks[i], offset);
    offset += chunks[i].length;
  }
  return out.buffer;
}

async function fetchPdfDirectOrFallback(fileId) {
  try {
    const localBuf = await getLocalPdfBinary(fileId);
    if (localBuf) return localBuf;
  } catch (e) {}

  try {
    showLoading("ĐANG NẠP TÀI LIỆU...");
    let token = await getDriveTokenAsync();
    let res = await fetchDriveMedia(fileId, token);
    if (res.status === 401 || res.status === 403) {
      invalidateDriveToken();
      token = await getDriveTokenAsync();
      res = await fetchDriveMedia(fileId, token);
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
    const buf = await res.arrayBuffer();
    saveLocalPdfBinary(fileId, buf).catch(() => {});
    return buf;
  } catch (err) {
    if (err.name === "AbortError" || err.message === "ABORTED_BY_USER") {
      throw new Error("ABORTED_BY_USER");
    }
    console.warn("CDN lỗi, tải theo dải byte:", err);
    try {
      const ranged = await fetchPdfByByteRanges(fileId);
      saveLocalPdfBinary(fileId, ranged).catch(() => {});
      return ranged;
    } catch (rangeErr) {
      if (rangeErr.name === "AbortError" || rangeErr.message === "ABORTED_BY_USER") {
        throw new Error("ABORTED_BY_USER");
      }
      console.warn("Chuyển làn dự phòng Apps Script:", rangeErr);
      const fallbackBuf = await fetchPdfBase64Adaptive(fileId);
      saveLocalPdfBinary(fileId, fallbackBuf).catch(() => {});
      return fallbackBuf;
    }
  }
}

function fetchPdfBase64Adaptive(fileId) {
  showLoading("ĐANG NẠP TÀI LIỆU...");
  if (currentFileSizeMB <= LARGE_FILE_THRESHOLD_MB) {
    return new Promise(function(resolve, reject) {
      google.script.run
        .withSuccessHandler(function(b64) {
          const raw = atob(b64);
          const bytes = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
          resolve(bytes.buffer);
        })
        .withFailureHandler(reject)
        .getPdfBase64Fast(fileId);
    });
  }
  return new Promise(function(resolve, reject) {
    let fullB64 = "";
    function loadChunk(idx) {
      google.script.run
        .withSuccessHandler(function(res) {
          fullB64 += res.chunk;
          if (idx + 1 < res.totalChunks) {
            loadChunk(idx + 1);
          } else {
            const raw = atob(fullB64);
            const bytes = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
            resolve(bytes.buffer);
          }
        })
        .withFailureHandler(reject)
        .getPdfBase64Chunk(fileId, idx);
    }
    loadChunk(0);
  });
}

function fetchDriveCacheAdaptive(fileId, fileName) {
  return new Promise(function(resolve, reject) {
    google.script.run
      .withSuccessHandler(function(res) {
        if (res && res.found) {
          resolve(res);
        } else {
          resolve(res || { found: false, isOptimizing: false });
        }
      })
      .withFailureHandler(reject)
      .getDriveCacheFast(fileId, fileName);
  });
}

function saveDriveCacheAdaptive(fileId, fileName, jsonString) {
  return new Promise(function(resolve, reject) {
    google.script.run
      .withSuccessHandler(function(res) { resolve(res); })
      .withFailureHandler(function(err) { console.error("Lỗi lưu cache tên hợp đồng:", err); resolve(); })
      .saveDriveCacheFast(fileId, fileName, jsonString);
  });
}

function callVisionApiBatchAsync(imagesBase64Array) {
  return new Promise(function(resolve, reject) {
    google.script.run
      .withSuccessHandler(resolve)
      .withFailureHandler(reject)
      .callCloudVisionApiBatch(imagesBase64Array);
  });
}

function initTesseractPoolAsync(workerCount) {
  if (globalTesseractScheduler) {
    return Promise.resolve(globalTesseractScheduler);
  }
  if (tesseractPreloadPromise) {
    return tesseractPreloadPromise;
  }

  tesseractPreloadPromise = new Promise(async function(resolve) {
    try {
      if (!window.Tesseract) {
        await new Promise(function(res, rej) {
          const s = document.createElement("script");
          s.src = "https:" + String.fromCharCode(47, 47) + "cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
          s.onload = res;
          s.onerror = rej;
          document.head.appendChild(s);
        });
      }

      const scheduler = Tesseract.createScheduler();
      const promises = Array.from({ length: workerCount }, async function() {
        const worker = await Tesseract.createWorker("vie");
        await worker.setParameters({ 
          tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT,
          user_defined_dpi: "160"
        });
        scheduler.addWorker(worker);
      });

      await Promise.all(promises);
      globalTesseractScheduler = scheduler;
      resolve(scheduler);
    } catch (e) {
      console.error("Lỗi Preload Tesseract:", e);
      tesseractPreloadPromise = null;
      resolve(null);
    }
  });

  return tesseractPreloadPromise;
}

function isScannedPageBlank(srcCanvas) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  if (w === 0 || h === 0) return true;

  const sw = 120;
  const sh = 160;
  const sampleCanvas = document.createElement("canvas");
  sampleCanvas.width = sw;
  sampleCanvas.height = sh;
  const sCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
  sCtx.drawImage(srcCanvas, 0, 0, sw, sh);

  const imgData = sCtx.getImageData(0, 0, sw, sh);
  const d = imgData.data;

  const marginX = Math.round(sw * 0.05);
  const marginY = Math.round(sh * 0.05);

  let darkPixels = 0;
  let totalExamined = 0;

  for (let y = marginY; y < sh - marginY; y++) {
    for (let x = marginX; x < sw - marginX; x++) {
      const idx = (y * sw + x) * 4;
      const gray = d[idx] * 0.299 + d[idx + 1] * 0.587 + d[idx + 2] * 0.114;
      if (gray < 180) {
        darkPixels++;
      }
      totalExamined++;
    }
  }

  const inkRatio = (darkPixels / Math.max(1, totalExamined)) * 100;
  return inkRatio < 0.12;
}

function round1(num) { 
  return Math.round(num * 10) / 10; 
}


// =========================================================================
// 2. HÀM TẠO FILE PDF SẠCH (CẮT BỎ 100% TRANG TRẮNG & XOAY CHUẨN)
// =========================================================================

let pdfLibLoadPromise = null;

/**
 * Cơ chế tự động nạp thư viện PDF-LIB ngầm (có dự phòng 2 CDN chống chặn)
 */
async function ensurePdfLibLoaded() {
  if (window.PDFLib) return window.PDFLib;
  if (pdfLibLoadPromise) return pdfLibLoadPromise;

  pdfLibLoadPromise = new Promise(function(resolve, reject) {
    const slashes = String.fromCharCode(47, 47);
    const s = document.createElement("script");
    s.src = "https:" + slashes + "cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js";
    s.onload = function() {
      if (window.PDFLib) resolve(window.PDFLib);
      else reject(new Error("Không tìm thấy window.PDFLib."));
    };
    s.onerror = function() {
      // CDN dự phòng 2 nếu Cloudflare bị chặn mạng
      const s2 = document.createElement("script");
      s2.src = "https:" + slashes + "cdn.jsdelivr.net/npm/pdf-lib/dist/pdf-lib.min.js";
      s2.onload = function() {
        if (window.PDFLib) resolve(window.PDFLib);
        else reject(new Error("Không tìm thấy window.PDFLib sau khi thử CDN phụ."));
      };
      s2.onerror = function() {
        pdfLibLoadPromise = null;
        reject(new Error("Không thể tải thư viện PDF-LIB từ cả 2 CDN."));
      };
      document.head.appendChild(s2);
    };
    document.head.appendChild(s);
  });

  return pdfLibLoadPromise;
}

/**
 * Đóng gói file PDF sạch hoàn chỉnh: loại bỏ trang trắng và xoay đúng góc
 */
async function buildCleanPdf(rawPdfData, manifest, skippedBlankPages) {
  await ensurePdfLibLoaded();

  const { PDFDocument, degrees } = window.PDFLib;
  const srcDoc = await PDFDocument.load(rawPdfData);
  const cleanDoc = await PDFDocument.create();

  // Chỉ lấy các trang hợp lệ không phải trang trắng
  const validIndices = [];
  for (let pNum = 1; pNum <= srcDoc.getPageCount(); pNum++) {
    if (!skippedBlankPages.has(pNum)) {
      validIndices.push(pNum - 1);
    }
  }

  if (validIndices.length === 0) {
    return rawPdfData;
  }

  const copiedPages = await cleanDoc.copyPages(srcDoc, validIndices);
  copiedPages.forEach((page, idx) => {
    const originalPageNum = validIndices[idx] + 1;
    const targetPData = manifest.pages.find(p => p.pageNum === originalPageNum);
    const extraRot = targetPData ? (targetPData.rotation || 0) : 0;
    
    // Ghi góc xoay cứng trực tiếp vào cấu trúc trang PDF
    if (extraRot !== 0) {
      const currentAngle = page.getRotation().angle || 0;
      page.setRotation(degrees((currentAngle + extraRot) % 360));
    }
    cleanDoc.addPage(page);
  });

  return await cleanDoc.save();
}


// =========================================================================
// 3. CÁC HÀM CON CHUYÊN TRÁCH QUÉT AI
// =========================================================================

async function scanAppendixWithVision(pdf, ctx, canvas, skippedBlankPages) {
  const SCAN_AI_SCALE = 2.15;
  const VISION_PAGE_BUDGET = 16;
  let visionApiPages = 0;
  let appendixStartPage = -1;
  const appendixPages = [];

  for (let pTop = pdf.numPages; pTop >= 1; pTop -= 2) {
    if (visionApiPages >= VISION_PAGE_BUDGET) break;

    const candidateNums = [pTop];
    if (pTop - 1 >= 1) candidateNums.push(pTop - 1);

    updateProcessProgress(30, `[2/4] AI SCAN PHỤ LỤC: TRANG ${candidateNums.join(" & ")}/${pdf.numPages}...`);
    const pairData = [];

    for (let i = 0; i < candidateNums.length; i++) {
      const pNum = candidateNums[i];
      const page = await pdf.getPage(pNum);
      const viewport = page.getViewport({ scale: SCAN_AI_SCALE });

      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: ctx, viewport: viewport, intent: 'print' }).promise;
      page.cleanup();

      // Bỏ qua trang trắng
      if (isScannedPageBlank(canvas)) {
        skippedBlankPages.add(pNum);
        continue; 
      }
      if (visionApiPages >= VISION_PAGE_BUDGET) break;

      const aiJpegImg = canvas.toDataURL("image/jpeg", 0.88);
      const pageData = {
        pageNum: pNum,
        pdfPageNum: pNum,
        width: round1(viewport.width / SCAN_AI_SCALE),
        height: round1(viewport.height / SCAN_AI_SCALE),
        textItems: []
      };

      pairData.push({ pNum: pNum, pageData: pageData, jpeg: aiJpegImg });
      visionApiPages++;
    }

    if (pairData.length > 0) {
      const visionResults = await callVisionApiBatchAsync(pairData.map(item => item.jpeg));

      let foundBreak = false;
      for (let i = 0; i < pairData.length; i++) {
        const item = pairData[i];
        const visionRes = visionResults[i];

        if (visionRes) {
          const rot = visionRes.rotation || 0;
          item.pageData.rotation = rot;

          if (rot === 90 || rot === 270) {
            const origW = item.pageData.width;
            item.pageData.width = item.pageData.height;
            item.pageData.height = origW;
          }

          if (visionRes.words && visionRes.words.length > 0) {
            item.pageData.textItems = visionRes.words.map(function(w) {
              return [
                w.str.trim(),
                round1(w.x / SCAN_AI_SCALE),
                round1(item.pageData.height - ((w.y + w.h) / SCAN_AI_SCALE)),
                round1(w.w / SCAN_AI_SCALE),
                round1(w.h / SCAN_AI_SCALE)
              ];
            });
          }
        }

        appendixPages.push(item.pageData);
        const aiRawText = item.pageData.textItems.map(it => it[0] || "").join(" ");
        const aiClean = cleanNaturalToken(aiRawText);

        if (aiClean.includes("phuluchopdongso01") || aiClean.includes("phuluchopdongso1")) {
          appendixStartPage = item.pNum;
          foundBreak = true;
          break;
        }
      }
      if (foundBreak) break;
    }
  }

  if (appendixStartPage === -1) {
    appendixStartPage = pdf.numPages + 1;
  }

  return { appendixStartPage, appendixPages };
}

async function ocrContractBody(pdf, ctx, canvas, contractEndPage, preScannedPages, skippedBlankPages, poolPromise, maxWorkers) {
  const CONTRACT_SCALE = 1.50;
  const TESSERACT_OCR_SCALE = 1.50; 
  const scheduler = await poolPromise;
  const bodyPages = [];
  const ocrJobsQueue = [];

  for (let pageNum = 1; pageNum <= contractEndPage; pageNum++) {
    if (preScannedPages.has(pageNum)) continue;

    const isFirst3Pages = pageNum <= 3;
    const is5PagesBeforeLast = (pageNum >= Math.max(4, contractEndPage - 5)) && (pageNum < contractEndPage);
    const isSkippedOcr = isFirst3Pages || is5PagesBeforeLast;

    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: CONTRACT_SCALE });

    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: ctx, viewport: viewport, intent: 'print' }).promise;

    // Bỏ qua trang trắng
    if (isScannedPageBlank(canvas)) {
      skippedBlankPages.add(pageNum);
      page.cleanup();
      continue;
    }

    const pageData = {
      pageNum: pageNum,
      pdfPageNum: pageNum,
      width: round1(viewport.width / CONTRACT_SCALE),
      height: round1(viewport.height / CONTRACT_SCALE),
      textItems: []
    };
    bodyPages.push(pageData);

    if (isSkippedOcr) {
      page.cleanup();
    } else if (scheduler) {
      const ocrViewport = page.getViewport({ scale: TESSERACT_OCR_SCALE });
      const ocrCanvas = document.createElement("canvas");
      ocrCanvas.width = ocrViewport.width;
      ocrCanvas.height = ocrViewport.height;
      const ocrCtx = ocrCanvas.getContext("2d", { willReadFrequently: true });

      ocrCtx.filter = "grayscale(100%) contrast(160%) brightness(105%)";
      await page.render({ canvasContext: ocrCtx, viewport: ocrViewport, intent: 'print' }).promise;
      page.cleanup();
      ocrCtx.filter = "none";

      ocrJobsQueue.push({ pageNum: pageNum, pageData: pageData, canvas: ocrCanvas });
    }
  }

  let queueCursor = 0;
  let ocrCompletedCount = 0;
  const totalOcrCount = ocrJobsQueue.length;

  async function ocrWorkerThread() {
    while (queueCursor < ocrJobsQueue.length) {
      const task = ocrJobsQueue[queueCursor++];
      const res = await scheduler.addJob("recognize", task.canvas);
      task.canvas.width = 0;
      task.canvas.height = 0;
      ocrCompletedCount++;

      const ocrPercent = 45 + Math.round((ocrCompletedCount / Math.max(1, totalOcrCount)) * 43);
      updateProcessProgress(ocrPercent, `[3/4] TESSERACT ĐỌC THÂN HĐ: TRANG ${ocrCompletedCount}/${totalOcrCount}...`);

      if (res && res.data && res.data.words) {
        task.pageData.textItems = res.data.words
          .filter(function(w) {
            const txt = w.text ? w.text.trim() : "";
            return txt.length > 0 && !/^[|\[\]\-_=~+*<>:;.\\\/]+$/.test(txt);
          })
          .map(function(w) {
            const b = w.bbox;
            return [
              w.text.trim(),
              round1(b.x0 / TESSERACT_OCR_SCALE),
              round1(task.pageData.height - (b.y1 / TESSERACT_OCR_SCALE)),
              round1((b.x1 - b.x0) / TESSERACT_OCR_SCALE),
              round1((b.y1 - b.y0) / TESSERACT_OCR_SCALE)
            ];
          });
      }
    }
  }

  const activeWorkers = Array.from({ length: Math.min(maxWorkers, ocrJobsQueue.length || 1) }, () => ocrWorkerThread());
  await Promise.all(activeWorkers);

  return bodyPages;
}


// =========================================================================
// 4. HÀM CHÍNH ĐIỀU PHỐI QUY TRÌNH (PIPELINE CONTROLLER)
// =========================================================================

function processAndOptimizeFileJIT(fileId, localFileObj = null) {
  const isLocalUpload = (localFileObj !== null);
  const uploadFileName = currentFileName;
  setAntiExitGuard(true);

  // BỘ ĐO THỜI GIAN TỪNG GIAI ĐOẠN (ĐỘ CHÍNH XÁC MILI-GIÂY)
  const timeStartTotal = performance.now();
  let timeStageLap = timeStartTotal;

  const getLapTime = () => {
    const now = performance.now();
    const duration = ((now - timeStageLap) / 1000).toFixed(2);
    timeStageLap = now;
    return duration + "s";
  };

  const getTotalTime = () => ((performance.now() - timeStartTotal) / 1000).toFixed(2) + "s";

  console.log(`%c======================================================`, "color: #FFBA08; font-weight: bold;");
  console.log(`%c🚀 BẮT ĐẦU SỐ HÓA: "${uploadFileName}"`, "color: #FFBA08; font-size: 13px; font-weight: bold;");
  console.log(`%c======================================================`, "color: #FFBA08; font-weight: bold;");

  updateProcessProgress(5, "[1/4] KHỞI TẠO TÀI LIỆU...");

  const maxWorkers = Math.min(2, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
  const poolPromise = initTesseractPoolAsync(maxWorkers);

  const dataSourcePromise = isLocalUpload
    ? localFileObj.arrayBuffer() 
    : fetchPdfDirectOrFallback(fileId);

  dataSourcePromise
    .then(async function(rawPdfData) {
      let canvas = null;
      let ctx = null;
      try {
        const preservedPdfData = rawPdfData.slice(0);
        const pdf = await pdfjsLib.getDocument({ data: rawPdfData }).promise;

        console.log(
          `%c[1/4] KHỞI TẠO XONG: Nạp thành công file nhị phân (${pdf.numPages} trang, ${(rawPdfData.byteLength / 1048576).toFixed(2)} MB) ⏱ Thời gian: ${getLapTime()}`,
          "color: #00e5ff; font-weight: bold;"
        );

        const manifest = { fileId: fileId, numPages: pdf.numPages, pages: [] };
        canvas = document.createElement("canvas");
        ctx = canvas.getContext("2d", { willReadFrequently: true });
        const skippedBlankPages = new Set();

        // GIAI ĐOẠN 2: Quét phụ lục bằng Vision API (Lọc trang trắng, xoay ngang)
        updateProcessProgress(20, "[2/4] AI CLOUD ĐANG QUÉT PHỤ LỤC & BẢNG KHỐI LƯỢNG...");
        const { appendixStartPage, appendixPages } = await scanAppendixWithVision(pdf, ctx, canvas, skippedBlankPages);
        manifest.pages.push(...appendixPages);
        manifest.appendixStartPage = appendixStartPage;
        manifest.sourcePageCount = pdf.numPages;

        const rotatedCount = appendixPages.filter(p => p.rotation && p.rotation !== 0).length;
        console.log(
          `%c[2/4] VISION AI XONG: Tìm thấy Phụ lục từ Trang ${appendixStartPage} (Đã xoay: ${rotatedCount} trang, Bỏ trắng: ${skippedBlankPages.size} trang) ⏱ Thời gian: ${getLapTime()}`,
          "color: #69f0ae; font-weight: bold;"
        );

        // GIAI ĐOẠN 3: Đọc chữ thân hợp đồng bằng Tesseract
        updateProcessProgress(45, "[3/4] BẮT ĐẦU ĐỌC CHỮ THÂN HỢP ĐỒNG...");
        const contractEndPage = appendixStartPage - 1;
        const preScannedPages = new Set(appendixPages.map(p => p.pageNum));
        const bodyPages = await ocrContractBody(pdf, ctx, canvas, contractEndPage, preScannedPages, skippedBlankPages, poolPromise, maxWorkers);
        manifest.pages.push(...bodyPages);

        manifest.pages.sort((a, b) => a.pageNum - b.pageNum);

        console.log(
          `%c[3/4] TESSERACT OCR XONG: Đã đọc xong thân HĐ (${bodyPages.length} trang) ⏱ Thời gian: ${getLapTime()}`,
          "color: #ffd740; font-weight: bold;"
        );

        // GIAI ĐOẠN 4: ĐÓNG GÓI BẢN PDF SẠCH (ĐÃ CẮT TRANG TRẮNG & XOAY CHUẨN)
        updateProcessProgress(86, "[4/4] ĐANG ĐÓNG GÓI FILE PDF SẠCH (CẮT TRANG TRẮNG & XOAY)...");
        let cleanPdfBytes = preservedPdfData;
        try {
          cleanPdfBytes = await buildCleanPdf(preservedPdfData, manifest, skippedBlankPages);
        } catch (eClean) {
          console.warn("Lỗi đóng gói PDFLib, fallback sang file gốc:", eClean);
        }

        // Chuẩn hóa lại số thứ tự trang trong manifest khớp với file PDF sạch mới
        const cleanPages = [];
        let cleanAppendixPage = -1;

        // Tìm vị trí trang phụ lục thực tế mà Cloud Vision đã quét trúng (tính theo file sạch)
        const foundIdx = manifest.pages.findIndex(p => p.pageNum >= appendixStartPage);
        if (foundIdx !== -1) {
          cleanAppendixPage = foundIdx + 1; // Số thứ tự trang sạch chuẩn 100%
        }

        manifest.pages.forEach((p, idx) => {
          cleanPages.push({
            pageNum: idx + 1,
            pdfPageNum: idx + 1,
            width: p.width,
            height: p.height,
            rotation: 0,
            textItems: p.textItems
          });
        });

        manifest.pages = cleanPages;
        manifest.numPages = cleanPages.length;
        // Gán đúng số trang mà Cloud Vision đã xác định vào manifest
        manifest.appendixStartPage = (cleanAppendixPage !== -1) ? cleanAppendixPage : cleanPages.length;

        // ĐẨY BẢN PDF SẠCH LÊN GOOGLE DRIVE
        updateProcessProgress(90, "[4/4] ĐẨY BẢN PDF SẠCH LÊN GOOGLE DRIVE...");
        let finalDriveFileId = fileId;
        let finalSizeStr = (cleanPdfBytes.byteLength / (1024 * 1024)).toFixed(2) + " MB";

        if (isLocalUpload) {
          const cleanBlob = new Blob([cleanPdfBytes], { type: "application/pdf" });
          cleanBlob.name = uploadFileName;
          const upRes = await uploadPdfDirectToDrive(cleanBlob, uploadFileName, currentTargetFolderId);
          if (upRes && upRes.success) {
            finalDriveFileId = upRes.fileId;
            finalSizeStr = upRes.size;
            manifest.fileId = finalDriveFileId;
          }
        }

        // Lưu JSON chỉ mục lên Drive cùng thư mục với PDF sạch
        const compressedPayload = await compressManifest(manifest);
        await saveDriveCacheAdaptive(finalDriveFileId, uploadFileName, compressedPayload);
        updateSidebarItemProcessed(finalDriveFileId, "Đã lưu");

        // Lưu cố định bản PDF SẠCH và Manifest vào ổ cứng máy tính
        putSessionCache(finalDriveFileId, manifest);
        await saveLocalManifest(finalDriveFileId, manifest);
        await saveLocalPdfBinary(finalDriveFileId, cleanPdfBytes);

        // LƯU 100% ẢNH CÁC TRANG VÀO Ổ CỨNG TRƯỚC KHI BÁO 100%
        updateProcessProgress(94, "[4/4] LƯU 100% ẢNH TÀI LIỆU VÀO MÁY...");
        const cleanPdfDoc = await pdfjsLib.getDocument({ data: cleanPdfBytes.slice(0) }).promise;
        for (let pNum = 1; pNum <= cleanPdfDoc.numPages; pNum++) {
          const page = await cleanPdfDoc.getPage(pNum);
          const rawDpr = window.devicePixelRatio || 1;
          const sharpFactor = Math.max(rawDpr, 2.0);
          const effectiveScale = Math.min(cachedRenderScale * sharpFactor, 2.0);
          const vp = page.getViewport({ scale: effectiveScale });

          const bCanvas = document.createElement("canvas");
          bCanvas.width = Math.floor(vp.width);
          bCanvas.height = Math.floor(vp.height);
          const bCtx = bCanvas.getContext("2d");
          bCtx.fillStyle = "#ffffff";
          bCtx.fillRect(0, 0, bCanvas.width, bCanvas.height);
          await page.render({ canvasContext: bCtx, viewport: vp, intent: 'display' }).promise;
          page.cleanup();
          await savePageBitmap(finalDriveFileId, pNum, cachedRenderScale, bCanvas);
          bCanvas.width = 0;
          bCanvas.height = 0;
        }
        cleanPdfDoc.destroy();

        console.log(
          `%c[4/4] ĐÓNG GÓI, LƯU DRIVE & CACHE 100% XONG: Dung lượng ${finalSizeStr} ⏱ Thời gian: ${getLapTime()}`,
          "color: #e040fb; font-weight: bold;"
        );

        // CÁN ĐÍCH 100% VÀ ĐƯA VÀO THANH BÊN TRÁI
        updateProcessProgress(100, "SỐ HÓA THÀNH CÔNG - SẴN SÀNG TÌM KIẾM!", true);
        if (isLocalUpload) {
          addUploadedFileToSidebar(finalDriveFileId, uploadFileName, finalSizeStr);
        }

        pdf.destroy();

        // =====================================================================
        // BẢNG BÁO CÁO NGHIỆM THU TỔNG KẾT TỰ ĐỘNG IN RA CONSOLE
        // =====================================================================
        const listBlank = Array.from(skippedBlankPages).sort((a,b) => a-b);
        const listRotated = appendixPages.filter(p => p.rotation && p.rotation !== 0).map(p => `Trang ${p.pageNum} (xoay ${p.rotation}°)`);

        console.log(`%c======================================================`, "color: #00e676; font-weight: bold;");
        console.log(`%c✔ TOÀN BỘ TIẾN TRÌNH HOÀN THÀNH XUẤT SẮC TRONG: ${getTotalTime()}`, "color: #00e676; font-size: 14px; font-weight: bold;");
        console.log(`%c======================================================`, "color: #00e676; font-weight: bold;");
        console.table({
          "Tên tài liệu": uploadFileName,
          "Tổng thời gian": getTotalTime(),
          "Tổng số trang gốc": pdf.numPages + " trang",
          "Tổng số trang sạch (sau xử lý)": cleanPages.length + " trang",
          "Các trang trắng đã loại bỏ": listBlank.length > 0 ? listBlank.join(", ") : "Không có",
          "Các trang phụ lục đã xoay ngang": listRotated.length > 0 ? listRotated.join(", ") : "Không có",
          "Dung lượng bản PDF sạch": finalSizeStr,
          "Drive File ID": finalDriveFileId,
          "Trạng thái đệm máy tính (IndexedDB)": "Đã lưu 100% (Mở lại trong 0.01s)"
        });

      } catch (err) {
        setAntiExitGuard(false);
        updateProcessProgress(0, "LỖI: " + err.message);
        console.error(`%c❌ LỖI TRONG TIẾN TRÌNH: ${err.message}`, "color: #ff1744; font-size: 13px; font-weight: bold;", err);
        setTimeout(() => { document.getElementById("proc-progress-box").style.display = "none"; }, 4000);
      } finally {
        if (canvas) {
          canvas.width = 0;
          canvas.height = 0;
        }
      }
    })
    .catch(function(err) {
      setAntiExitGuard(false);
      hideLoading();
      alert("Lỗi tải PDF: " + err.message);
      console.error(`%c❌ LỖI TẢI NHỊ PHÂN: ${err.message}`, "color: #ff1744; font-weight: bold;", err);
    });
}

function checkDriveCacheWithRetry(fileId, fileName, retryCount, busyCount) {
  const myEpoch = currentSessionEpoch;
  busyCount = busyCount || 0;

  fetchDriveCacheAdaptive(fileId, fileName)
    .then(async function(res) {
      if (myEpoch !== currentSessionEpoch) return;

      if (res && res.found) {
        currentManifest = await decompressManifest(res.data);
        if (myEpoch !== currentSessionEpoch) return;

        putSessionCache(fileId, currentManifest);
        saveLocalManifest(fileId, currentManifest);

        await renderSlicedDocument();
        return;
      }

      if (res && res.busy) {
        if (busyCount < 8) {
          setTimeout(function() {
            if (myEpoch === currentSessionEpoch) {
              checkDriveCacheWithRetry(fileId, fileName, retryCount, busyCount + 1);
            }
          }, 1500);
          return;
        }
      }

      if (res && res.isOptimizing) {
        if (retryCount <= 60) {
          setTimeout(function() {
            if (myEpoch === currentSessionEpoch) {
              checkDriveCacheWithRetry(fileId, fileName, retryCount + 1, 0);
            }
          }, 10000);
          return;
        }
      }

      processAndOptimizeFileJIT(fileId);
    })
    .catch(function() {
      if (myEpoch === currentSessionEpoch) {
        processAndOptimizeFileJIT(fileId);
      }
    });
}