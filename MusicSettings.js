const mongoose = require("mongoose");

const musicSettingsSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    enabled: { type: Boolean, default: true },
    textChannelId: { type: String, default: null },
    voiceChannelId: { type: String, default: null },
    djRoleId: { type: String, default: null },
    defaultVolume: { type: Number, default: 70, min: 0, max: 150 }
}, { timestamps: true });

module.exports = mongoose.model("MusicSettings", musicSettingsSchema);
