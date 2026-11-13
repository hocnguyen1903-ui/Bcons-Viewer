const TEST_FOLDER_ID = "1qK7-AXau_htyfxhmllXLCp2w0dkb6d40";
const OPT_LOCK_TTL_SEC = 600;
const CHUNK_SIZE = 2500000;
const RAW_PER_CHUNK = (CHUNK_SIZE / 4) * 3;

function doGet() {
  return HtmlService.createTemplateFromFile("index")
    .evaluate()
    .setTitle("BCONS - Vision AI Document Viewer")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag("viewport", "width=device-width, initial-scale=1.0");
}

function include(filename) {
  return HtmlService.createTemplateFromFile(filename).getRawContent();
}

/**
 * Tạo tên file JSON số hóa theo tên hợp đồng để nhận biết dễ dàng trên Drive
 * Ví dụ: "HopDong_BconsCity.pdf" -> "[Số hóa] HopDong_BconsCity.json"
 */
function getJsonCacheName_(fileName) {
  const cleanBase = (fileName || "").replace(/\.pdf$/i, "").trim();
  return "[Số hóa] " + (cleanBase || "TaiLieu") + ".json";
}

/**
 * Lấy thư mục chứa file PDF (đảm bảo file JSON luôn lưu chung 1 thư mục với PDF)
 */
function getFolderForFile_(fileId) {
  try {
    if (fileId && String(fileId).indexOf("local_") !== 0) {
      const file = DriveApp.getFileById(fileId);
      const parents = file.getParents();
      if (parents.hasNext()) return parents.next();
    }
  } catch (e) {}
  return DriveApp.getFolderById(TEST_FOLDER_ID);
}

function findFileByName_(folder, name) {
  if (!name || !folder) return null;
  const files = folder.getFilesByName(name);
  while (files.hasNext()) {
    const f = files.next();
    if (!f.isTrashed()) return f;
  }
  return null;
}

function formatFileSize_(bytes) {
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / 1048576).toFixed(2) + " MB";
}

/**
 * Đọc toàn bộ danh sách hợp đồng và tự động đối chiếu file JSON số hóa cùng thư mục
 */
function getInitialData() {
  try {
    const folder = DriveApp.getFolderById(TEST_FOLDER_ID);
    const jsonByName = {};
    const pdfFiles = [];

    const files = folder.getFiles();
    while (files.hasNext()) {
      const f = files.next();
      if (f.isTrashed()) continue;
      const name = f.getName();

      // Gom toàn bộ file JSON trong cùng thư mục
      if (name.toLowerCase().endsWith(".json")) {
        const info = {
          id: f.getId(),
          size: formatFileSize_(f.getSize()),
          fullName: name
        };
        // Chuẩn hóa tên để đối chiếu: bỏ tiền tố "[Số hóa]" và đuôi ".json"
        const cleanBase = name.replace(/^\[Số hóa\]\s*/i, "").replace(/\.json$/i, "").trim().toLowerCase();
        jsonByName[cleanBase] = info;
      } else if (name.toLowerCase().endsWith(".pdf")) {
        pdfFiles.push(f);
      }
    }

    const fileList = [];
    for (let i = 0; i < pdfFiles.length; i++) {
      const f = pdfFiles[i];
      const name = f.getName();
      const cleanBase = name.replace(/\.pdf$/i, "").trim().toLowerCase();

      // Kiểm tra xem file PDF này đã có file [Số hóa] cùng tên trong thư mục chưa
      const cachedInfo = jsonByName[cleanBase] || null;

      if (cachedInfo) {
        fileList.push({
          id: f.getId(),
          name: name,
          size: cachedInfo.size + " (Đã số hóa)",
          isProcessed: true,
          jsonId: cachedInfo.id
        });
      } else {
        fileList.push({
          id: f.getId(),
          name: name,
          size: formatFileSize_(f.getSize()) + " (Chưa số hóa)",
          isProcessed: false,
          jsonId: null
        });
      }
    }

    fileList.sort(function(a, b) {
      return a.name.localeCompare(b.name, "vi");
    });

    return { files: fileList, targetFolderId: TEST_FOLDER_ID };
  } catch (e) {
    throw new Error("Lỗi truy cập Folder Drive: " + e.message);
  }
}

/**
 * Tìm nạp file cache JSON từ cùng thư mục với file PDF
 */
function getDriveCacheFast(fileId, fileName) {
  const lock = LockService.getScriptLock();
  let locked = false;
  try {
    locked = lock.tryLock(1500);
  } catch (e) {
    locked = false;
  }
  if (!locked) return { found: false, isOptimizing: false, busy: true };

  try {
    const scriptCache = CacheService.getScriptCache();
    const folder = getFolderForFile_(fileId);
    const targetJsonName = getJsonCacheName_(fileName);
    const cleanBase = (fileName || "").replace(/\.pdf$/i, "").trim();

    // 1. Tìm file chuẩn theo tên: [Số hóa] <Tên Hợp Đồng>.json
    let targetFile = findFileByName_(folder, targetJsonName);

    // 2. Tìm dự phòng trường hợp file không có tiền tố: <Tên Hợp Đồng>.json
    if (!targetFile && cleanBase) {
      targetFile = findFileByName_(folder, cleanBase + ".json");
    }

    if (targetFile) {
      scriptCache.remove("LOCK_OPT_" + fileId);
      return { found: true, isOptimizing: false, data: targetFile.getBlob().getDataAsString() };
    }

    if (scriptCache.get("LOCK_OPT_" + fileId)) {
      return { found: false, isOptimizing: true };
    }

    scriptCache.put("LOCK_OPT_" + fileId, String(Date.now()), OPT_LOCK_TTL_SEC);
    return { found: false, isOptimizing: false };
  } catch (e) {
    return { found: false, isOptimizing: false };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Lưu file cache JSON trực tiếp vào cùng thư mục với file PDF và đặt tên theo hợp đồng
 */
function saveDriveCacheFast(fileId, fileName, jsonDataString) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    throw new Error("Hệ thống bận ghi dữ liệu, vui lòng thử lại.");
  }

  const scriptCache = CacheService.getScriptCache();
  try {
    const folder = getFolderForFile_(fileId);
    const targetJsonName = getJsonCacheName_(fileName);
    let targetFile = findFileByName_(folder, targetJsonName);

    // Nếu đã có file JSON này trong thư mục -> Cập nhật nội dung mới
    if (targetFile) {
      targetFile.setContent(jsonDataString);
    } else {
      // Chưa có -> Tạo file JSON mới nằm ngay cạnh file PDF
      targetFile = folder.createFile(targetJsonName, jsonDataString, MimeType.PLAIN_TEXT);
    }

    // Dọn dẹp file cũ trùng lặp nếu có
    const cleanBase = (fileName || "").replace(/\.pdf$/i, "").trim();
    if (cleanBase) {
      const oldFiles = folder.getFilesByName(cleanBase + ".json");
      while (oldFiles.hasNext()) {
        const oldF = oldFiles.next();
        if (!oldF.isTrashed() && oldF.getId() !== targetFile.getId()) oldF.setTrashed(true);
      }
    }

    scriptCache.remove("LOCK_OPT_" + fileId);
    return { success: true, jsonId: targetFile.getId() };
  } catch (e) {
    scriptCache.remove("LOCK_OPT_" + fileId);
    throw new Error("Lỗi lưu cache: " + e.message);
  } finally {
    lock.releaseLock();
  }
}

function getDriveAccessToken() {
  return ScriptApp.getOAuthToken();
}

function makeFilePublicAndGetLink(fileId) {
  try {
    if (!fileId || String(fileId).indexOf("local_") === 0) {
      return { success: false, error: "File cục bộ chưa có trên Drive" };
    }
    const file = DriveApp.getFileById(fileId);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return {
      success: true,
      url: "https://drive.google.com/file/d/" + fileId + "/preview"
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function forceAuthorizeDrive() {
  const testFile = DriveApp.createFile("auth_permission_test.txt", "ok");
  testFile.setTrashed(true);
}

function callCloudVisionApiBatch(imagesBase64Array) {
  try {
    const apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
    if (!apiKey) throw new Error("Chưa cài API_KEY trong Script Properties!");

    const url = "https://vision.googleapis.com/v1/images:annotate?key=" + apiKey;
    const MAX_VISION_BATCH = 16;
    let allResponses = [];

    for (let i = 0; i < imagesBase64Array.length; i += MAX_VISION_BATCH) {
      const slice = imagesBase64Array.slice(i, i + MAX_VISION_BATCH);
      const requests = slice.map(function(b64) {
        return {
          image: { content: String(b64).replace(/^data:image\/\w+;base64,/, "") },
          features: [{ type: "DOCUMENT_TEXT_DETECTION" }]
        };
      });

      const res = UrlFetchApp.fetch(url, {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify({ requests: requests }),
        muteHttpExceptions: true
      });

      const resJson = JSON.parse(res.getContentText());
      if (resJson.error) throw new Error(resJson.error.message);
      if (resJson.responses) {
        allResponses = allResponses.concat(resJson.responses);
      }
    }

    return allResponses.map(function(resp) {
      if (!resp || !resp.fullTextAnnotation || !resp.fullTextAnnotation.pages) {
        return { words: [], rotation: 0 };
      }

      const pObj = resp.fullTextAnnotation.pages[0];
      const imgW = pObj.width || 0;
      const imgH = pObj.height || 0;

      // 1. BIỂU QUYẾT TÌM HƯỚNG XOAY CỦA CHỮ
      let angle0 = 0, angle90 = 0, angle180 = 0, angle270 = 0;
      const rawWords = [];

      pObj.blocks.forEach(function(b) {
        b.paragraphs.forEach(function(p) {
          p.words.forEach(function(w) {
            const str = w.symbols.map(function(s) { return s.text; }).join("");
            const v = w.boundingBox.vertices || [];
            if (v.length >= 2 && v[0] && v[1]) {
              const dx = (v[1].x || 0) - (v[0].x || 0);
              const dy = (v[1].y || 0) - (v[0].y || 0);
              if (Math.abs(dx) >= Math.abs(dy)) {
                if (dx >= 0) angle0++;
                else angle180++;
              } else {
                if (dy > 0) angle90++;
                else angle270++;
              }
            }

            let minX = null, minY = null, maxX = null, maxY = null;
            for (let i = 0; i < v.length; i++) {
              const vx = v[i].x || 0;
              const vy = v[i].y || 0;
              if (minX === null || vx < minX) minX = vx;
              if (minY === null || vy < minY) minY = vy;
              if (maxX === null || vx > maxX) maxX = vx;
              if (maxY === null || vy > maxY) maxY = vy;
            }

            rawWords.push({
              str: str,
              x: minX || 0,
              y: minY || 0,
              w: Math.max(1, (maxX || 0) - (minX || 0)),
              h: Math.max(1, (maxY || 0) - (minY || 0))
            });
          });
        });
      });

      // Xác định góc xoay chiếm đa số
      let detectedAngle = 0;
      const maxVotes = Math.max(angle0, angle90, angle180, angle270);
      if (maxVotes > 0) {
        if (maxVotes === angle90) detectedAngle = 90;
        else if (maxVotes === angle270) detectedAngle = 270;
        else if (maxVotes === angle180) detectedAngle = 180;
      }

      // Góc PDF.js cần xoay để chữ nằm ngang thuận mắt đọc
      let pdfRotation = 0;
      if (detectedAngle === 90) pdfRotation = 270;      // Chữ đọc từ trên xuống -> Xoay 270 CW
      else if (detectedAngle === 270) pdfRotation = 90;  // Chữ đọc từ dưới lên -> Xoay 90 CW
      else if (detectedAngle === 180) pdfRotation = 180;

      // 2. CHUYỂN ĐỔI TỌA ĐỘ VỀ HỆ QUY CHIẾU NẰM NGANG CHUẨN
      const correctedWords = rawWords.map(function(w) {
        let nx = w.x, ny = w.y, nw = w.w, nh = w.h;

        if (pdfRotation === 270) {
          nx = w.y;
          ny = Math.max(0, imgW - (w.x + w.w));
          nw = w.h;
          nh = w.w;
        } else if (pdfRotation === 90) {
          nx = Math.max(0, imgH - (w.y + w.h));
          ny = w.x;
          nw = w.h;
          nh = w.w;
        } else if (pdfRotation === 180) {
          nx = Math.max(0, imgW - (w.x + w.w));
          ny = Math.max(0, imgH - (w.y + w.h));
        }

        return { str: w.str, x: nx, y: ny, w: nw, h: nh };
      });

      return { words: correctedWords, rotation: pdfRotation };
    });
  } catch (e) {
    throw new Error("Lỗi Cloud Vision Batch: " + e.message);
  }
}

function getPdfBase64Fast(fileId) {
  return Utilities.base64Encode(DriveApp.getFileById(fileId).getBlob().getBytes());
}

function fetchDriveByteRange_(fileId, start, endInclusive) {
  const token = ScriptApp.getOAuthToken();
  const res = UrlFetchApp.fetch(
    "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) + "?alt=media&supportsAllDrives=true",
    {
      method: "get",
      headers: {
        Authorization: "Bearer " + token,
        Range: "bytes=" + start + "-" + endInclusive
      },
      muteHttpExceptions: true
    }
  );
  const code = res.getResponseCode();
  if (code !== 200 && code !== 206) throw new Error("Drive range HTTP " + code);
  return { code: code, bytes: res.getContent() };
}

function getPdfBase64Chunk(fileId, chunkIndex) {
  const size = DriveApp.getFileById(fileId).getSize();
  const b64Len = Math.ceil(size / 3) * 4;
  const totalChunks = Math.max(1, Math.ceil(b64Len / CHUNK_SIZE));
  const idx = Math.max(0, Number(chunkIndex) || 0);
  const rawStart = idx * RAW_PER_CHUNK;
  if (!size || rawStart >= size) return { totalChunks: totalChunks, chunk: "" };

  const rawEnd = Math.min(size, rawStart + RAW_PER_CHUNK) - 1;
  const ranged = fetchDriveByteRange_(fileId, rawStart, rawEnd);
  let bytes = ranged.bytes;
  const expect = rawEnd - rawStart + 1;
  if (ranged.code === 200 && bytes.length > expect) {
    bytes = bytes.slice(rawStart, rawEnd + 1);
  }
  return {
    totalChunks: totalChunks,
    chunk: Utilities.base64Encode(bytes).replace(/\s+/g, "")
  };
}

function uploadPdfFileToDrive(fileName, base64Data) {
  try {
    const folder = DriveApp.getFolderById(TEST_FOLDER_ID);
    const cleanName = fileName || ("BanScan_" + new Date().getTime() + ".pdf");
    const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), "application/pdf", cleanName);
    const file = folder.createFile(blob);

    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (errSharing) {
      console.warn("Chính sách bảo mật chặn setSharing:", errSharing.message);
    }

    return {
      success: true,
      fileId: file.getId(),
      name: file.getName(),
      size: (file.getSize() / (1024 * 1024)).toFixed(2) + " MB"
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * CỔNG API ĐỂ LIVE SERVER (VS CODE) & GITHUB GỌI TRỰC TIẾP VỀ GOOGLE DRIVE
 */
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    const args = body.args || [];
    let result = null;

    switch (action) {
      case "getInitialData":
        result = getInitialData();
        break;
      case "getDriveCacheFast":
        result = getDriveCacheFast(args[0], args[1]);
        break;
      case "saveDriveCacheFast":
        result = saveDriveCacheFast(args[0], args[1], args[2]);
        break;
      case "getDriveAccessToken":
        result = getDriveAccessToken();
        break;
      case "makeFilePublicAndGetLink":
        result = makeFilePublicAndGetLink(args[0]);
        break;
      case "callCloudVisionApiBatch":
        result = callCloudVisionApiBatch(args[0]);
        break;
      case "getPdfBase64Fast":
        result = getPdfBase64Fast(args[0]);
        break;
      case "getPdfBase64Chunk":
        result = getPdfBase64Chunk(args[0], args[1]);
        break;
      case "uploadPdfFileToDrive":
        result = uploadPdfFileToDrive(args[0], args[1]);
        break;
      default:
        throw new Error("Hành động không hợp lệ: " + action);
    }

    return ContentService.createTextOutput(JSON.stringify({ ok: true, data: result }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}