function paintBitmapBlob(canvas, blob, targetPdfPage, renderScale) {
  return createImageBitmap(blob).then(function(bmp) {
    if (!canvas.isConnected || isZooming) {
      if (bmp.close) bmp.close();
      return;
    }
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.dataset.renderedScale = String(renderScale);
    canvas.getContext("2d").drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
  });
}

let jumpScrollTimer = null;

function jumpToPageNumber(pageNum, isSmooth = true) {
  if (!currentManifest || !currentManifest.pages.length) return;
  const vp = document.getElementById("viewport-container");
  const total = currentManifest.pages.length;
  const targetIndex = Math.max(0, Math.min(total - 1, (parseInt(pageNum, 10) || 1) - 1));
  const targetPageObj = currentManifest.pages[targetIndex];
  if (!targetPageObj || !vp) return;

  const el = document.getElementById("page-wrapper-" + targetPageObj.pageNum);
  if (!el) return;

  let destTop = Math.max(0, el.offsetTop - 25);
  if (targetIndex === total - 1) {
    destTop = Math.max(destTop, vp.scrollHeight - vp.clientHeight);
  }

  if (isSmooth && Math.abs(vp.scrollTop - destTop) >= 5) {
    scrollLock = true;
    let unlocked = false;

    function onArrive() {
      if (unlocked) return;
      unlocked = true;
      vp.removeEventListener("scrollend", onArrive);
      clearTimeout(jumpScrollTimer);
      scrollLock = false;
      renderVisiblePagesOnly();
      updateCurrentPageOnScroll();
    }

    vp.addEventListener("scrollend", onArrive);
    clearTimeout(jumpScrollTimer);
    jumpScrollTimer = setTimeout(onArrive, 1600);
  }

  vp.scrollTo({ top: destTop, behavior: isSmooth ? "smooth" : "auto" });
  updatePageIndicatorUI(targetIndex + 1);
}

// HÀM PHỤ: LẤY TỌA ĐỘ ĐỈNH THỰC TẾ CỦA TRANG PHỤ LỤC
function getAppendixOffsetTop() {
  if (!currentManifest || !currentManifest.pages.length) return null;
  const total = currentManifest.pages.length;
  const appendixPage = currentManifest.appendixStartPage || total;
  if (appendixPage <= 1 || appendixPage >= total) return null;

  const targetObj = currentManifest.pages[appendixPage - 1];
  const el = targetObj ? document.getElementById("page-wrapper-" + targetObj.pageNum) : null;
  return el ? Math.max(0, el.offsetTop - 25) : null;
}

// 2A. CUỘN LÊN THÔNG MINH THEO TỌA ĐỘ VẬT LÝ THỰC TẾ (KHÔNG BAO GIỜ NHẦM)
function handleSmartScrollUp() {
  if (!currentManifest || !currentManifest.pages.length) return;
  const vp = document.getElementById("viewport-container");
  const total = currentManifest.pages.length;
  const appendixPage = currentManifest.appendixStartPage || total;
  const appTop = getAppendixOffsetTop();

  // Nếu màn hình thực tế đang đứng PHÍA DƯỚI trang PL01 (hơn 30px) -> Cuộn ngược về PL01
  if (vp && appTop !== null && vp.scrollTop > appTop + 30) {
    jumpToPageNumber(appendixPage, true);
  } else {
    // Ngược lại -> Cuộn thẳng về Trang 1 (Top)
    jumpToPageNumber(1, true);
  }
}

// 2B. CUỘN XUỐNG THÔNG MINH THEO TỌA ĐỘ VẬT LÝ THỰC TẾ (KHÔNG BAO GIỜ PHÓNG NHẦM XUỐNG CUỐI)
function handleSmartScrollDown() {
  if (!currentManifest || !currentManifest.pages.length) return;
  const vp = document.getElementById("viewport-container");
  const total = currentManifest.pages.length;
  const appendixPage = currentManifest.appendixStartPage || total;
  const appTop = getAppendixOffsetTop();

  // Nếu màn hình thực tế đang đứng PHÍA TRÊN trang PL01 (cách trên 30px) -> Cuộn đúng tới PL01
  if (vp && appTop !== null && vp.scrollTop < appTop - 30) {
    jumpToPageNumber(appendixPage, true);
  } else {
    // Nếu màn hình đã đứng tại hoặc qua PL01 -> Cuộn xuống trang cuối cùng (Bottom)
    jumpToPageNumber(total, true);
  }
}

// 3. TỰ ĐỘNG ĐỔI GHI CHÚ (Top <-> PL01 <-> Bottom) VÀ ẨN/HIỆN NÚT THEO VỊ TRÍ CUỘN
function updatePageIndicatorUI(pNum) {
  const input = document.getElementById("jump-page-input");
  if (input && document.activeElement !== input) {
    input.value = pNum;
  }
  const num = parseInt(pNum, 10) || 1;
  const total = currentManifest ? currentManifest.pages.length : 1;
  const appendixPage = currentManifest ? (currentManifest.appendixStartPage || total) : total;

  const btnTop = document.getElementById("btn-scroll-top");
  const btnBottom = document.getElementById("btn-scroll-bottom");

  // Điều khiển nút Cuộn Lên (︽):
  if (btnTop) {
    if (num <= 1) {
      btnTop.classList.add("is-hidden");
    } else {
      btnTop.classList.remove("is-hidden");
      if (appendixPage > 1 && appendixPage < total && num > appendixPage) {
        btnTop.setAttribute("data-tip", "PL01");
      } else {
        btnTop.setAttribute("data-tip", "Top");
      }
    }
  }

  // Điều khiển nút Cuộn Xuống (︾):
  if (btnBottom) {
    if (num >= total) {
      btnBottom.classList.add("is-hidden");
    } else {
      btnBottom.classList.remove("is-hidden");
      if (appendixPage < total && num < appendixPage) {
        btnBottom.setAttribute("data-tip", "PL01");
      } else {
        btnBottom.setAttribute("data-tip", "Bottom");
      }
    }
  }
}

function toggleSidebar() {
  const sidebar = document.getElementById("sidebar");
  const backdrop = document.getElementById("sidebar-backdrop");
  if (!sidebar || !backdrop) return;
  sidebar.classList.toggle("active");
  backdrop.classList.toggle("active");
}

window.onload = function() {
  setupHandToolPanning();
  setupCtrlWheelZoom();
  setupTouchPinchZoom();
  setupLocalUpload();
  setupSmartClipboardCopy();

  showLoading("ĐANG TẢI DANH MỤC...");
  google.script.run
    .withSuccessHandler(function(res) {
      hideLoading();
      if (res && res.targetFolderId) {
        currentTargetFolderId = res.targetFolderId;
      }
      renderSidebarFiles(res.files);
    })
    .withFailureHandler(function(err) {
      hideLoading();
      alert("Lỗi tải folder: " + err.message);
    })
    .getInitialData();
};

function copyShareLink() {
  if (!currentFileId || currentFileId.startsWith("local_")) {
    alert("Vui lòng đợi tài liệu đồng bộ xong lên Google Drive trước khi lấy link!");
    return;
  }

  const slashes = String.fromCharCode(47, 47);
  const driveUrl = "https:" + slashes + "drive.google.com/file/d/" + currentFileId + "/preview";
  const shareBtn = document.getElementById("btn-share-link");

  navigator.clipboard.writeText(driveUrl).then(() => {
    if (shareBtn) {
      const oldHtml = shareBtn.innerHTML;
      const oldTip = shareBtn.getAttribute("data-tip");

      shareBtn.innerHTML = '<i class="bi bi-check2" style="font-size: 13px; color: #00e676;"></i>';
      shareBtn.setAttribute("data-tip", "Copied Drive Link!");

      setTimeout(() => { 
        shareBtn.innerHTML = oldHtml;
        shareBtn.setAttribute("data-tip", oldTip);
      }, 1500);
    }
  }).catch(() => {
    prompt("Copy link Google Drive:", driveUrl);
  });

  google.script.run.makeFilePublicAndGetLink(currentFileId);
}

// 3. TỐI ƯU KÉO TRANG SIÊU MƯỢT (KHỬ ĐỘ TRỄ INP BẰNG requestAnimationFrame)
function setupHandToolPanning() {
  const vp = document.getElementById("viewport-container");
  if (!vp) return;

  let isPanTicking = false;
  let targetScrollLeft = 0;
  let targetScrollTop = 0;

  vp.addEventListener("pointerdown", function(e) {
    if (e.pointerType === "touch") return; 
    if (e.button !== 0 || e.target.closest(".search-box-wrap") || e.target.closest(".prv-tools")) return;
    
    // Nếu click trúng chữ thì nhường quyền bôi đen copy
    if (e.target.classList.contains("text-overlay-item")) {
      return;
    }

    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
    }

    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    scrollLeftStart = vp.scrollLeft;
    scrollTopStart = vp.scrollTop;
    vp.setPointerCapture(e.pointerId);
    vp.classList.add("grabbing");
  });

  vp.addEventListener("pointermove", function(e) {
    if (!isDragging) return;
    e.preventDefault();

    // Tính toán tọa độ đích
    targetScrollLeft = scrollLeftStart - (e.clientX - startX);
    targetScrollTop = scrollTopStart - (e.clientY - startY);

    // Chỉ cập nhật vị trí cuộn đồng bộ với khung hình GPU (60fps/120fps)
    if (!isPanTicking) {
      isPanTicking = true;
      requestAnimationFrame(function() {
        if (isDragging) {
          vp.scrollLeft = targetScrollLeft;
          vp.scrollTop = targetScrollTop;
        }
        isPanTicking = false;
      });
    }
  });

  const stopDrag = function(e) {
    if (!isDragging) return;
    isDragging = false;
    isPanTicking = false;
    try { vp.releasePointerCapture(e.pointerId); } catch(err) {}
    vp.classList.remove("grabbing");
  };

  vp.addEventListener("pointerup", stopDrag);
  vp.addEventListener("pointercancel", stopDrag);
}

// CHUẨN HÓA KHOẢNG TRẮNG DẤU CÂU VÀ ĐÓNG/MỞ NGOẶC KHI COPY
function cleanTypographySpacing(str) {
  if (!str) return "";
  return str
    .replace(/\s+([,;.:?!])/g, "$1")
    .replace(/([(\[{“‘])\s+/g, "$1")
    .replace(/\s+([)\]}”’])/g, "$1")
    .replace(/"\s+([^"\n]+?)\s+"/g, '"$1"')
    .replace(/(^|[\s(\[{])"\s+(\S)/g, '$1"$2')
    .replace(/(\S)\s+"(?=[\s)\]},;.:?!]|$)/g, '$1"')
    .replace(/[^\S\r\n]+/g, " ")
    .trim();
}

function setupSmartClipboardCopy() {
  document.addEventListener("copy", function(e) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;

    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA")) return;

    const container = document.getElementById("viewport-container");
    if (!container) return;

    const range = sel.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer) && container !== range.commonAncestorContainer) return;

    const fragment = range.cloneContents();
    const spans = Array.from(fragment.querySelectorAll(".text-overlay-item"));

    if (spans.length > 1) {
      e.preventDefault();

      let resultText = "";
      let prevTop = null;
      let prevText = "";

      spans.forEach((span, idx) => {
        const text = span.textContent.trim();
        if (!text) return;

        const currentTop = parseFloat(span.style.top) || 0;

        if (idx === 0) {
          resultText += text;
        } else {
          const isNewLine = Math.abs(currentTop - prevTop) > 0.8;
          if (isNewLine) {
            resultText += "\n" + text;
          } else {
            const noSpaceBefore = /^[,;.:?!)}\]”’]/.test(text);
            const noSpaceAfterPrev = /[(\[{“‘"]$/.test(prevText);

            if (noSpaceBefore || noSpaceAfterPrev) {
              resultText += text;
            } else {
              resultText += " " + text;
            }
          }
        }
        prevTop = currentTop;
        prevText = text;
      });

      resultText = cleanTypographySpacing(resultText);

      if (e.clipboardData) {
        e.clipboardData.setData("text/plain", resultText);
      }
    }
  });
}

function setupTouchPinchZoom() {
  const vp = document.getElementById("viewport-container");
  let initialDist = 0;
  let initialScale = 1.0;

  vp.addEventListener("touchstart", function(e) {
    if (e.touches.length === 2) {
      initialDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      initialScale = currentScale;
    }
  }, { passive: true });

  vp.addEventListener("touchmove", function(e) {
    if (e.touches.length === 2 && initialDist > 0) {
      e.preventDefault();
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const factor = dist / initialDist;
      const targetScale = Math.min(3.0, Math.max(0.5, initialScale * factor));
      const delta = targetScale - currentScale;
      if (Math.abs(delta) >= 0.05) {
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        zoomChange(delta, midX, midY);
      }
    }
  }, { passive: false });

  vp.addEventListener("touchend", function(e) {
    if (e.touches.length < 2) initialDist = 0;
  }, { passive: true });
}

function setupLocalUpload() {
  const zone = document.getElementById("upload-zone");
  const input = document.getElementById("local-file-input");

  zone.addEventListener("dragover", e => { e.preventDefault(); zone.classList.add("dragover"); });
  zone.addEventListener("dragleave", e => { e.preventDefault(); zone.classList.remove("dragover"); });
  zone.addEventListener("drop", e => {
    e.preventDefault(); zone.classList.remove("dragover");
    if (e.dataTransfer.files.length > 0) handleLocalFile(e.dataTransfer.files[0]);
  });
  input.addEventListener("change", e => {
    if (e.target.files.length > 0) handleLocalFile(e.target.files[0]);
    input.value = ""; 
  });
}

function handleLocalFile(file) {
  startBackgroundKeepAlive();
  if (file.type !== "application/pdf") {
    alert("Chỉ hỗ trợ tập tin định dạng PDF!");
    return;
  }

  const fakeFileId = "local_" + Date.now();
  currentFileName = file.name;
  currentFileSizeMB = file.size / (1024 * 1024);
  
  processAndOptimizeFileJIT(fakeFileId, file);
}

function renderSidebarFiles(files) {
  const container = document.getElementById("file-list");
  container.innerHTML = "";
  if (!files || !files.length) return;

  files.forEach(function(f) {
    const item = document.createElement("div");
    item.className = "file-item";
    item.onclick = function() {
      startBackgroundKeepAlive();
      const mb = parseFloat(f.size) || 0;
      loadFile(f.id, f.name, mb, f.isProcessed, f.jsonId);
    };

    const nameEl = document.createElement("div");
    nameEl.style.marginBottom = "3px";
    nameEl.style.fontSize = "7px";
    nameEl.textContent = f.name;

    const sizeEl = document.createElement("div");
    sizeEl.style.color = f.isProcessed ? "#00e676" : "#8fa0b3";
    sizeEl.style.fontSize = "6px";
    sizeEl.textContent = f.size;

    item.appendChild(nameEl);
    item.appendChild(sizeEl);
    container.appendChild(item);
  });
}

function updateSidebarItemProcessed(fileId, jsonSizeStr) {
  const items = document.querySelectorAll(".file-item");
  items.forEach(function(item) {
    if (item.textContent.includes(currentFileName)) {
      const sizeEl = item.children[1];
      if (sizeEl) {
        sizeEl.textContent = jsonSizeStr + " (Đã số hóa)";
        sizeEl.style.color = "#00e676";
      }
    }
  });
}

async function loadFile(fileId, fileName, sizeMB, isProcessed, jsonId) {
  if (currentFileId === fileId) return;
  if (window.innerWidth <= 768) {
    document.getElementById("sidebar").classList.remove("active");
    document.getElementById("sidebar-backdrop").classList.remove("active");
  }

  currentSessionEpoch++;
  const myEpoch = currentSessionEpoch;

  if (activeFetchAbortController) {
    activeFetchAbortController.abort();
    activeFetchAbortController = null;
  }
  activeFetchAbortController = new AbortController();

  if (globalTesseractScheduler) {
    const oldScheduler = globalTesseractScheduler;
    globalTesseractScheduler = null;
    tesseractPreloadPromise = null;
    oldScheduler.terminate().catch(() => {});
  }

  if (currentPdfDoc) {
    currentPdfDoc.destroy();
    currentPdfDoc = null;
  }

  currentFileId = fileId;
  currentFileName = fileName;
  currentFileSizeMB = (sizeMB !== undefined) ? sizeMB : 0;
  document.getElementById("prv-file-name").textContent = fileName;
  clearSearchState();
  const inp = document.getElementById("jump-page-input");
  if (inp) inp.value = "1";
  
  document.querySelectorAll(".file-item").forEach(function(el) {
    el.classList.toggle("active", el.textContent.includes(fileName));
  });

  const ramCached = getSessionCache(fileId);
  if (ramCached) {
    currentManifest = ramCached;
    renderSlicedDocument();
    return;
  }

  const cached = await getLocalManifest(fileId);
  if (cached) {
    putSessionCache(fileId, cached);
    currentManifest = cached;
    renderSlicedDocument();
    return;
  }

  showLoading("ĐANG NẠP TÀI LIỆU...");
  checkDriveCacheWithRetry(fileId, fileName, 1);
}

function handlePageJumpKey(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    jumpToPageNumber(e.target.value);
    e.target.blur();
  }
}

// CỜ KIỂM SOÁT NHỊP QUÉT MÀN HÌNH
let isScrollTicking = false;

// 1. TỐI ƯU CUỘN MƯỢT: KHỬ HOÀN TOÀN LAYOUT THRASHING BẰNG requestAnimationFrame
function updateCurrentPageOnScroll() {
  if (isScrollTicking || scrollLock || !currentManifest || !currentManifest.pages.length) return;
  isScrollTicking = true;

  requestAnimationFrame(function() {
    isScrollTicking = false;
    const container = document.getElementById("viewport-container");
    if (!container) return;

    const total = currentManifest.pages.length;

    // Chốt chặn đỉnh và đáy tuyệt đối
    if (container.scrollTop <= 20) {
      updatePageIndicatorUI(1);
      return;
    }
    if (container.scrollTop + container.clientHeight >= container.scrollHeight - 20) {
      updatePageIndicatorUI(total);
      return;
    }

    // ĐO THEO VÙNG ĐỌC MẮT (1/4 PHÍA TRÊN MÀN HÌNH) THAY VÌ TÂM GIỮA -> KHÔNG BAO GIỜ LỌT SANG TRANG 19
    const focusLine = container.scrollTop + Math.min(200, container.clientHeight * 0.25);
    const wrappers = container.children;

    for (let i = 0; i < wrappers.length; i++) {
      const el = wrappers[i];
      if (!el.classList.contains("page-wrapper")) continue;

      const top = el.offsetTop;
      const bottom = top + el.clientHeight + 35; // Bao gồm cả khoảng hở margin giữa 2 trang
      if (focusLine >= top && focusLine <= bottom) {
        updatePageIndicatorUI(i + 1);
        break;
      }
    }
  });
}

function buildTextLayerForWrapper(wrapper) {
  if (!wrapper || !currentManifest || !currentManifest.pages) return;
  if (wrapper.querySelector(".text-layer")) return;

  const idx = parseInt(wrapper.dataset.idx, 10);
  const p = !isNaN(idx)
    ? currentManifest.pages[idx]
    : currentManifest.pages.find(item => String(item.pageNum) === String(wrapper.dataset.page));

  if (!p || !p.textItems || p.textItems.length === 0) return;

  const txtLayer = document.createElement("div");
  txtLayer.className = "text-layer";
  let txtHtml = "";
  const items = p.textItems;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const str = Array.isArray(it) ? it[0] : (it.str || "");
    if (!str) continue;

    const x = Array.isArray(it) ? it[1] : it.x;
    const y = Array.isArray(it) ? it[2] : it.y;
    const w = Array.isArray(it) ? it[3] : it.w;
    const h = Array.isArray(it) ? it[4] : it.h;

    const leftPct = (x / p.width) * 100;
    const topPct = ((p.height - y - h) / p.height) * 100;
    const widthPct = (w / p.width) * 100;
    const heightPct = (h / p.height) * 100;
    const fontSize = Math.max(8, Math.round(h * 0.88 * 10) / 10);

    const safeText = str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    txtHtml += `<span class="text-overlay-item" style="left:${leftPct}%; top:${topPct}%; width:${widthPct}%; height:${heightPct}%; font-size:calc(${fontSize}px * var(--doc-scale));">${safeText}</span>`;
  }

  txtLayer.innerHTML = txtHtml;
  wrapper.appendChild(txtLayer);
}

function removeTextLayerFromWrapper(wrapper) {
  if (!wrapper) return;
  const txtLayer = wrapper.querySelector(".text-layer");
  if (txtLayer) txtLayer.remove();
}

function createPageWrapperElement(p, idx) {
  const pageWrapper = document.createElement("div");
  pageWrapper.id = "page-wrapper-" + p.pageNum;
  pageWrapper.className = "page-wrapper";
  pageWrapper.dataset.page = p.pageNum;
  pageWrapper.dataset.pdfPage = p.pdfPageNum || p.pageNum;
  pageWrapper.dataset.rotation = p.rotation || 0;
  if (idx !== undefined) pageWrapper.dataset.idx = idx;

  pageWrapper.style.width = "calc(" + p.width + "px * var(--doc-scale))";
  pageWrapper.style.height = "calc(" + p.height + "px * var(--doc-scale))";

  const canvas = document.createElement("canvas");
  canvas.className = "page-img";
  canvas.dataset.page = p.pageNum;
  canvas.dataset.pdfPage = p.pdfPageNum || p.pageNum;
  pageWrapper.appendChild(canvas);

  return pageWrapper;
}

function cancelAllPageRenders() {
  sharpenToken++;
  if (typeof activeRenderTasks === "undefined") return;
  activeRenderTasks.forEach(function(entry) {
    try { if (entry && entry.task) entry.task.cancel(); } catch (e) {}
  });
  activeRenderTasks.clear();
}

function findZoomAnchor(vp, clientX, clientY) {
  const nodes = vp.querySelectorAll(".page-wrapper");
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const r = nodes[i].getBoundingClientRect();
    let dist = 0;
    if (clientY < r.top) dist = r.top - clientY;
    else if (clientY > r.bottom) dist = clientY - r.bottom;
    if (dist < bestDist) {
      bestDist = dist;
      best = { el: nodes[i], rect: r };
      if (dist === 0) break;
    }
  }
  if (!best) return null;
  const r = best.rect;
  return {
    el: best.el,
    fx: Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width))),
    fy: Math.min(1, Math.max(0, (clientY - r.top) / Math.max(1, r.height)))
  };
}

async function renderSlicedDocument(targetPage = null) {
  if (!currentManifest) return;
  const container = document.getElementById("viewport-container");
  if (!container) return;

  if (pageObserver) pageObserver.disconnect();

  if (window.innerWidth <= 768 && currentManifest.pages && currentManifest.pages[0]) {
    const availableWidth = window.innerWidth - 16;
    const basePageWidth = currentManifest.pages[0].width;
    if (basePageWidth > 0) {
      currentScale = Math.min(1.0, Math.max(0.4, Math.round((availableWidth / basePageWidth) * 100) / 100));
    }
  }

  document.getElementById("zoom-text").textContent = Math.round(currentScale * 100) + "%";
  container.style.setProperty("--doc-scale", String(currentScale));
  cachedRenderScale = currentScale;
  rememberLocalFile(currentFileId);

  const totalPages = currentManifest.pages.length;
  document.getElementById("total-pages-text").textContent = "/ " + totalPages;
  document.getElementById("page-indicator").style.display = totalPages > 0 ? "flex" : "none";

  const fragment = document.createDocumentFragment();
  for (let idx = 0; idx < totalPages; idx++) {
    fragment.appendChild(createPageWrapperElement(currentManifest.pages[idx], idx));
  }

  const jumpInp = document.getElementById("jump-page-input");
  const initialPage = targetPage !== null ? targetPage : ((jumpInp ? parseInt(jumpInp.value, 10) : 1) || 1);
  const firstWrapper = fragment.querySelector("#page-wrapper-" + initialPage) || fragment.children[0];

  if (firstWrapper) {
    const firstCanvas = firstWrapper.querySelector("canvas.page-img");
    const firstPdfPage = parseInt(firstWrapper.dataset.pdfPage || firstWrapper.dataset.page, 10);
    const cachedBlob = await getPageBitmap(currentFileId, firstPdfPage, cachedRenderScale);
    if (cachedBlob && firstCanvas) {
      const bmp = await createImageBitmap(cachedBlob);
      firstCanvas.width = bmp.width;
      firstCanvas.height = bmp.height;
      firstCanvas.dataset.renderedScale = String(cachedRenderScale);
      firstCanvas.getContext("2d").drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
    }
    buildTextLayerForWrapper(firstWrapper);
  }

  if (container.replaceChildren) {
    container.replaceChildren(fragment);
  } else {
    container.innerHTML = "";
    container.appendChild(fragment);
  }

  if (firstWrapper) {
    const firstCanvas = firstWrapper.querySelector("canvas.page-img");
    const firstPdfPage = parseInt(firstWrapper.dataset.pdfPage || firstWrapper.dataset.page, 10);
    if (firstCanvas && !firstCanvas.dataset.renderedScale) {
      await renderPageToCanvas(firstCanvas, firstPdfPage);
    }
  }

  hideLoading();
  jumpToPageNumber(initialPage, false);

  const wrappers = Array.from(container.querySelectorAll(".page-wrapper"));
  pageObserver = new IntersectionObserver((entries) => {
    if (isZooming || scrollLock) return;
    entries.forEach(entry => {
      const wrapper = entry.target;
      const canvas = wrapper.querySelector("canvas.page-img");
      if (!canvas) return;
      const targetPdfPage = parseInt(wrapper.dataset.pdfPage || wrapper.dataset.page, 10);

      if (entry.isIntersecting) {
        buildTextLayerForWrapper(wrapper);
        if (!scalesEqual(canvas.dataset.renderedScale, currentScale)) {
          renderPageToCanvas(canvas, targetPdfPage);
        }
      } else {
        if (wrapper.dataset.page !== "1") {
          removeTextLayerFromWrapper(wrapper);
          if (canvas.dataset.renderedScale) {
            canvas.width = 1;
            canvas.height = 1;
            delete canvas.dataset.renderedScale;
          }
        }
      }
    });
  }, { root: container, rootMargin: "1600px 0px" });

  wrappers.forEach(el => pageObserver.observe(el));
  container.removeEventListener("scroll", updateCurrentPageOnScroll);
  container.addEventListener("scroll", updateCurrentPageOnScroll, { passive: true });
}

function setupCtrlWheelZoom() {
  const vp = document.getElementById("viewport-container");
  vp.addEventListener("wheel", function(e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= vp.clientHeight;
    const step = Math.max(-0.25, Math.min(0.25, -dy * 0.0015));
    if (Math.abs(step) < 0.004) return;
    zoomChange(step, e.clientX, e.clientY);
  }, { passive: false });
}

function renderVisiblePagesOnly() {
  if (!currentManifest || isZooming || scrollLock) return;
  const vp = document.getElementById("viewport-container");
  if (!vp) return;

  const vpRect = vp.getBoundingClientRect();
  const jobs = [];

  document.querySelectorAll(".page-wrapper").forEach(wrapper => {
    const r = wrapper.getBoundingClientRect();
    const isNearView = (r.bottom >= vpRect.top - 1200 && r.top <= vpRect.bottom + 1200);
    const canvas = wrapper.querySelector("canvas.page-img");
    if (!canvas) return;
    const targetPdfPage = parseInt(wrapper.dataset.pdfPage || wrapper.dataset.page, 10);

    if (isNearView) {
      buildTextLayerForWrapper(wrapper);
      if (!scalesEqual(canvas.dataset.renderedScale, currentScale)) {
        const mid = (r.top + r.bottom) / 2;
        const viewMid = (vpRect.top + vpRect.bottom) / 2;
        jobs.push({ canvas: canvas, targetPdfPage: targetPdfPage, dist: Math.abs(mid - viewMid) });
      }
    } else if (r.bottom < vpRect.top - 1800 || r.top > vpRect.bottom + 1800) {
      if (wrapper.dataset.page !== "1") {
        removeTextLayerFromWrapper(wrapper);
        if (canvas.dataset.renderedScale) {
          canvas.width = 1;
          canvas.height = 1;
          delete canvas.dataset.renderedScale;
        }
      }
    }
  });

  jobs.sort((a, b) => a.dist - b.dist);
  const myToken = ++sharpenToken;
  const scaleAtStart = currentScale;

  (async function() {
    for (let i = 0; i < jobs.length; i++) {
      if (myToken !== sharpenToken || isZooming || !scalesEqual(scaleAtStart, currentScale)) return;
      let live = jobs[i].canvas;
      if (!live.isConnected) {
        const wrap = document.getElementById("page-wrapper-" + live.dataset.page);
        live = wrap ? wrap.querySelector("canvas.page-img") : null;
      }
      if (!live || scalesEqual(live.dataset.renderedScale, currentScale)) continue;
      await renderPageToCanvas(live, jobs[i].targetPdfPage, scaleAtStart);
    }
  })();
}

function zoomChange(delta, pointerX, pointerY) {
  if (!currentManifest) return;
  const vp = document.getElementById("viewport-container");
  const rect = vp.getBoundingClientRect();
  const px = (pointerX !== undefined) ? pointerX : (rect.left + rect.width / 2);
  const py = (pointerY !== undefined) ? pointerY : (rect.top + rect.height / 2);
  const prevScale = currentScale;
  const nextScale = Math.min(2.5, Math.max(0.4, Math.round((prevScale + delta) * 1000) / 1000));
  if (Math.abs(nextScale - prevScale) < 0.001) return;

  const anchor = findZoomAnchor(vp, px, py);

  cancelAllPageRenders();
  isZooming = true;
  currentScale = nextScale;
  vp.style.setProperty("--doc-scale", String(currentScale));
  document.getElementById("zoom-text").textContent = Math.round(currentScale * 100) + "%";

  if (anchor && anchor.el) {
    const r2 = anchor.el.getBoundingClientRect();
    vp.scrollLeft += (r2.left + anchor.fx * r2.width) - px;
    vp.scrollTop += (r2.top + anchor.fy * r2.height) - py;
  }

  clearTimeout(zoomDebounceTimer);
  zoomDebounceTimer = setTimeout(function() {
    isZooming = false;
    renderVisiblePagesOnly();
  }, 220);
}

function resetZoom() {
  if (!currentManifest) return;
  const vp = document.getElementById("viewport-container");
  const rect = vp.getBoundingClientRect();
  zoomChange(1.0 - currentScale, rect.left + rect.width / 2, rect.top + rect.height / 2);
}

function webpToJpegData(webpDataUrl) {
  return new Promise((resolve, reject) => {
    if (!webpDataUrl) {
      reject(new Error("Dữ liệu ảnh WebP không tồn tại"));
      return;
    }
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      const pxW = img.naturalWidth || img.width;
      const pxH = img.naturalHeight || img.height;
      c.width = pxW;
      c.height = pxH;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, pxW, pxH);
      ctx.drawImage(img, 0, 0);
      c.toBlob((blob) => {
        if (!blob) {
          reject(new Error("Lỗi tạo Blob JPEG"));
          return;
        }
        blob.arrayBuffer().then(buf => {
          resolve({ pxW: pxW, pxH: pxH, bytes: new Uint8Array(buf) });
        });
      }, "image/jpeg", 0.88);
    };
    img.onerror = () => reject(new Error("Lỗi giải mã ảnh WebP sang JPEG"));
    img.src = webpDataUrl;
  });
}

function createPdfBlobFromJpegs(jpegPages) {
  const chunks = [];
  const offsets = [];
  let currentOffset = 0;

  function write(strOrUint8) {
    let chunk;
    if (typeof strOrUint8 === "string") {
      chunk = new TextEncoder().encode(strOrUint8);
    } else {
      chunk = strOrUint8;
    }
    chunks.push(chunk);
    currentOffset += chunk.length;
  }

  write("%PDF-1.4\r\n%\xFF\xFF\xFF\xFF\r\n");

  const numPages = jpegPages.length;
  const totalObjects = 2 + numPages * 3;

  offsets[1] = currentOffset;
  write("1 0 obj\r\n<< /Type /Catalog /Pages 2 0 R >>\r\nendobj\r\n");

  offsets[2] = currentOffset;
  const kids = [];
  for (let i = 0; i < numPages; i++) {
    kids.push((3 + i * 3) + " 0 R");
  }
  write(`2 0 obj\r\n<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${numPages} >>\r\nendobj\r\n`);

  for (let i = 0; i < numPages; i++) {
    const p = jpegPages[i];
    const pageObjNum = 3 + i * 3;
    const imgObjNum = 4 + i * 3;
    const contentObjNum = 5 + i * 3;

    offsets[pageObjNum] = currentOffset;
    write(`${pageObjNum} 0 obj\r\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.width} ${p.height}] /Resources << /XObject << /Im1 ${imgObjNum} 0 R >> >> /Contents ${contentObjNum} 0 R >>\r\nendobj\r\n`);

    offsets[imgObjNum] = currentOffset;
    write(`${imgObjNum} 0 obj\r\n<< /Type /XObject /Subtype /Image /Width ${p.pxW} /Height ${p.pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.bytes.length} >>\r\nstream\r\n`);
    write(p.bytes);
    write("\r\nendstream\r\nendobj\r\n");

    const contentStream = `q ${p.width} 0 0 ${p.height} 0 0 cm /Im1 Do Q\r\n`;
    const contentLen = new TextEncoder().encode(contentStream).length;

    offsets[contentObjNum] = currentOffset;
    write(`${contentObjNum} 0 obj\r\n<< /Length ${contentLen} >>\r\nstream\r\n${contentStream}endstream\r\nendobj\r\n`);
  }

  const xrefOffset = currentOffset;
  write(`xref\r\n0 ${totalObjects + 1}\r\n0000000000 65535 f \r\n`);
  for (let i = 1; i <= totalObjects; i++) {
    const offStr = String(offsets[i]).padStart(10, "0");
    write(`${offStr} 00000 n \r\n`);
  }

  write(`trailer\r\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\r\nstartxref\r\n${xrefOffset}\r\n%%EOF\r\n`);

  return new Blob(chunks, { type: "application/pdf" });
}

async function downloadPdfFromJson() {
  if (!currentFileId) {
    alert("Vui lòng mở một tài liệu trước khi tải về!");
    return;
  }

  showLoading("ĐANG XUẤT FILE GỐC TỪ GOOGLE DRIVE...");
  try {
    const pdfData = await fetchPdfDirectOrFallback(currentFileId);
    if (!pdfData || pdfData.byteLength === 0) {
      throw new Error("Không thể trích xuất dữ liệu nhị phân của file gốc.");
    }

    const blob = new Blob([pdfData], { type: "application/pdf" });
    const downloadUrl = URL.createObjectURL(blob);

    let downloadName = currentFileName || "TaiLieu_Drive.pdf";
    if (!downloadName.toLowerCase().endsWith(".pdf")) {
      downloadName += ".pdf";
    }

    const a = document.createElement("a");
    a.style.display = "none";
    a.href = downloadUrl;
    a.download = downloadName;
    document.body.appendChild(a);
    a.click();

    setTimeout(() => {
      if (document.body.contains(a)) document.body.removeChild(a);
      URL.revokeObjectURL(downloadUrl);
    }, 2000);

    hideLoading();
  } catch (err) {
    hideLoading();
    console.error("Lỗi xuất file PDF:", err);
    if (currentFileId && !currentFileId.startsWith("local_")) {
      const slashes = String.fromCharCode(47, 47);
      window.open("https:" + slashes + "drive.google.com/uc?export=download&id=" + currentFileId, "_blank");
    } else {
      alert("Không thể tải file PDF: " + (err.message || err));
    }
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function renderPageToCanvas(canvas, targetPdfPage, lockedScale) {
  if (!canvas || isZooming) return Promise.resolve();
  const myEpoch = currentSessionEpoch;
  const renderScale = (lockedScale == null) ? currentScale : lockedScale;

  const prev = activeRenderTasks.get(targetPdfPage);
  if (prev) {
    if (scalesEqual(prev.scale, renderScale)) return prev.promise;
    try { if (prev.task) prev.task.cancel(); } catch (e) {}
    activeRenderTasks.delete(targetPdfPage);
  }

  let resolveJob;
  const promise = new Promise(function(resolve) { resolveJob = resolve; });
  const job = { task: null, scale: renderScale, promise: promise };
  activeRenderTasks.set(targetPdfPage, job);

  function finishJob() {
    if (activeRenderTasks.get(targetPdfPage) === job) activeRenderTasks.delete(targetPdfPage);
    resolveJob();
  }

  function ensurePdf() {
    if (currentPdfDoc) return Promise.resolve(currentPdfDoc);
    const pending = renderPageToCanvas._pdfPromise;
    if (pending && pending.epoch === currentSessionEpoch) return pending;
    const epoch = currentSessionEpoch;
    const fileId = currentFileId;
    const p = fetchPdfDirectOrFallback(fileId).then(function(data) {
      return pdfjsLib.getDocument({ data: data }).promise;
    }).then(function(pdf) {
      if (epoch !== currentSessionEpoch) {
        try { pdf.destroy(); } catch (e) {}
        throw new Error("ABORTED");
      }
      currentPdfDoc = pdf;
      return pdf;
    }).catch(function(err) {
      if (renderPageToCanvas._pdfPromise === p) renderPageToCanvas._pdfPromise = null;
      throw err;
    });
    p.epoch = epoch;
    renderPageToCanvas._pdfPromise = p;
    return p;
  }

  function drawPdfPage() {
    ensurePdf().then(function(pdf) {
      return pdf.getPage(targetPdfPage);
    }).then(function(page) {
      if (activeRenderTasks.get(targetPdfPage) !== job || myEpoch !== currentSessionEpoch || isZooming || !scalesEqual(renderScale, currentScale) || !canvas.isConnected) {
        page.cleanup();
        finishJob();
        return;
      }

      const rawDpr = window.devicePixelRatio || 1;
      const sharpMultiplier = Math.max(rawDpr, 2.0);
      let effectiveScale = renderScale * sharpMultiplier;

      if (effectiveScale > 3.0) {
        effectiveScale = Math.max(renderScale * 1.15, 3.0);
      }

      const wrapperEl = canvas.closest(".page-wrapper");
      const extraRot = parseInt((wrapperEl ? wrapperEl.dataset.rotation : "0") || "0", 10);
      const effectiveRot = (page.rotate + extraRot) % 360;

      const viewport = page.getViewport({ scale: effectiveScale, rotation: effectiveRot });
      const newW = Math.max(1, Math.floor(viewport.width));
      const newH = Math.max(1, Math.floor(viewport.height));

      const offscreenCanvas = document.createElement("canvas");
      offscreenCanvas.width = newW;
      offscreenCanvas.height = newH;
      const offCtx = offscreenCanvas.getContext("2d");
      offCtx.fillStyle = "#ffffff";
      offCtx.fillRect(0, 0, newW, newH);

      const renderTask = page.render({
        canvasContext: offCtx,
        viewport: viewport,
        intent: "display"
      });
      job.task = renderTask;

      renderTask.promise.then(function() {
        page.cleanup();
        if (activeRenderTasks.get(targetPdfPage) !== job || myEpoch !== currentSessionEpoch || isZooming || !scalesEqual(renderScale, currentScale) || !canvas.isConnected) {
          offscreenCanvas.width = 0;
          offscreenCanvas.height = 0;
          finishJob();
          return;
        }

        canvas.width = newW;
        canvas.height = newH;
        canvas.dataset.renderedScale = String(renderScale);
        canvas.getContext("2d").drawImage(offscreenCanvas, 0, 0);
        savePageBitmap(currentFileId, targetPdfPage, renderScale, canvas);

        offscreenCanvas.width = 0;
        offscreenCanvas.height = 0;
        finishJob();
      }).catch(function() {
        try { page.cleanup(); } catch (e) {}
        offscreenCanvas.width = 0;
        offscreenCanvas.height = 0;
        finishJob();
      });
    }).catch(function() {
      finishJob();
    });
  }

  getPageBitmap(currentFileId, targetPdfPage, renderScale).then(function(blob) {
    if (blob && canvas.isConnected && !isZooming && myEpoch === currentSessionEpoch && scalesEqual(renderScale, currentScale)) {
      paintBitmapBlob(canvas, blob, targetPdfPage, renderScale).then(finishJob).catch(finishJob);
      return;
    }
    drawPdfPage();
  }).catch(function() {
    drawPdfPage();
  });

  return promise;
}

// BỘ ĐIỀU KHIỂN TOÀN MÀN HÌNH (FULLSCREEN MODE)
function toggleFullScreen() {
  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    const docEl = document.documentElement;
    if (docEl.requestFullscreen) {
      docEl.requestFullscreen().catch(() => {});
    } else if (docEl.webkitRequestFullscreen) {
      docEl.webkitRequestFullscreen();
    }
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  }
}

function updateFullscreenIconState() {
  const btn = document.getElementById("btn-fullscreen");
  if (!btn) return;
  const icon = btn.querySelector("i");
  const isFull = !!(document.fullscreenElement || document.webkitFullscreenElement);
  if (icon) {
    icon.className = isFull ? "bi bi-fullscreen-exit" : "bi bi-fullscreen";
  }
  btn.setAttribute("data-tip", isFull ? "Exit full screen (Esc)" : "Full screen");
}

document.addEventListener("fullscreenchange", updateFullscreenIconState);
document.addEventListener("webkitfullscreenchange", updateFullscreenIconState);