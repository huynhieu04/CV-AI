// server/controllers/candidate.controller.js
const Candidate = require('../models/candidate.model');

exports.getAll = async (req, res) => {
    try {
        const docs = await Candidate.find()
            .sort({ createdAt: -1 })
            .select("fullName email matchResult createdAt");

        return res.json({ ok: true, candidates: docs });
    } catch (err) {
        console.error("[candidates] getAll error:", err);
        return res.status(500).json({ ok: false, message: err.message || "Internal server error" });
    }
};

exports.getOne = async (req, res) => {
    try {
        const doc = await Candidate.findById(req.params.id)
            .select("-rawText"); // optional: giảm payload nếu rawText nặng

        if (!doc) return res.status(404).json({ ok: false, message: "Candidate not found" });

        return res.json({ ok: true, candidate: doc });
    } catch (err) {
        console.error("[candidates] getOne error:", err);
        return res.status(500).json({ ok: false, message: err.message || "Internal server error" });
    }
};
exports.remove = async (req, res) => {
    try {
        const { id } = req.params;

        const doc = await Candidate.findByIdAndDelete(id);
        if (!doc) {
            return res.status(404).json({ ok: false, message: 'Candidate not found' });
        }

        return res.json({ ok: true });
    } catch (err) {
        console.error('[candidates] remove error:', err);
        return res.status(500).json({
            ok: false,
            message: err.message || 'Internal server error',
        });
    }
};
