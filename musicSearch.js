const { MessageFlags } = require("discord.js");
const music = require("../../Handlers/musicManager");

module.exports = {
    id: /^music-search:/,
    async execute(interaction) {
        try {
            const key = interaction.customId.split(":")[1];
            const track = music.consumeSearch(key, interaction.user.id, interaction.guildId, interaction.values[0]);
            await interaction.deferUpdate();
            const message = await music.enqueueTracks(interaction, [track]);
            return interaction.editReply({ content: `✅ ${message}`, embeds: [], components: [] });
        } catch (error) {
            const payload = { content: `🎵 ${error.message || "No pude agregar ese resultado."}`, flags: MessageFlags.Ephemeral };
            if (interaction.deferred || interaction.replied) return interaction.followUp(payload).catch(() => {});
            return interaction.reply(payload).catch(() => {});
        }
    }
};
