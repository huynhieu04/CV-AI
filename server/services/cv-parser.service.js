// server/services/cv-parser.service.js
const { extractTextFromAbsolutePath } = require('../utils/extractText');
const Candidate = require('../models/candidate.model');

// Bắt email đầu tiên tìm được trong nội dung CV
function extractEmailFromText(text) {
    // Regex đơn giản cho email, không phân biệt hoa/thường
    const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
    const match = text && text.match(emailRegex);
    return match ? match[0] : '';
}

async function parseCvFromPath(absolutePath, cvFileId) {
    // 1. Trích xuất text từ file (PDF/Word/image đã OCR...)
    const text = await extractTextFromAbsolutePath(absolutePath);

    // 2. Lấy email thật trong CV
    const email = extractEmailFromText(text);

    // 3. Tạm thời để tên generic, sau này muốn detect tên thì làm thêm
    const fullName = 'Candidate from CV';

    // 4. Tạo candidate trong MongoDB
    const candidate = await Candidate.create({
        fullName,
        email,          // ✅ dùng email đọc từ CV, KHÔNG còn mock nữa
        skills: ['Node.js', 'MongoDB'], // bạn có thể bỏ hoặc để tạm
        rawText: text,
        cvFile: cvFileId,
        matchResult: null, // để sẵn field cho AI matching
    });

    return { text, candidate };
}

module.exports = { parseCvFromPath };
