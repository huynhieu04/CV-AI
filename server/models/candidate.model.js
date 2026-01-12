// server/models/candidate.model.js
const mongoose = require('mongoose');

const candidateSchema = new mongoose.Schema(
    {
        fullName: String,
        email: String,
        skills: [String],
        rawText: String,

        cvFile: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'CVFile',     // phải đúng 'CVFile'
        },

        matchResult: {
            candidateSummary: {
                mainSkills: [String],
                mainDomains: [String],
                seniority: String,
            },
            matches: [
                {
                    jobId: { type: mongoose.Schema.Types.ObjectId, ref: 'Job' },
                    jobCode: String,
                    jobTitle: String,
                    score: Number,
                    label: String,
                    reasons: [String],
                    breakdown: {
                        skills: Number,
                        experience: Number,
                        education: Number,
                        languages: Number,
                    },
                },
            ],
            bestJobId: { type: mongoose.Schema.Types.ObjectId, ref: 'Job' },
        },
    },
    { timestamps: true }
);

module.exports = mongoose.model('Candidate', candidateSchema);
