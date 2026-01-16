// server/controllers/cv.controller.js
const { saveCvFile } = require("../services/file.service");
const { parseCvFromPath } = require("../services/cv-parser.service");
const { matchCandidateToJobs } = require("../services/aiMatching.service");

async function uploadAndMatchCv(req, res) {
    try {
        if (!req.file) {
            return res.status(400).json({ ok: false, message: "File is missing" });
        }

        // 1) Save file info to CvFile collection
        const cvFileDoc = await saveCvFile(req.file);

        // 2) Parse CV (PDF -> rawText -> Candidate)
        const { candidate, rawText, text } = await parseCvFromPath(
            cvFileDoc.absolutePath,
            cvFileDoc._id
        );

        const finalRawText = rawText || text || candidate?.rawText || "";

        // 3) Match with Jobs
        const matchResult = await matchCandidateToJobs(candidate, finalRawText, cvFileDoc._id);

        // 4) Save matchResult into Candidate for FE
        candidate.matchResult = matchResult;
        await candidate.save();

        return res.json({
            ok: true,
            cvFile: cvFileDoc,
            candidate,
            matchResult,
        });
    } catch (e) {
        console.error("[uploadAndMatchCv]", e);
        return res.status(500).json({ ok: false, message: e.message || "Server error" });
    }
}

module.exports = { uploadAndMatchCv };
