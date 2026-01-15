// server/routes/cv.routes.js
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const cvController = require("../controllers/cv.controller");
const Setting = require("../models/setting.model");

const router = express.Router();

/**
 * ======================================================
 * 1) ENSURE UPLOAD DIRECTORY EXISTS
 * ======================================================
 * ✅ Đảm bảo thư mục uploads/cv tồn tại để multer lưu file.
 */
const uploadDir = path.join(__dirname, "..", "uploads", "cv");
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

/**
 * ======================================================
 * 2) MULTER STORAGE
 * ======================================================
 * ✅ Lưu file xuống disk và đặt tên "timestamp-originalName"
 * - replace space -> '-' để an toàn
 */
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const timestamp = Date.now();
        const safeName = file.originalname.replace(/\s+/g, "-");
        cb(null, `${timestamp}-${safeName}`);
    },
});

/**
 * ======================================================
 * 3) HELPER: DELETE UPLOADED FILE WHEN REJECTED
 * ======================================================
 *  Nếu file đã lưu mà bị chặn ở middleware sau đó,
 *    mình xóa để không rác thư mục uploads/cv.
 */
function removeUploadedFile(req) {
    try {
        if (req?.file?.path && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
    } catch (err) {
        console.warn("[cv.routes] removeUploadedFile failed:", err.message);
    }
}

/**
 * ======================================================
 * 4) HELPER: EXTENSION + MIME VALIDATION
 * ======================================================
 *  Mục tiêu: "file lạ" -> báo lỗi
 *
 * Vì người dùng có thể đổi tên file .pdf nhưng thực chất là file khác,
 * nên phải check BOTH:
 *  - Extension (đuôi file)
 *  - MIME type (file.mimetype do browser gửi)
 */
function isValidMimeByExt(ext, mimetype) {
    const mime = String(mimetype || "").toLowerCase();

    // PDF
    if (ext === ".pdf") return mime.includes("pdf");

    // Word
    if (ext === ".doc") return mime.includes("msword");
    if (ext === ".docx") {
        // docx thường có mime: application/vnd.openxmlformats-officedocument.wordprocessingml.document
        return mime.includes("officedocument") || mime.includes("word");
    }

    // Image
    if ([".jpg", ".jpeg", ".png"].includes(ext)) return mime.startsWith("image/");

    return false;
}

/**
 * ======================================================
 * 5) MULTER INSTANCE (LIMIT FILE SIZE)
 * ======================================================
 * Chỉ giới hạn dung lượng.
 *  Check định dạng mình làm ở middleware checkFileAllowed bên dưới
 */
const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

/**
 * ======================================================
 * 6) MIDDLEWARE: CHECK FILE ALLOWED (Settings + MIME)
 * ======================================================
 * ✅ Đây là "CHỐT CHẶN FILE LẠ" ở tầng ROUTE:
 *  - Check ext theo Settings (pdf/doc/image bật hay tắt)
 *  - Check MIME type khớp ext (chống đổi tên file giả)
 *  - Nếu fail -> xóa file đã upload + trả lỗi 400
 */
async function checkFileAllowed(req, res, next) {
    // Nếu không có file -> controller sẽ tự báo lỗi "Thiếu file CV"
    if (!req.file) return next();

    try {
        const ext = path.extname(req.file.originalname).toLowerCase(); // .pdf .docx ...
        const mimetype = req.file.mimetype;

        /**
         * 6.1) Load settings (nếu chưa có thì tạo default)
         */
        let config = await Setting.findOne();
        if (!config) config = await Setting.create({});

        // NOTE: bạn nên đảm bảo default allowedExtensions trong schema setting.model
        const allow = config.allowedExtensions || { pdf: true, doc: true, image: true };

        /**
         * 6.2) Check extension theo Settings
         */
        const isPdf = ext === ".pdf";
        const isDoc = ext === ".doc" || ext === ".docx";
        const isImage = [".jpg", ".jpeg", ".png"].includes(ext);

        const isAllowedBySetting =
            (isPdf && allow.pdf) || (isDoc && allow.doc) || (isImage && allow.image);

        if (!isAllowedBySetting) {
            // ❌ FILE KHÔNG ĐƯỢC PHÉP (THEO SETTINGS)
            removeUploadedFile(req);
            return res.status(400).json({
                ok: false,
                message: "Định dạng file này không được phép upload theo cấu hình Settings.",
            });
        }

        /**
         * 6.3) Check MIME matches extension
         * - Chặn trường hợp đổi tên "abc.pdf" nhưng lại là file khác
         */
        const isMimeOk = isValidMimeByExt(ext, mimetype);
        if (!isMimeOk) {
            // ❌ FILE GIẢ / MIME KHÔNG KHỚP
            removeUploadedFile(req);
            return res.status(400).json({
                ok: false,
                message: "File không đúng định dạng CV (MIME mismatch). Vui lòng upload đúng file PDF/DOCX/IMG.",
            });
        }

        // ✅ OK -> đi tiếp vào controller uploadCv
        return next();
    } catch (err) {
        console.error("[cv.routes] checkFileAllowed error:", err);
        removeUploadedFile(req);
        return res.status(500).json({
            ok: false,
            message: "Lỗi khi kiểm tra định dạng file upload.",
        });
    }
}

/**
 * ======================================================
 * 7) ROUTE: POST /api/cv/upload
 * ======================================================
 * Flow:
 * - upload.single('file')  -> multer lưu file xuống ổ cứng 
 * - checkFileAllowed       -> chặn file lạ, sai định dạng, sai MIME
 * - cvController.uploadCv  -> parse CV + match AI
 */
router.post("/upload", upload.single("file"), checkFileAllowed, cvController.uploadCv);

module.exports = router;
