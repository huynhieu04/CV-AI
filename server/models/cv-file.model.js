// server/models/cv-file.model.js
const mongoose = require('mongoose');

const cvFileSchema = new mongoose.Schema(
    {
        originalName: String,
        mimeType: String,
        size: Number,
        absolutePath: { type: String, required: true },
        uploadedAt: { type: Date, default: Date.now },
    },
    { timestamps: true }
);

// TÊN MODEL phải đúng y như trong ref: 'CVFile'
module.exports = mongoose.model('CVFile', cvFileSchema);
