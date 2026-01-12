// server/utils/extractText.js
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
// nếu sau này có đọc .docx thì mới cần mammoth
// const mammoth = require('mammoth');

async function extractTextFromAbsolutePath(absolutePath) {
    if (!absolutePath) {
        throw new Error('File path is missing');
    }

    console.log('[extractText] Reading:', absolutePath);

    const ext = path.extname(absolutePath).toLowerCase();

    if (ext === '.pdf') {
        const buffer = await fs.promises.readFile(absolutePath);
        const data = await pdfParse(buffer);
        return data.text || '';
    }

    // fallback: đọc text thuần cho file khác
    const buffer = await fs.promises.readFile(absolutePath);
    return buffer.toString('utf8');
}

module.exports = { extractTextFromAbsolutePath };
