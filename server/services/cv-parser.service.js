const Candidate = require("../models/candidate.model");
const { extractTextFromAbsolutePath } = require("../utils/extractText");
const { extractCvProfileByGemini } = require("./cv-extract-ai.service");

/* fallback basic */
function extractEmailFromText(text) {
    const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
    const match = String(text || "").match(emailRegex);
    return match ? match[0].trim() : "";
}

function extractPhoneFromText(text) {
    const t = String(text || "");
    const phoneRegex =
        /(\+?\s?84\s?)?(0\d{9,10})|(\+?\d{1,3}[\s.-]?\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{3,4})/;
    const match = t.match(phoneRegex);
    if (!match) return "";
    return String(match[0]).replace(/\s+/g, " ").trim();
}

async function parseCvFromPath(absolutePath, cvFileId) {
    // 1) Extract raw text
    const rawText = await extractTextFromAbsolutePath(absolutePath);

    // 2) Gemini auto extract profile
    const ai = await extractCvProfileByGemini(rawText);

    // 3) Fallback nếu thiếu email/phone
    const email = ai.email || extractEmailFromText(rawText);
    const phone = ai.phone || extractPhoneFromText(rawText);
    const fullName = ai.fullName || "Candidate from CV";

    // 4) Save candidate (create)
    const candidate = await Candidate.create({
        fullName,
        email,
        phone,
        skills: ai.skills || [],
        experienceText: ai.experienceText || "",
        education: ai.educationText || "",
        languages: ai.languages || [],
        rawText,
        cvFile: cvFileId,
        matchResult: null,
    });

    return {
        text: rawText,     // ✅ giữ field text như controller đang dùng
        rawText: rawText,  // ✅ thêm rawText cho rõ ràng
        candidate,
    };
}

module.exports = { parseCvFromPath };
