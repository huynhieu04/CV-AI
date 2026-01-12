// server/services/aiMatching.service.js
const { generateJson } = require("./geminiClient");
const Job = require("../models/job.model");
const MatchResult = require("../models/MatchResult");

/**
 * MỤC TIÊU:
 * - Hệ thống dùng AI (Gemini) để so khớp CV với danh sách JD.
 * - Ưu tiên tính "ổn định & chính xác" cho HR:
 *   + Seniority phải ra hợp lý (không Unknown vô tội vạ)
 *   + Không được trả jobTitle/jobCode undefined
 *   + Score/label phải hợp lý, có quy tắc rõ để debug
 */

/* =========================================================
   1) TEXT PREPROCESS + HEURISTICS (RULE-BASED)
   ========================================================= */

/**
 * Chuẩn hoá text để giảm lỗi regex/AI do xuống dòng/space lộn xộn.
 */
function normalizeText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

/**
 * Detect tín hiệu seniority trong CV.
 * Lưu ý: dùng cả EN + VI để robust.
 */
function detectSignals(rawText) {
  const t = String(rawText || "").toLowerCase();

  return {
    // Junior-ish
    isStudent: /\bstudent\b|sinh viên|đang học/.test(t),
    isIntern: /\bintern(ship)?\b|thực tập|tt\b/.test(t),
    isFresher: /\bfresher\b|mới tốt nghiệp|new graduate|graduate/.test(t),

    // Senior-ish
    hasLeaderKeywords:
      /\b(team lead|leader|lead|manager|supervisor|head of)\b|trưởng nhóm|quản lý|trưởng bộ phận/.test(
        t
      ),

    hasSeniorKeywords: /\bsenior\b|\bsr\b|sr\./.test(t),
    hasJuniorKeywords: /\bjunior\b|\bjr\b|jr\./.test(t),
  };
}

/**
 * Ước lượng số năm kinh nghiệm nếu có pattern rõ.
 * (Không cần perfect, chỉ cần đủ dùng để phân tầng seniority)
 */
function estimateYearsOfExperience(rawText) {
  const t = String(rawText || "").toLowerCase();

  // "1-2 năm", "2 - 3 years"
  const range = t.match(/(\d+)\s*[-–]\s*(\d+)\s*(năm|years?)/);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (!Number.isNaN(a) && !Number.isNaN(b)) return Math.round((a + b) / 2);
  }

  // "3+ years", "3+ năm"
  const plus = t.match(/(\d+)\s*\+\s*(years?|năm)/);
  if (plus) {
    const n = Number(plus[1]);
    if (!Number.isNaN(n)) return n;
  }

  // "hơn 5 năm"
  const more = t.match(/hơn\s*(\d+)\s*năm/);
  if (more) {
    const n = Number(more[1]);
    if (!Number.isNaN(n)) return n;
  }

  // "2 năm", "2 years"
  const single = t.match(/(\d+)\s*(năm|years?)/);
  if (single) {
    const n = Number(single[1]);
    if (!Number.isNaN(n)) return n;
  }

  return null;
}

/**
 * Seniority hint theo RULE-BASED.
 * Đây là "bảo hiểm" để tránh AI trả Unknown.
 */
function deriveSeniorityHint(signals, years) {
  // 1) Intern/Student/Fresher => Junior
  if (signals.isIntern || signals.isStudent || signals.isFresher) return "Junior";

  // 2) Có keyword lead/manager => Lead
  if (signals.hasLeaderKeywords) return "Lead";

  // 3) Có years => map theo ngưỡng
  if (typeof years === "number") {
    if (years <= 1) return "Junior";
    if (years <= 3) return "Mid";
    if (years <= 5) return "Senior";
    return "Lead";
  }

  // 4) Keyword fallback
  if (signals.hasSeniorKeywords) return "Senior";
  if (signals.hasJuniorKeywords) return "Junior";

  return "Unknown";
}

/**
 * Chuẩn hoá CV thành các section rõ ràng => giúp AI đọc đúng hơn.
 * (Thay vì nhét rawText không cấu trúc)
 */
function buildStructuredCvText(cvData) {
  const parts = [
    `CANDIDATE: ${cvData.name || ""} | ${cvData.email || ""} | ${cvData.phone || ""}`,
    `SENIORITY_HINT: ${cvData.seniorityHint || "Unknown"} | YEARS: ${cvData.yearsOfExperience ?? "N/A"}`,
    `SIGNALS: ${JSON.stringify(cvData.signals || {})}`,
    "",
    `SKILLS: ${cvData.skillsText || ""}`,
    `EXPERIENCE: ${cvData.experienceText || ""}`,
    `EDUCATION: ${cvData.educationText || ""}`,
    `LANGUAGES: ${cvData.languagesText || ""}`,
    "",
    `RAW_TEXT: ${cvData.rawText || ""}`,
  ];

  return normalizeText(parts.join("\n"));
}

/* =========================================================
   2) PROMPT (HR-GRADE) + PAYLOAD
   ========================================================= */

/**
 * Prompt kiểu “HR-grade”: rõ tiêu chí, rõ schema.
 * - Bắt buộc jobId/jobCode/jobTitle đầy đủ
 * - seniority phải theo enum
 * - giải thích reasons ngắn gọn, bám dữ liệu
 */
function buildSystemInstruction() {
  return `
Bạn là hệ thống AI so khớp CV với Job Description (JD) cho HR.

NGUYÊN TẮC:
- Chỉ trả về JSON đúng schema, KHÔNG thêm text.
- Dựa trên CV + từng JD để chấm điểm phù hợp 0-100.
- Output phải ổn định và nhất quán.

ENUM:
- candidateSummary.seniority: Junior | Mid | Senior | Lead | Unknown
- label: Suitable | Potential | NotFit

XÁC ĐỊNH SENIORITY:
- Ưu tiên dùng cv.seniorityHint nếu nó không phải Unknown.
- Nếu cv.seniorityHint = Unknown, bạn suy ra từ CV raw text và kinh nghiệm.

CHẤM ĐIỂM:
- skills: mức khớp kỹ năng chính
- experience: mức khớp kinh nghiệm / dự án
- education: mức khớp học vấn / chuyên ngành
- languages: mức khớp ngoại ngữ (nếu JD yêu cầu)
- Tổng score là tổng hợp có trọng số, và phải hợp lý.

PENALTY LEVEL:
Mapping JD level -> seniority yêu cầu:
- Intern -> Junior
- Junior -> Junior
- Middle -> Mid
- Senior -> Senior
- Manager -> Lead

Nếu seniority ứng viên lệch xa level JD (ví dụ ứng viên Junior apply Manager hoặc ngược lại) => trừ điểm đáng kể.

BẮT BUỘC MỖI MATCH PHẢI CÓ:
- jobId (đúng y như jobs[].id)
- jobCode (đúng y như jobs[].code)
- jobTitle (đúng y như jobs[].title)

TRẢ JSON:

{
  "candidateSummary": {
    "mainSkills": ["string"],
    "mainDomains": ["string"],
    "seniority": "Junior|Mid|Senior|Lead|Unknown"
  },
  "matches": [
    {
      "jobId": "id JD",
      "jobCode": "mã JD",
      "jobTitle": "tên JD",
      "score": 0-100,
      "label": "Suitable|Potential|NotFit",
      "reasons": ["..."],
      "breakdown": {
        "skills": 0-100,
        "experience": 0-100,
        "education": 0-100,
        "languages": 0-100
      }
    }
  ],
  "bestJobId": "id phù hợp nhất hoặc null"
}
`.trim();
}

function buildPayload(cvData, jobs) {
  // Lưu ý: đưa CV dạng cấu trúc để AI dễ đọc.
  const structured = buildStructuredCvText(cvData);

  return {
    cv: {
      name: cvData.name,
      email: cvData.email,
      phone: cvData.phone,
      seniorityHint: cvData.seniorityHint,
      yearsOfExperience: cvData.yearsOfExperience,
      signals: cvData.signals,

      // AI đọc từ đây
      structuredText: structured,
    },
    jobs: jobs.map((j) => ({
      id: j._id?.toString?.() || j.id,
      code: j.code,
      title: j.title,
      level: j.level || "",
      type: j.type || "",
      skillsRequired: j.skillsRequired || "",
      experienceRequired: j.experienceRequired || "",
      educationRequired: j.educationRequired || "",
      description: j.description || "",
    })),
  };
}

/* =========================================================
   3) RESULT NORMALIZE + BACKEND ENFORCE (ANTI-undefined)
   ========================================================= */

function clampScore(n) {
  const x = Number(n);
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(100, Math.round(x)));
}

function labelByScore(score) {
  // Ngưỡng rõ ràng cho HR
  if (score >= 75) return "Suitable";
  if (score >= 50) return "Potential";
  return "NotFit";
}

/**
 * Phạt lệch seniority/level để ổn định hơn (backend làm “giám khảo cuối”).
 * Lý do: AI đôi khi “nể tay” cho điểm cao dù lệch level.
 */
function levelToSeniority(level) {
  const map = {
    Intern: "Junior",
    Junior: "Junior",
    Middle: "Mid",
    Senior: "Senior",
    Manager: "Lead",
  };
  return map[level] || null;
}

/**
 * Tính penalty dựa trên khoảng cách seniority.
 */
function seniorityDistance(a, b) {
  const order = { Junior: 1, Mid: 2, Senior: 3, Lead: 4, Unknown: 2 };
  const da = order[a] ?? 2;
  const db = order[b] ?? 2;
  return Math.abs(da - db);
}

function applyLevelPenalty(score, candidateSeniority, jobLevel) {
  const required = levelToSeniority(jobLevel);
  if (!required) return score;

  const dist = seniorityDistance(candidateSeniority, required);

  // dist 0: ok
  // dist 1: trừ nhẹ
  // dist 2+: trừ mạnh
  let penalty = 0;
  if (dist === 1) penalty = 8;
  if (dist >= 2) penalty = 18;

  return clampScore(score - penalty);
}

/**
 * Enforce seniority enum + fallback hint nếu AI trả Unknown.
 */
function enforceSeniority(result, cvData) {
  if (!result) return result;
  if (!result.candidateSummary) result.candidateSummary = {};

  const allowed = new Set(["Junior", "Mid", "Senior", "Lead", "Unknown"]);
  const s = result.candidateSummary.seniority;

  if (!allowed.has(s)) result.candidateSummary.seniority = "Unknown";

  // Nếu AI Unknown mà hint có => lấy hint
  if (result.candidateSummary.seniority === "Unknown" && cvData?.seniorityHint) {
    result.candidateSummary.seniority = cvData.seniorityHint;
  }

  return result;
}

/**
 * Bù jobCode/jobTitle để tránh undefined:
 * - Ưu tiên jobId map ra Job
 * - Nếu thiếu jobId thì map theo jobCode
 */
function fillJobFields(matches, jobsById, jobsByCode) {
  return (matches || []).map((m) => {
    const out = { ...m };

    const job =
      (out.jobId && jobsById.get(String(out.jobId))) ||
      (out.jobCode && jobsByCode.get(String(out.jobCode)));

    if (job) {
      out.jobId = out.jobId || String(job._id);
      out.jobCode = out.jobCode || job.code;
      out.jobTitle = out.jobTitle || job.title;
      out._jobLevel = job.level || ""; // (internal) dùng để penalty
    } else {
      // Không map được job => loại sau
      out._unmapped = true;
    }

    // normalize score
    out.score = clampScore(out.score);

    return out;
  });
}

/**
 * Normalize + enforce toàn bộ result:
 * - sort desc
 * - fill job fields
 * - apply penalty + label ổn định
 * - remove unmapped
 * - bestJobId
 */
function normalizeAndEnforceResult(result, cvData, jobs) {
  if (!result) return result;
  if (!Array.isArray(result.matches)) result.matches = [];

  const jobsById = new Map(jobs.map((j) => [String(j._id), j]));
  const jobsByCode = new Map(jobs.map((j) => [String(j.code), j]));

  // 1) enforce seniority (fallback hint)
  result = enforceSeniority(result, cvData);

  // 2) fill job fields (anti-undefined)
  let matches = fillJobFields(result.matches, jobsById, jobsByCode);

  // 3) remove unmapped job => tránh UI bể
  matches = matches.filter((m) => !m._unmapped);

  // 4) apply backend penalty (level)
  const candSeniority = result?.candidateSummary?.seniority || "Unknown";
  matches = matches.map((m) => {
    const jobLevel = m._jobLevel || "";
    const newScore = applyLevelPenalty(m.score, candSeniority, jobLevel);
    return {
      ...m,
      score: newScore,
      label: labelByScore(newScore), // backend quyết định label cuối
    };
  });

  // 5) sort score desc
  matches.sort((a, b) => (b.score || 0) - (a.score || 0));

  // 6) bestJobId
  if (!result.bestJobId && matches[0]) {
    result.bestJobId = matches[0].jobId || null;
  }

  // 7) cleanup internal fields
  result.matches = matches.map((m) => {
    const { _jobLevel, _unmapped, ...clean } = m;
    return clean;
  });

  return result;
}

/* =========================================================
   4) GEMINI CALL
   ========================================================= */

async function matchCvWithJobsGemini(cvData, jobs) {
  const systemInstruction = buildSystemInstruction();
  const payload = buildPayload(cvData, jobs);

  // generateJson nên trả JSON string -> parse
  const raw = await generateJson(systemInstruction, JSON.stringify(payload, null, 2));
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

/* =========================================================
   5) SAVE MATCH HISTORY
   ========================================================= */

async function saveMatchHistory({ candidateId, cvFileId, result }) {
  if (!candidateId || !cvFileId || !result?.matches?.length) return;

  // Lưu theo từng CV upload (cvFile) để có lịch sử
  const bulkOps = result.matches.map((m) => ({
    updateOne: {
      filter: {
        candidate: candidateId,
        job: m.jobId,
        provider: "gemini",
        cvFile: cvFileId,
      },
      update: {
        $set: {
          candidate: candidateId,
          cvFile: cvFileId,
          job: m.jobId,
          provider: "gemini",
          score: m.score ?? null,
          label: m.label || null,
          breakdown: m.breakdown || {},
          reasons: m.reasons || [],
          rawResponse: result, // nếu sợ nặng, bạn có thể chỉ lưu m thay vì result
        },
      },
      upsert: true,
    },
  }));

  if (bulkOps.length) await MatchResult.bulkWrite(bulkOps);
}

/* =========================================================
   6) MAIN ENTRY
   ========================================================= */

async function matchCandidateToJobs(candidate, rawText, cvFileId) {
  const raw = normalizeText(rawText);

  // 1) rule-based seniority hint (để tránh Unknown)
  const signals = detectSignals(raw);
  const years = estimateYearsOfExperience(raw);
  const seniorityHint = deriveSeniorityHint(signals, years);

  // 2) build cvData (ưu tiên text “có cấu trúc”)
  const cvData = {
    name: candidate.fullName || "",
    email: candidate.email || "",
    phone: candidate.phone || "",

    // Các field từ parser (nếu parser làm tốt thì rất giúp AI)
    skillsText: Array.isArray(candidate.skills) ? candidate.skills.join(", ") : "",
    experienceText: candidate.experienceText || "",
    educationText: candidate.education || "",
    languagesText: Array.isArray(candidate.languages) ? candidate.languages.join(", ") : "",

    rawText: raw,

    yearsOfExperience: years,
    signals,
    seniorityHint,
  };

  // 3) load jobs active
  const jobs = await Job.find({ isActive: true }).lean();
  if (!jobs.length) return null;

  // 4) call AI
  let result = await matchCvWithJobsGemini(cvData, jobs);

  // 5) backend normalize + enforce (anti-undefined + penalty)
  result = normalizeAndEnforceResult(result, cvData, jobs);

  // 6) save history
  await saveMatchHistory({
    candidateId: candidate._id,
    cvFileId,
    result,
  });

  return result;
}

module.exports = {
  matchCvWithJobsGemini,
  matchCandidateToJobs,
};
