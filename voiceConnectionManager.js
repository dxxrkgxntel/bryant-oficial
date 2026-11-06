const {
    getVoiceConnection,
    joinVoiceChannel,
    entersState,
    VoiceConnectionStatus
} = require("@discordjs/voice");
const VoiceConnectConfig = require("../Models/VoiceConnectConfig");

const RECONNECT_DELAY_MS = 5_000;
const READY_TIMEOUT_MS = 20_000;
const CONFIG_SYNC_INTERVAL_MS = 5_000;
let configSyncTimer = null;
let configSyncRunning = false;
const retryAfterByGuild = new Map();
// A temporary owner can borrow the guild's single Discord voice connection
// (for example, the music player) without the persistent channel sync moving it
// back every few seconds.
const voiceConnectionOverrides = new Map();

function watchConnection(connection, guildId, channelId, options = {}) {
    const previousTarget = connection._persistentVoiceTarget || {};
    connection._persistentVoiceTarget = {
        guildId,
        channelId,
        selfMute: options.selfMute ?? previousTarget.selfMute ?? true,
        selfDeaf: options.selfDeaf ?? previousTarget.selfDeaf ?? false
    };
    if (connection._persistentVoiceRecoveryAttached) return;
    connection._persistentVoiceRecoveryAttached = true;

    connection.on("error", error => {
        console.error(`[VOICE CONNECT] Error en ${guildId}:`, error);
    });

    connection.on("stateChange", (_oldState, newState) => {
        if (newState.status === VoiceConnectionStatus.Ready) {
            if (connection._persistentVoiceRecoveryTimer) {
                clearTimeout(connection._persistentVoiceRecoveryTimer);
            }
            connection._persistentVoiceRecoveryTimer = null;
            return;
        }

        if (newState.status === VoiceConnectionStatus.Disconnected) {
            scheduleReconnect(
                connection,
                connection._persistentVoiceTarget.guildId,
                connection._persistentVoiceTarget.channelId,
                connection._persistentVoiceTarget
            );
        }
    });
}

function scheduleReconnect(connection, guildId, channelId, options = {}) {
    if (connection._persistentVoiceRecoveryTimer) return;
    connection._persistentVoiceRecoveryTimer = setTimeout(() => {
        connection._persistentVoiceRecoveryTimer = null;
        if (connection.state.status === VoiceConnectionStatus.Destroyed) return;
        if (connection.state.status !== VoiceConnectionStatus.Disconnected) return;

        const rejoined = connection.rejoin({
            channelId,
            selfMute: options.selfMute ?? true,
            selfDeaf: options.selfDeaf ?? false
        });
        scheduleReconnect(connection, guildId, channelId, options);
    }, RECONNECT_DELAY_MS);
    connection._persistentVoiceRecoveryTimer.unref?.();
}

async function connectToVoiceChannel(guild, channelId, options = {}) {
    const voiceOptions = {
        selfMute: options.selfMute ?? true,
        selfDeaf: options.selfDeaf ?? false
    };
    let connection = getVoiceConnection(guild.id);
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
        connection._persistentVoiceTarget = { guildId: guild.id, channelId, ...voiceOptions };
        watchConnection(connection, guild.id, channelId, voiceOptions);
    }

    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
        const alreadyInChannel = connection.joinConfig.channelId === channelId;
        if (connection.state.status === VoiceConnectionStatus.Ready && alreadyInChannel) {
            return connection;
        }

        connection.rejoin({
            channelId,
            ...voiceOptions
        });
    } else {
        connection = joinVoiceChannel({
            channelId,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            ...voiceOptions
        });
    }

    connection._persistentVoiceTarget = { guildId: guild.id, channelId, ...voiceOptions };
    watchConnection(connection, guild.id, channelId, voiceOptions);
    await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
    return connection;
}

async function restoreVoiceConnections(client) {
    const configs = await VoiceConnectConfig.find({}).lean();
    for (const config of configs) {
        if (config.enabled === false) {
            const connection = getVoiceConnection(config.guildId);
            if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
            continue;
        }
        if (!config.channelId) continue;
        const guild = client.guilds.cache.get(config.guildId)
            || await client.guilds.fetch(config.guildId).catch(() => null);
        if (!guild) continue;

        const channel = guild.channels.cache.get(config.channelId)
            || await guild.channels.fetch(config.channelId).catch(() => null);
        if (!channel?.isVoiceBased()) {
            console.warn(`[VOICE CONNECT] Canal guardado no disponible en el servidor ${guild.id}.`);
            continue;
        }

        try {
            await connectToVoiceChannel(guild, channel.id);
            console.log(`[VOICE CONNECT] Reconectado en ${guild.name} / ${channel.name}.`);
        } catch (error) {
            console.error(`[VOICE CONNECT] No pude reconectar en ${guild.id}/${channel.id}:`, error);
        }
    }
}

async function syncVoiceConnections(client) {
    const configs = await VoiceConnectConfig.find({}).lean();
    for (const config of configs) {
        if (voiceConnectionOverrides.has(config.guildId)) continue;
        if (config.enabled === false || !config.channelId) {
            const connection = getVoiceConnection(config.guildId);
            if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
            retryAfterByGuild.delete(config.guildId);
            continue;
        }
        const guild = client.guilds.cache.get(config.guildId)
            || await client.guilds.fetch(config.guildId).catch(() => null);
        if (!guild) continue;

        const channel = guild.channels.cache.get(config.channelId)
            || await guild.channels.fetch(config.channelId).catch(() => null);
        if (!channel?.isVoiceBased()) continue;

        const connection = getVoiceConnection(guild.id);
        if (connection
            && connection.state.status !== VoiceConnectionStatus.Destroyed
            && connection.joinConfig.channelId === channel.id) {
            watchConnection(connection, guild.id, channel.id);
            continue;
        }

        const retry = retryAfterByGuild.get(guild.id);
        if (retry?.channelId === channel.id && retry.nextAttemptAt > Date.now()) continue;

        try {
            await connectToVoiceChannel(guild, channel.id);
            retryAfterByGuild.delete(guild.id);
            console.log(`[VOICE CONNECT] Canal actualizado en ${guild.name} / ${channel.name}.`);
        } catch (error) {
            retryAfterByGuild.set(guild.id, { channelId: channel.id, nextAttemptAt: Date.now() + 15_000 });
            console.error(`[VOICE CONNECT] No pude actualizar el canal en ${guild.id}/${channel.id}:`, error);
        }
    }
}

function setVoiceConnectionOverride(guildId, channelId) {
    voiceConnectionOverrides.set(guildId, channelId);
}

async function releaseVoiceConnectionOverride(client, guildId) {
    voiceConnectionOverrides.delete(guildId);
    retryAfterByGuild.delete(guildId);

    const config = await VoiceConnectConfig.findOne({ guildId }).lean();
    const connection = getVoiceConnection(guildId);
    if (!config || config.enabled === false || !config.channelId) {
        if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
            if (connection._persistentVoiceRecoveryTimer) {
                clearTimeout(connection._persistentVoiceRecoveryTimer);
                connection._persistentVoiceRecoveryTimer = null;
            }
            connection.destroy();
        }
        return;
    }

    const guild = client.guilds.cache.get(guildId)
        || await client.guilds.fetch(guildId).catch(() => null);
    const channel = guild && (guild.channels.cache.get(config.channelId)
        || await guild.channels.fetch(config.channelId).catch(() => null));
    if (!guild || !channel?.isVoiceBased()) {
        if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
        return;
    }

    try {
        await connectToVoiceChannel(guild, channel.id);
    } catch (error) {
        console.error(`[VOICE CONNECT] No pude restaurar el canal persistente en ${guildId}:`, error.message);
    }
}

function startVoiceConnectionSync(client) {
    if (configSyncTimer) return configSyncTimer;

    const sync = async () => {
        if (configSyncRunning) return;
        configSyncRunning = true;
        try {
            await syncVoiceConnections(client);
        } catch (error) {
            console.error("[VOICE CONNECT] No pude revisar la configuración de voz:", error);
        } finally {
            configSyncRunning = false;
        }
    };

    configSyncTimer = setInterval(sync, CONFIG_SYNC_INTERVAL_MS);
    configSyncTimer.unref?.();
    return configSyncTimer;
}

module.exports = {
    connectToVoiceChannel,
    restoreVoiceConnections,
    startVoiceConnectionSync,
    setVoiceConnectionOverride,
    releaseVoiceConnectionOverride
};
