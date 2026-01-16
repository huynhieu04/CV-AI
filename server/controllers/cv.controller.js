const { saveCvFile } = require("../services/file.service");
const { parseCvFromPath } = require("../services/cv-parser.service");
const { matchCandidateToJobs } = require("../services/aiMatching.service");

function buildCandidateMatchResult(matchResult) {
    if (!matchResult?.matches?.length) return null;

    const sortedMatches = [...matchResult.matches].sort((a, b) => (b.score || 0) - (a.score || 0));
    const best = sortedMatches[0];

    return {
        candidateSummary: matchResult.candidateSummary || {},
        matches: sortedMatches.map((m) => ({
            jobId: m.jobId,
            jobCode: m.jobCode,
            jobTitle: m.jobTitle,
            score: m.score,
            label: m.label,
            reasons: m.reasons,
            breakdown: m.breakdown,
        })),
        bestJobId: matchResult.bestJobId || best.jobId || null,
    };
}

exports.uploadCv = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ ok: false, message: "Thiếu file CV" });

        // 1) save file record
        const cvFileDoc = await saveCvFile(req.file);

        // 2) parse + upsert candidate
        const { text, rawText, candidate } = await parseCvFromPath(cvFileDoc.absolutePath, cvFileDoc._id);

        // 3) match AI + save candidate.matchResult
        matchResult = await matchCandidateToJobs(candidate, rawText || text, cvFileDoc._id);

        try {
            matchResult = await matchCandidateToJobs(candidate, text, cvFileDoc._id);
            candidate.matchResult = buildCandidateMatchResult(matchResult);
            await candidate.save();
        } catch (e) {
            console.warn("[uploadCv] match error (ignored):", e.message);
        }

        return res.json({ ok: true, cvFile: cvFileDoc, candidate, matchResult });
    } catch (err) {
        console.error("[uploadCv] error:", err);
        return res.status(500).json({ ok: false, message: err.message || "Internal server error" });
    }
};
