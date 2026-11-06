const music = require("../../Handlers/musicManager");

module.exports = {
    name: "voiceStateUpdate",
    async execute(oldState, newState, client) {
        const guildId = oldState.guild?.id || newState.guild?.id;
        if (!guildId) return;
        if (oldState.channelId) await music.scheduleEmptyChannelCheck(guildId, client);
        if (newState.channelId && newState.channelId !== oldState.channelId) {
            const session = music.sessions.get(guildId);
            if (session?.voiceChannelId === newState.channelId) {
                if (session.emptyTimer) clearTimeout(session.emptyTimer);
                session.emptyTimer = null;
            }
        }
    }
};
