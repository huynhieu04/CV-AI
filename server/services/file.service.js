// server/services/file.service.js
const CvFile = require('../models/cv-file.model');

async function saveCvFile(file) {
    if (!file) throw new Error('File is missing');

    // file.path = đường dẫn tuyệt đối do multer tạo ra
    const cvFileDoc = await CvFile.create({
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        absolutePath: file.path,
    });

    return cvFileDoc;
}

module.exports = { saveCvFile };
