// server/services/cv-parser.service.js
const Candidate = require("../models/candidate.model");
const { extractTextFromAbsolutePath, normalizeExtractedText } = require("../utils/extractText");

/* =========================
   1) BASIC EXTRACTORS
   ========================= */

function extractEmailFromText(text) {
    const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
    const match = String(text || "").match(emailRegex);
    return match ? match[0].trim() : "";
}

function extractPhoneFromText(text) {
    // VN + generic: 09xx..., 03xx..., +84...
    const t = String(text || "");
    const phoneRegex =
        /(\+?\s?84\s?)?(0\d{9,10})|(\+?\d{1,3}[\s.-]?\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{3,4})/;
    const match = t.match(phoneRegex);
    if (!match) return "";
    return String(match[0]).replace(/\s+/g, " ").trim();
}

// Cắt text thành các dòng “hợp lý”
function getLines(text) {
    return String(text || "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
}

// Tên thường nằm top 1-3 dòng, không chứa email/phone, không phải title chung
function extractNameFromText(text) {
    const lines = getLines(text).slice(0, 8);

    const banned = [
        "curriculum vitae",
        "cv",
        "resume",
        "software engineer",
        "frontend",
        "backend",
        "fullstack",
        "data analyst",
        "developer",
        "engineer",
        "profile",
        "contact",
        "thông tin",
    ];

    for (const line of lines) {
        const l = line.toLowerCase();

        if (l.length < 3) continue;
        if (extractEmailFromText(line)) continue;
        if (extractPhoneFromText(line)) continue;

        if (banned.some((b) => l.includes(b))) continue;

        // Heuristic: nhiều chữ cái, ít số/ký tự
        const hasLetters = /[a-zA-ZÀ-ỹ]/.test(line);
        const hasTooManySymbols = /[@/\\|]/.test(line);
        const hasDigits = /\d/.test(line);

        if (hasLetters && !hasTooManySymbols && !hasDigits) {
            // Tránh trường hợp line quá dài
            if (line.length <= 45) return line.trim();
        }
    }

    return "Candidate from CV";
}

/* =========================
   2) SECTION SPLITTER
   ========================= */

// Nhận diện heading thường gặp (EN + VI)
const SECTION_HEADINGS = {
    skills: [
        "skills",
        "technical skills",
        "kỹ năng",
        "kỹ năng chuyên môn",
        "skill",
        "core skills",
        "tools",
        "technologies",
    ],
    experience: [
        "experience",
        "work experience",
        "employment",
        "work history",
        "kinh nghiệm",
        "kinh nghiệm làm việc",
        "dự án",
        "projects",
        "project",
    ],
    education: [
        "education",
        "học vấn",
        "trình độ học vấn",
        "academic",
        "qualification",
        "certifications",
        "certification",
        "chứng chỉ",
    ],
    languages: [
        "languages",
        "language",
        "ngoại ngữ",
        "ngôn ngữ",
    ],
};

function detectHeadingKey(lineLower) {
    // Một line được coi heading nếu ngắn vừa phải + match từ khoá
    const line = lineLower.trim();
    if (line.length > 60) return null;

    for (const [key, arr] of Object.entries(SECTION_HEADINGS)) {
        for (const h of arr) {
            // match kiểu "SKILLS", "SKILLS:", "Kỹ năng -", "Experience |"
            const pattern = new RegExp(`^${escapeRegex(h)}(\\s*[:\\-|/|•].*)?$`, "i");
            if (pattern.test(line)) return key;
            // đôi khi heading nằm trong line: "TECHNICAL SKILLS"
            if (line === h) return key;
        }
    }
    return null;
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitSections(text) {
    const rawLines = String(text || "").split("\n");
    const lines = rawLines.map((l) => l.trim()).filter(Boolean);

    const sections = {
        skills: [],
        experience: [],
        education: [],
        languages: [],
        other: [],
    };

    let current = "other";

    for (const line of lines) {
        const key = detectHeadingKey(line.toLowerCase());
        if (key) {
            current = key;
            continue;
        }
        sections[current].push(line);
    }

    const join = (arr) => normalizeExtractedText(arr.join("\n"));

    return {
        skillsText: join(sections.skills),
        experienceText: join(sections.experience),
        educationText: join(sections.education),
        languagesText: join(sections.languages),
        otherText: join(sections.other),
    };
}

/* =========================
   3) SKILLS + LANGUAGES EXTRACTORS
   ========================= */

const SKILL_KEYWORDS = [
    // web
    "javascript", "typescript", "react", "next.js", "nextjs", "angular", "vue",
    "html", "css", "scss", "tailwind", "node.js", "nodejs", "express", "nestjs",
    // db
    "mongodb", "mysql", "postgresql", "mssql", "redis",
    // tools
    "git", "docker", "ci/cd", "jenkins",
    // cloud
    "aws", "gcp", "azure",
    // data
    "python", "pandas", "numpy", "sql", "power bi", "tableau", "excel",
    // security
    "owasp", "burp", "nmap", "wireshark",
];

function extractSkillsFromText(skillsText, fallbackWholeText) {
    const found = new Set();

    const source = `${skillsText || ""}\n${fallbackWholeText || ""}`.toLowerCase();

    for (const k of SKILL_KEYWORDS) {
        const pattern = new RegExp(`\\b${escapeRegex(k.toLowerCase())}\\b`, "i");
        if (pattern.test(source)) found.add(normalizeSkillName(k));
    }

    // Nếu skills section có dạng "A, B, C"
    if (skillsText) {
        const maybe = skillsText
            .split(/[,•|·\n]/)
            .map((x) => x.trim())
            .filter((x) => x.length >= 2 && x.length <= 30);

        for (const m of maybe) {
            // lọc bậy
            if (/@/.test(m)) continue;
            if (/^\d+$/.test(m)) continue;
            // chống nhặt câu dài
            if (m.split(" ").length > 4) continue;

            // Chỉ add nếu nhìn giống skill
            if (/[A-Za-z]/.test(m)) found.add(m);
        }
    }

    return Array.from(found).slice(0, 40); // giới hạn
}

function normalizeSkillName(k) {
    // chuẩn hoá vài cái phổ biến
    const map = {
        "nodejs": "Node.js",
        "nextjs": "Next.js",
    };
    const low = k.toLowerCase();
    return map[low] || k;
}

function extractLanguages(languagesText, wholeText) {
    const t = `${languagesText || ""}\n${wholeText || ""}`.toLowerCase();
    const langs = [];

    const rules = [
        { key: "English", re: /\benglish\b|tiếng anh|toeic|ielts/ },
        { key: "Korean", re: /\bkorean\b|tiếng hàn|topik/ },
        { key: "Japanese", re: /\bjapanese\b|tiếng nhật|jlpt/ },
        { key: "Chinese", re: /\bchinese\b|tiếng trung|hsk/ },
        { key: "Vietnamese", re: /\bvietnamese\b|tiếng việt/ },
    ];

    for (const r of rules) {
        if (r.re.test(t)) langs.push(r.key);
    }

    return Array.from(new Set(langs));
}

/* =========================
   4) MAIN PARSER
   ========================= */

async function parseCvFromPath(absolutePath, cvFileId) {
    // 1) Extract raw text
    const rawText = await extractTextFromAbsolutePath(absolutePath);

    // 2) Basic info
    const email = extractEmailFromText(rawText);
    const phone = extractPhoneFromText(rawText);
    const fullName = extractNameFromText(rawText);

    // 3) Sections
    const { skillsText, experienceText, educationText, languagesText, otherText } =
        splitSections(rawText);

    // 4) Extract structured arrays
    const skills = extractSkillsFromText(skillsText, rawText);
    const languages = extractLanguages(languagesText, rawText);

    // 5) Save candidate (NO MOCK)
    const candidate = await Candidate.create({
        fullName,
        email,
        phone,

        // data for AI matching
        skills,                      // array
        experienceText,              // string
        education: educationText,    // keep field name "education" like your matching code expects
        languages,                   // array

        rawText: rawText,
        cvFile: cvFileId,
        matchResult: null,
    });

    return {
        text: rawText,
        candidate,
        parsed: {
            fullName,
            email,
            phone,
            skills,
            languages,
            skillsText,
            experienceText,
            educationText,
            languagesText,
            otherText,
        },
    };
}

module.exports = { parseCvFromPath };
