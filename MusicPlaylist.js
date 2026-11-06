const mongoose = require("mongoose");

const musicPlaylistTrackSchema = new mongoose.Schema({
    title: { type: String, required: true, maxlength: 200 },
    artist: { type: String, default: "", maxlength: 200 },
    url: { type: String, required: true, maxlength: 500 },
    durationSeconds: { type: Number, default: 0, min: 0 },
    thumbnail: { type: String, default: null, maxlength: 500 },
    source: { type: String, default: "YouTube", maxlength: 30 }
}, { _id: false });

const musicPlaylistSchema = new mongoose.Schema({
    guildId: { type: String, required: true },
    userId: { type: String, required: true },
    name: { type: String, required: true, maxlength: 32 },
    displayName: { type: String, default: "", maxlength: 32 },
    tracks: { type: [musicPlaylistTrackSchema], default: [] }
}, { timestamps: true });

musicPlaylistSchema.index({ guildId: 1, userId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("MusicPlaylist", musicPlaylistSchema);
