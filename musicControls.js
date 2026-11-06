const music = require("../../Handlers/musicManager");

module.exports = {
    id: "music:",
    async execute(interaction, client) {
        return music.executeButton(interaction, client);
    }
};
