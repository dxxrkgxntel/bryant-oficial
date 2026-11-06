const mongoose = require("mongoose");

const musicHistoryEntrySchema = new mongoose.Schema({
    title: { type: String, required: true, maxlength: 200 },
    artist: { type: String, default: "", maxlength: 200 },
    url: { type: String, required: true, maxlength: 500 },
    thumbnail: { type: String, default: null, maxlength: 500 },
    durationSeconds: { type: Number, default: 0, min: 0 },
    requestedBy: { type: String, default: null },
    playedAt: { type: Date, default: Date.now }
}, { _id: false });

const musicHistorySchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    entries: { type: [musicHistoryEntrySchema], default: [] }
}, { timestamps: true });

module.exports = mongoose.model("MusicHistory", musicHistorySchema);
