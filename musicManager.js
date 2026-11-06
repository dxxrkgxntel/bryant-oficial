const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    PermissionFlagsBits,
    StringSelectMenuBuilder,
    ChannelType
} = require("discord.js");
const {
    AudioPlayerStatus,
    NoSubscriberBehavior,
    StreamType,
    createAudioPlayer,
    createAudioResource
} = require("@discordjs/voice");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const ffmpegPath = require("ffmpeg-static");
const play = require("play-dl");
const MusicHistory = require("../Models/MusicHistory");
const MusicSettings = require("../Models/MusicSettings");
const {
    connectToVoiceChannel,
    releaseVoiceConnectionOverride,
    setVoiceConnectionOverride
} = require("./voiceConnectionManager");

const sessions = new Map();
const pendingSessions = new Map();
const pendingSearches = new Map();
const MAX_QUEUE_SIZE = 100;
const MAX_PLAYLIST_IMPORT = 25;
const HISTORY_SIZE = 50;
const IDLE_DISCONNECT_MS = 120_000;
const EMPTY_CHANNEL_DISCONNECT_MS = 45_000;

const FILTERS = {
    off: null,
    bassboost: "bass=g=9:d=2",
    "8d": "apulsator=hz=0.08",
    nightcore: "asetrate=48000*1.12,aresample=48000,atempo=1.12",
    vaporwave: "asetrate=48000*0.88,aresample=48000,atempo=0.88",
    karaoke: "stereotools=mlev=0.03",
    treble: "treble=g=5",
    vibrato: "vibrato=f=6.5:d=0.65",
    tremolo: "tremolo=f=6.5:d=0.65",
    phaser: "aphaser=in_gain=0.4",
    surround: "extrastereo=m=2.2"
};

function clip(value, max = 200) {
    return String(value || "").replace(/[\r\n]/g, " ").slice(0, max);
}

function durationText(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return "En vivo / duración desconocida";
    const total = Math.floor(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = total % 60;
    return hours
        ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
        : `${minutes}:${String(rest).padStart(2, "0")}`;
}

function getVideoThumbnail(video) {
    const thumbnails = video?.thumbnails;
    return video?.thumbnail?.url
        || (typeof video?.thumbnail === "string" ? video.thumbnail : null)
        || (Array.isArray(thumbnails) ? thumbnails[thumbnails.length - 1]?.url : null)
        || null;
}

function normalizeYouTubeVideo(video, requestedBy = null) {
    if (!video?.url || !video?.title) return null;
    return {
        title: clip(video.title),
        artist: clip(video.channel?.name || "", 200),
        url: video.url,
        durationSeconds: Number(video.durationInSec) || 0,
        thumbnail: getVideoThumbnail(video),
        source: "YouTube",
        requestedBy
    };
}

function normalizeSoundCloudTrack(track, requestedBy = null) {
    if (!track?.url || !track?.name) return null;
    return {
        title: clip(track.name),
        artist: clip(track.user?.name || track.user?.username || "", 200),
        url: track.url,
        durationSeconds: Number(track.durationInSec) || 0,
        thumbnail: track.thumbnail || null,
        source: "SoundCloud",
        requestedBy
    };
}

function youtubeQueryFor(item) {
    const artist = Array.isArray(item.artists)
        ? item.artists.map(value => value.name).filter(Boolean).join(" ")
        : item.artist?.name || "";
    return {
        title: item.name || item.title || "",
        artist,
        query: `${item.name || item.title || ""} ${artist}`.trim()
    };
}

async function findYouTubeMatch(item, requestedBy = null) {
    const search = youtubeQueryFor(item);
    if (!search.query) return null;
    const results = await play.search(search.query, {
        limit: 1,
        source: { youtube: "video" }
    });
    const track = normalizeYouTubeVideo(results?.[0], requestedBy);
    if (!track) return null;
    if (search.artist) track.artist = clip(search.artist, 200);
    return track;
}

async function mapLimit(items, limit, callback) {
    const output = new Array(items.length);
    let index = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (index < items.length) {
            const current = index++;
            try {
                output[current] = await callback(items[current], current);
            } catch {
                output[current] = null;
            }
        }
    });
    await Promise.all(workers);
    return output.filter(Boolean);
}

async function resolveQuery(query, requestedBy = null) {
    const value = String(query || "").trim();
    if (!value) throw new Error("Escribe el nombre de una canción o pega un enlace compatible.");

    let type = false;
    if (/^https?:\/\//i.test(value)) {
        type = await play.validate(value).catch(() => false);
        if (!type) throw new Error("No pude reconocer ese enlace. Prueba YouTube, SoundCloud, Spotify o Deezer.");
    }

    if (type === "yt_video") {
        const info = await play.video_info(value);
        const track = normalizeYouTubeVideo(info.video_details, requestedBy);
        if (!track) throw new Error("No pude leer esa canción de YouTube.");
        return { tracks: [track], playlistName: null };
    }

    if (type === "yt_playlist") {
        const playlist = await play.playlist_info(value, { incomplete: true });
        const videos = await playlist.next(MAX_PLAYLIST_IMPORT);
        return {
            tracks: (videos || []).map(video => normalizeYouTubeVideo(video, requestedBy)).filter(Boolean).slice(0, MAX_PLAYLIST_IMPORT),
            playlistName: playlist.title || null
        };
    }

    if (type === "so_track" || type === "so_playlist") {
        const item = await play.soundcloud(value);
        if (item.type === "track") {
            const track = normalizeSoundCloudTrack(item, requestedBy);
            if (!track) throw new Error("No pude leer esa canción de SoundCloud.");
            return { tracks: [track], playlistName: null };
        }
        let tracks = Array.isArray(item.tracks) ? item.tracks : [];
        if (!tracks.length && typeof item.all_tracks === "function") tracks = await item.all_tracks();
        return {
            tracks: tracks.slice(0, MAX_PLAYLIST_IMPORT).map(track => normalizeSoundCloudTrack(track, requestedBy)).filter(Boolean),
            playlistName: item.name || null
        };
    }

    if (type === "sp_track" || type === "sp_playlist" || type === "sp_album") {
        const item = await play.spotify(value);
        let metadata = [];
        if (item.type === "track") metadata = [item];
        else {
            await item.fetch();
            metadata = (item.page?.(1) || []).slice(0, MAX_PLAYLIST_IMPORT);
        }
        const tracks = await mapLimit(metadata, 4, track => findYouTubeMatch(track, requestedBy));
        return { tracks, playlistName: item.name || null };
    }

    if (type === "dz_track" || type === "dz_playlist" || type === "dz_album") {
        const item = await play.deezer(value);
        let metadata = item.type === "track" ? [item] : (item.tracks || []).slice(0, MAX_PLAYLIST_IMPORT);
        if (!metadata.length && typeof item.all_tracks === "function") metadata = (await item.all_tracks()).slice(0, MAX_PLAYLIST_IMPORT);
        const tracks = await mapLimit(metadata, 4, track => findYouTubeMatch(track, requestedBy));
        return { tracks, playlistName: item.title || item.name || null };
    }

    if (type === "search") {
        throw new Error("Ese enlace de búsqueda no apunta a una canción concreta. Usa el texto de búsqueda.");
    }

    if (type) throw new Error("Ese tipo de enlace todavía no se puede reproducir.");

    const results = await play.search(value, { limit: 1, source: { youtube: "video" } });
    const track = normalizeYouTubeVideo(results?.[0], requestedBy);
    if (!track) throw new Error("No encontré una canción con ese nombre.");
    return { tracks: [track], playlistName: null };
}

async function searchTracks(query, requestedBy = null) {
    const results = await play.search(String(query || "").trim(), {
        limit: 8,
        source: { youtube: "video" }
    });
    return (results || []).map(video => normalizeYouTubeVideo(video, requestedBy)).filter(Boolean);
}

async function getSettings(guildId) {
    return await MusicSettings.findOne({ guildId }).lean() || {
        guildId,
        enabled: true,
        textChannelId: null,
        voiceChannelId: null,
        djRoleId: null,
        defaultVolume: 70
    };
}

async function validateRequest(interaction) {
    if (!interaction.guild || !interaction.member) throw new Error("La música solo está disponible dentro de un servidor.");
    const settings = await getSettings(interaction.guildId);
    if (settings.enabled === false) throw new Error("El sistema de música está desactivado en este servidor.");
    if (settings.textChannelId && settings.textChannelId !== interaction.channelId) {
        throw new Error(`Usa el canal configurado para música: <#${settings.textChannelId}>.`);
    }

    const voiceChannel = interaction.member.voice?.channel;
    if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) throw new Error("Entra primero a un canal de voz normal.");
    if (settings.voiceChannelId && settings.voiceChannelId !== voiceChannel.id) {
        throw new Error(`La música está limitada a <#${settings.voiceChannelId}>.`);
    }

    const me = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
    const permissions = me && voiceChannel.permissionsFor(me);
    if (!permissions?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak
    ])) {
        throw new Error("Necesito permisos para ver el canal, conectarme y hablar en voz.");
    }
    return { settings, voiceChannel, textChannel: interaction.channel };
}

function createSession(guild, voiceChannel, textChannel, settings, connection) {
    const player = createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
    });
    const session = {
        guildId: guild.id,
        guild,
        voiceChannelId: voiceChannel.id,
        textChannelId: textChannel?.id || null,
        textChannel,
        connection,
        player,
        currentTrack: null,
        autoplaySeed: null,
        queue: [],
        recentTracks: [],
        djUserId: null,
        loopMode: "off",
        autoplay: false,
        volume: Math.max(0, Math.min(150, Number.isFinite(Number(settings.defaultVolume)) ? Number(settings.defaultVolume) : 70)),
        filter: "off",
        seekOffset: 0,
        startedAt: null,
        currentProcess: null,
        panelMessage: null,
        advancing: false,
        suppressIdle: false,
        idleTimer: null,
        emptyTimer: null
    };

    player.on(AudioPlayerStatus.Idle, () => {
        if (session.suppressIdle || !session.currentTrack) return;
        void handleTrackEnd(session);
    });
    player.on("error", error => {
        console.error(`[MUSIC] Error de audio en ${session.guildId}:`, error.message);
    });
    player.on(AudioPlayerStatus.Playing, () => {
        void updatePanel(session);
    });

    return session;
}

async function ensureSession(interaction, request) {
    const { settings, voiceChannel, textChannel } = request;
    let session = sessions.get(interaction.guildId);
    if (session && session.voiceChannelId !== voiceChannel.id) {
        throw new Error(`Ya estoy reproduciendo en <#${session.voiceChannelId}>.`);
    }
    if (session) {
        session.textChannel = textChannel || session.textChannel;
        session.textChannelId = session.textChannel?.id || session.textChannelId;
        return session;
    }

    let pending = pendingSessions.get(interaction.guildId);
    if (pending) {
        session = await pending;
        if (session.voiceChannelId !== voiceChannel.id) throw new Error(`Ya estoy conectándome a <#${session.voiceChannelId}>.`);
        return session;
    }

    pending = (async () => {
        setVoiceConnectionOverride(interaction.guildId, voiceChannel.id);
        try {
            const connection = await connectToVoiceChannel(interaction.guild, voiceChannel.id, {
                selfMute: false,
                selfDeaf: true
            });
            const created = createSession(interaction.guild, voiceChannel, textChannel, settings, connection);
            connection.subscribe(created.player);
            sessions.set(interaction.guildId, created);
            return created;
        } catch (error) {
            await releaseVoiceConnectionOverride(interaction.client, interaction.guildId).catch(() => {});
            throw error;
        }
    })();
    pendingSessions.set(interaction.guildId, pending);
    try {
        return await pending;
    } finally {
        pendingSessions.delete(interaction.guildId);
    }
}

function getPosition(session) {
    if (!session.currentTrack) return 0;
    return Math.max(0, session.seekOffset + (session.startedAt ? (Date.now() - session.startedAt) / 1000 : 0));
}

function killCurrentProcess(session) {
    if (!session.currentProcess) return;
    try { session.currentProcess.stdin?.destroy(); } catch {}
    try { session.currentProcess.kill("SIGKILL"); } catch {}
    session.currentProcess = null;
}

async function createAudio(session, track, seek = 0) {
    if (!ffmpegPath) throw new Error("FFmpeg no está disponible en el host.");
    const source = await play.stream(track.url, {
        ...(seek > 0 && track.source === "YouTube" ? { seek: Math.floor(seek) } : {}),
        discordPlayerCompatibility: true
    });
    const filter = FILTERS[session.filter];
    const args = ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn"];
    if (filter) args.push("-af", filter);
    args.push("-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1");

    const transcoder = spawn(ffmpegPath, args, { stdio: ["pipe", "pipe", "ignore"] });
    session.currentProcess = transcoder;
    source.stream.on("error", error => {
        console.error(`[MUSIC] Error leyendo ${track.source}:`, error.message);
        transcoder.stdin.destroy(error);
    });
    transcoder.on("error", error => {
        console.error("[MUSIC] FFmpeg no pudo iniciar:", error.message);
    });
    transcoder.stdin.on("error", () => {});
    source.stream.pipe(transcoder.stdin);

    const resource = createAudioResource(transcoder.stdout, {
        inputType: StreamType.Raw,
        inlineVolume: true,
        metadata: track
    });
    resource.volume?.setVolume(session.volume / 100);
    return resource;
}

function historyEntry(track) {
    return {
        title: clip(track.title),
        artist: clip(track.artist || ""),
        url: track.url,
        thumbnail: track.thumbnail || null,
        durationSeconds: Number(track.durationSeconds) || 0,
        requestedBy: track.requestedBy || null,
        playedAt: new Date()
    };
}

async function storeHistory(guildId, track) {
    try {
        await MusicHistory.updateOne(
            { guildId },
            { $push: { entries: { $each: [historyEntry(track)], $slice: -HISTORY_SIZE } } },
            { upsert: true }
        );
    } catch (error) {
        console.error(`[MUSIC] No pude guardar historial en ${guildId}:`, error.message);
    }
}

async function recommendTrack(session) {
    const current = session.currentTrack || session.autoplaySeed;
    if (!current) return null;
    const terms = `${current.title} ${current.artist || ""}`.trim();
    const results = await play.search(terms, { limit: 8, source: { youtube: "video" } });
    const used = new Set([
        current.url,
        ...session.queue.map(track => track.url),
        ...session.recentTracks.slice(-8).map(track => track.url)
    ]);
    const candidate = results.find(video => video.url && !used.has(video.url));
    return normalizeYouTubeVideo(candidate, current.requestedBy);
}

function clearTimer(session, name) {
    if (session[name]) clearTimeout(session[name]);
    session[name] = null;
}

async function startNext(session) {
    if (session.advancing || sessions.get(session.guildId) !== session) return;
    session.advancing = true;
    clearTimer(session, "idleTimer");
    try {
        if (!session.queue.length && session.autoplay && session.currentTrack) {
            try {
                const recommendation = await recommendTrack(session);
                if (recommendation) session.queue.push(recommendation);
            } catch (error) {
                console.warn(`[MUSIC] Autoplay no encontró otra canción en ${session.guildId}:`, error.message);
            }
        }
        if (!session.queue.length && session.autoplay && session.autoplaySeed) {
            try {
                const recommendation = await recommendTrack(session);
                if (recommendation) session.queue.push(recommendation);
            } catch (error) {
                console.warn(`[MUSIC] Autoplay no encontró otra canción en ${session.guildId}:`, error.message);
            } finally {
                session.autoplaySeed = null;
            }
        }

        let failedTracks = 0;
        while (session.queue.length && failedTracks < 5) {
            const track = session.queue.shift();
            session.currentTrack = track;
            session.seekOffset = 0;
            session.startedAt = null;
            killCurrentProcess(session);
            try {
                const resource = await createAudio(session, track, 0);
                if (sessions.get(session.guildId) !== session) {
                    killCurrentProcess(session);
                    return;
                }
                session.player.play(resource);
                session.startedAt = Date.now();
                session.recentTracks.push(track);
                if (session.recentTracks.length > 30) session.recentTracks.shift();
                void storeHistory(session.guildId, track);
                void updatePanel(session);
                return;
            } catch (error) {
                console.error(`[MUSIC] No pude reproducir "${track.title}" en ${session.guildId}:`, error.message);
                session.currentTrack = null;
                killCurrentProcess(session);
                failedTracks++;
            }
        }

        if (!session.queue.length) {
            session.currentTrack = null;
            session.seekOffset = 0;
            session.startedAt = null;
            void updatePanel(session);
            session.idleTimer = setTimeout(() => {
                if (sessions.get(session.guildId) === session && !session.currentTrack && !session.queue.length) {
                    void endSession(session, "La reproducción quedó inactiva durante dos minutos.");
                }
            }, IDLE_DISCONNECT_MS);
            session.idleTimer.unref?.();
        }
    } finally {
        session.advancing = false;
        if (session.queue.length && !session.currentTrack) void startNext(session);
    }
}

async function handleTrackEnd(session) {
    if (session.advancing || !session.currentTrack) return;
    const completed = session.currentTrack;
    session.autoplaySeed = completed;
    session.startedAt = null;
    session.seekOffset = 0;
    if (session.loopMode === "track") {
        session.queue.unshift(completed);
    } else if (session.loopMode === "queue") {
        session.queue.push(completed);
    }
    session.currentTrack = null;
    await startNext(session);
}

async function enqueueTracks(interaction, tracks) {
    const request = await validateRequest(interaction);
    const session = await ensureSession(interaction, request);
    const available = MAX_QUEUE_SIZE - session.queue.length - (session.currentTrack ? 0 : 0);
    const accepted = tracks.slice(0, Math.max(0, available));
    if (!accepted.length) throw new Error("La cola llegó al límite de 100 canciones.");

    if (!session.djUserId) session.djUserId = interaction.user.id;
    session.queue.push(...accepted);
    const startsNow = !session.currentTrack && session.player.state.status === AudioPlayerStatus.Idle;
    if (startsNow) void startNext(session);
    else void updatePanel(session);

    const first = accepted[0];
    const suffix = accepted.length < tracks.length ? " (la cola alcanzó el límite de 100 canciones)" : "";
    return `${accepted.length === 1 ? "Añadida" : `Añadidas ${accepted.length} canciones`}${accepted.length === 1 ? ` a la cola: [**${clip(first.title, 100)}**](${first.url})` : ` desde **${clip(tracks[0].title, 80)}**`}${suffix}.`;
}

function buildPanelEmbed(session) {
    const track = session.currentTrack;
    const color = 0x8A2BE2;
    if (!track) {
        return new EmbedBuilder()
            .setColor(color)
            .setTitle("🎵 Bryvex Music")
            .setDescription("No hay una canción reproduciéndose ahora. Usa `/music play` para agregar música.")
            .addFields(
                { name: "Cola", value: `${session.queue.length} canción(es)`, inline: true },
                { name: "Repetición", value: session.loopMode === "off" ? "Desactivada" : session.loopMode === "track" ? "Canción" : "Cola", inline: true },
                { name: "Autoplay", value: session.autoplay ? "Activado" : "Desactivado", inline: true }
            );
    }

    const embed = new EmbedBuilder()
        .setColor(color)
        .setAuthor({ name: "Bryvex Music • Reproduciendo ahora" })
        .setTitle(clip(track.title, 250))
        .setURL(track.url)
        .setDescription([
            track.artist ? `**Artista:** ${clip(track.artist, 150)}` : null,
            `**Duración:** ${durationText(track.durationSeconds)}`,
            `**Solicitó:** <@${track.requestedBy || session.djUserId}>`
        ].filter(Boolean).join("\n"))
        .addFields(
            { name: "En cola", value: `${session.queue.length}`, inline: true },
            { name: "Modo", value: session.loopMode === "off" ? "Normal" : session.loopMode === "track" ? "Repetir canción" : "Repetir cola", inline: true },
            { name: "Filtro", value: session.filter, inline: true }
        )
        .setFooter({ text: `Volumen ${session.volume}% · Autoplay ${session.autoplay ? "activo" : "inactivo"}` });
    if (track.thumbnail) embed.setThumbnail(track.thumbnail);
    return embed;
}

function button(action, guildId, label, emoji, style = ButtonStyle.Secondary, disabled = false) {
    return new ButtonBuilder()
        .setCustomId(`music:${action}:${guildId}`)
        .setLabel(label)
        .setEmoji(emoji)
        .setStyle(style)
        .setDisabled(disabled);
}

function buildPanelComponents(session) {
    const guildId = session.guildId;
    const paused = session.player.state.status === AudioPlayerStatus.Paused;
    const disabled = !session.currentTrack;
    return [
        new ActionRowBuilder().addComponents(
            button("previous", guildId, "Anterior", "⏮️", ButtonStyle.Secondary, disabled),
            button("toggle", guildId, paused ? "Continuar" : "Pausar", paused ? "▶️" : "⏸️", ButtonStyle.Primary, disabled),
            button("skip", guildId, "Saltar", "⏭️", ButtonStyle.Secondary, disabled),
            button("shuffle", guildId, "Aleatorio", "🔀", ButtonStyle.Secondary, session.queue.length < 2),
            button("stop", guildId, "Detener", "⏹️", ButtonStyle.Danger)
        ),
        new ActionRowBuilder().addComponents(
            button("repeat", guildId, `Repetir: ${session.loopMode}`, "🔁"),
            button("autoplay", guildId, `Autoplay: ${session.autoplay ? "Sí" : "No"}`, "✨"),
            button("queue", guildId, "Ver cola", "📜"),
            button("volume_down", guildId, "Volumen −", "🔉"),
            button("volume_up", guildId, "Volumen +", "🔊")
        )
    ];
}

async function updatePanel(session) {
    if (!session.textChannel?.isTextBased?.() || !session.textChannel.send) return;
    const payload = {
        embeds: [buildPanelEmbed(session)],
        components: buildPanelComponents(session)
    };
    try {
        if (session.panelMessage) {
            await session.panelMessage.edit(payload);
        } else {
            session.panelMessage = await session.textChannel.send(payload);
        }
    } catch (error) {
        session.panelMessage = null;
        if (error.code !== 50013 && error.code !== 50001) {
            console.error(`[MUSIC] No pude actualizar el panel en ${session.guildId}:`, error.message);
        }
    }
}

function shuffleQueue(queue) {
    for (let index = queue.length - 1; index > 0; index--) {
        const other = Math.floor(Math.random() * (index + 1));
        [queue[index], queue[other]] = [queue[other], queue[index]];
    }
}

async function restartCurrent(session, seekSeconds) {
    if (!session.currentTrack) throw new Error("No hay una canción para controlar.");
    const track = session.currentTrack;
    const position = Math.max(0, Math.min(Number(seekSeconds) || 0, track.durationSeconds ? track.durationSeconds - 1 : 86_400));
    killCurrentProcess(session);
    const resource = await createAudio(session, track, position);
    session.seekOffset = position;
    session.startedAt = Date.now();
    session.player.play(resource);
    await updatePanel(session);
}

async function endSession(session, reason = null) {
    if (!session || sessions.get(session.guildId) !== session) return;
    sessions.delete(session.guildId);
    clearTimer(session, "idleTimer");
    clearTimer(session, "emptyTimer");
    session.suppressIdle = true;
    session.player.stop(true);
    killCurrentProcess(session);
    try {
        if (session.panelMessage) {
            await session.panelMessage.edit({
                embeds: [new EmbedBuilder().setColor(0x8A2BE2).setTitle("🎵 Bryvex Music").setDescription(reason || "La reproducción terminó.")],
                components: []
            });
        }
    } catch {}
    await releaseVoiceConnectionOverride(session.guild.client, session.guildId);
}

function promoteDJIfNeeded(session) {
    const currentDJ = session.guild.members.cache.get(session.djUserId);
    if (currentDJ?.voice.channelId === session.voiceChannelId) return;
    const nextDJ = session.guild.channels.cache.get(session.voiceChannelId)?.members
        ?.find(member => !member.user.bot);
    session.djUserId = nextDJ?.id || null;
}

function canManageMusic(interaction, session, settings) {
    const member = interaction.member;
    if (!member?.voice?.channelId || member.voice.channelId !== session.voiceChannelId) {
        throw new Error("Debes estar en el mismo canal de voz que Bryvex Bot para usar esos controles.");
    }
    promoteDJIfNeeded(session);
    const manager = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
        || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
    const djRole = settings.djRoleId && member.roles?.cache?.has(settings.djRoleId);
    if (!manager && !djRole && interaction.user.id !== session.djUserId) {
        throw new Error(`El DJ actual es <@${session.djUserId}>. Un administrador o el rol configurado también puede controlar la música.`);
    }
}

async function runControl(interaction, action, options = {}) {
    const session = sessions.get(interaction.guildId);
    if (!session) throw new Error("No hay una sesión de música activa en este servidor.");
    const settings = await getSettings(interaction.guildId);
    canManageMusic(interaction, session, settings);

    switch (action) {
        case "toggle":
            if (session.player.state.status === AudioPlayerStatus.Paused) {
                session.startedAt = Date.now();
                session.player.unpause();
                return "Reproducción reanudada.";
            }
            if (session.player.state.status !== AudioPlayerStatus.Playing) throw new Error("La reproducción todavía no está lista para pausarse.");
            session.seekOffset = getPosition(session);
            session.startedAt = null;
            session.player.pause();
            return "Reproducción pausada.";
        case "pause":
            if (session.player.state.status !== AudioPlayerStatus.Playing) throw new Error("No hay una canción reproduciéndose ahora.");
            session.seekOffset = getPosition(session);
            session.startedAt = null;
            session.player.pause();
            return "Reproducción pausada.";
        case "resume":
            if (session.player.state.status !== AudioPlayerStatus.Paused) throw new Error("La reproducción no está pausada.");
            session.startedAt = Date.now();
            session.player.unpause();
            return "Reproducción reanudada.";
        case "skip":
            if (!session.currentTrack) throw new Error("No hay una canción actual para saltar.");
            session.autoplaySeed = session.currentTrack;
            session.suppressIdle = true;
            session.player.stop(true);
            session.suppressIdle = false;
            killCurrentProcess(session);
            session.currentTrack = null;
            session.seekOffset = 0;
            session.startedAt = null;
            void startNext(session);
            return "Canción saltada.";
        case "previous": {
            if (!session.currentTrack) throw new Error("No hay una canción actual.");
            if (getPosition(session) > 5) {
                await restartCurrent(session, 0);
                return "Volví al inicio de la canción actual.";
            }
            const previous = session.recentTracks.length > 1 ? session.recentTracks[session.recentTracks.length - 2] : null;
            if (!previous) throw new Error("No hay una canción anterior en el historial de esta sesión.");
            session.suppressIdle = true;
            session.player.stop(true);
            session.suppressIdle = false;
            killCurrentProcess(session);
            session.recentTracks.pop();
            session.queue.unshift(session.currentTrack);
            session.queue.unshift(previous);
            session.currentTrack = null;
            session.startedAt = null;
            session.seekOffset = 0;
            void startNext(session);
            return "Reproduciendo la canción anterior.";
        }
        case "stop":
            await endSession(session, "La música se detuvo. Usa `/music play` para empezar otra sesión.");
            return "Detuve la música y salí del canal de voz.";
        case "shuffle":
            if (session.queue.length < 2) throw new Error("Agrega al menos dos canciones para mezclar la cola.");
            shuffleQueue(session.queue);
            void updatePanel(session);
            return "Cola mezclada.";
        case "clear": {
            const cleared = session.queue.length;
            session.queue = [];
            void updatePanel(session);
            return `Quité ${cleared} canción(es) de la cola.`;
        }
        case "repeat": {
            const mode = options.mode;
            if (!mode || !["off", "track", "queue"].includes(mode)) throw new Error("Elige repetición: `off`, `track` o `queue`.");
            session.loopMode = mode;
            void updatePanel(session);
            return `Repetición: ${mode === "off" ? "desactivada" : mode === "track" ? "canción actual" : "cola completa"}.`;
        }
        case "autoplay":
            session.autoplay = typeof options.enabled === "boolean" ? options.enabled : !session.autoplay;
            void updatePanel(session);
            return `Autoplay ${session.autoplay ? "activado" : "desactivado"}.`;
        case "skipto": {
            const position = Number(options.value);
            if (!Number.isInteger(position) || position < 1 || position > session.queue.length) {
                throw new Error(`Indica una posición entre 1 y ${session.queue.length}.`);
            }
            session.queue.splice(0, position - 1);
            session.autoplaySeed = session.currentTrack;
            session.suppressIdle = true;
            session.player.stop(true);
            session.suppressIdle = false;
            killCurrentProcess(session);
            session.currentTrack = null;
            void startNext(session);
            return `Salté a la posición ${position} de la cola.`;
        }
        case "seek": {
            const value = Number(options.value);
            if (!Number.isFinite(value) || value < 0) throw new Error("Indica los segundos a los que quieres avanzar.");
            if (session.currentTrack.source !== "YouTube") throw new Error("El avance por posición está disponible para canciones reproducidas desde YouTube.");
            await restartCurrent(session, value);
            return `Reproducción movida a ${durationText(value)}.`;
        }
        case "seek_forward":
        case "seek_back": {
            const seconds = Number(options.value);
            if (!Number.isInteger(seconds) || seconds < 1) throw new Error("Indica cuántos segundos quieres avanzar o retroceder.");
            if (session.currentTrack.source !== "YouTube") throw new Error("El avance por posición está disponible para canciones reproducidas desde YouTube.");
            const position = getPosition(session) + (action === "seek_forward" ? seconds : -seconds);
            await restartCurrent(session, Math.max(0, position));
            return `${action === "seek_forward" ? "Avancé" : "Retrocedí"} ${seconds} segundos.`;
        }
        case "volume": {
            const volume = Number(options.value);
            if (!Number.isInteger(volume) || volume < 0 || volume > 150) throw new Error("El volumen debe estar entre 0 y 150.");
            session.volume = volume;
            const resource = session.player.state.resource;
            resource?.volume?.setVolume(volume / 100);
            void updatePanel(session);
            return `Volumen establecido en ${volume}%.`;
        }
        case "volume_down":
        case "volume_up": {
            session.volume = Math.max(0, Math.min(150, session.volume + (action === "volume_up" ? 10 : -10)));
            session.player.state.resource?.volume?.setVolume(session.volume / 100);
            void updatePanel(session);
            return `Volumen: ${session.volume}%.`;
        }
        case "filter": {
            const filter = String(options.filter || "").toLowerCase();
            if (!Object.hasOwn(FILTERS, filter)) throw new Error(`Filtro no disponible. Opciones: ${Object.keys(FILTERS).join(", " )}.`);
            session.filter = filter;
            if (session.currentTrack) await restartCurrent(session, getPosition(session));
            else void updatePanel(session);
            return `Filtro establecido en **${filter}**.`;
        }
        case "queue":
            return "queue";
        case "lyrics":
            return "lyrics";
        default:
            throw new Error("Acción de música desconocida.");
    }
}

function queueEmbed(session) {
    const embed = new EmbedBuilder().setColor(0x8A2BE2).setTitle("🎵 Cola de Bryvex Music");
    if (session.currentTrack) {
        embed.setDescription(`**Ahora:** [${clip(session.currentTrack.title, 150)}](${session.currentTrack.url}) · ${durationText(session.currentTrack.durationSeconds)}\n\n` +
            (session.queue.slice(0, 10).map((track, index) => `**${index + 1}.** [${clip(track.title, 110)}](${track.url}) · ${durationText(track.durationSeconds)}`).join("\n") || "La cola está vacía."));
    } else {
        embed.setDescription(session.queue.slice(0, 10).map((track, index) => `**${index + 1}.** [${clip(track.title, 110)}](${track.url}) · ${durationText(track.durationSeconds)}`).join("\n") || "La cola está vacía.");
    }
    embed.setFooter({ text: `${session.queue.length} canción(es) en cola · máximo 100` });
    return embed;
}

function createSearchMenu(tracks, userId, guildId) {
    const key = randomBytes(5).toString("hex");
    pendingSearches.set(key, { tracks, userId, guildId, expiresAt: Date.now() + 120_000 });
    const timeout = setTimeout(() => pendingSearches.delete(key), 120_000);
    timeout.unref?.();
    return {
        key,
        components: [new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`music-search:${key}`)
                .setPlaceholder("Elige una canción para agregarla")
                .addOptions(tracks.slice(0, 25).map((track, index) => ({
                    label: clip(track.title, 100),
                    description: clip(`${track.artist ? `${track.artist} · ` : ""}${durationText(track.durationSeconds)}`, 100),
                    value: String(index)
                })))
        )]
    };
}

function consumeSearch(key, userId, guildId, index) {
    const item = pendingSearches.get(key);
    if (!item || item.expiresAt < Date.now()) {
        pendingSearches.delete(key);
        throw new Error("La búsqueda venció. Ejecuta `/music search` otra vez.");
    }
    if (item.userId !== userId || item.guildId !== guildId) throw new Error("Esta lista de resultados pertenece a otra persona.");
    const track = item.tracks[Number(index)];
    if (!track) throw new Error("Ese resultado ya no está disponible.");
    pendingSearches.delete(key);
    return track;
}

function lyricsSearchUrl(track) {
    const query = `${track?.title || ""} ${track?.artist || ""} lyrics`.trim();
    return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

async function scheduleEmptyChannelCheck(guildId, client) {
    const session = sessions.get(guildId);
    if (!session) return;
    const channel = session.guild.channels.cache.get(session.voiceChannelId);
    if (!channel) return void endSession(session, "El canal de voz dejó de estar disponible.");
    const humans = channel.members.filter(member => !member.user.bot);
    if (humans.size) {
        clearTimer(session, "emptyTimer");
        return;
    }
    if (session.emptyTimer) return;
    session.emptyTimer = setTimeout(() => {
        const current = sessions.get(guildId);
        const latestChannel = current?.guild.channels.cache.get(current.voiceChannelId);
        if (current && (!latestChannel || !latestChannel.members.some(member => !member.user.bot))) {
            void endSession(current, "Salí del canal porque quedó vacío.");
        }
    }, EMPTY_CHANNEL_DISCONNECT_MS);
    session.emptyTimer.unref?.();
}

async function executeButton(interaction, client) {
    const [, action, guildId] = interaction.customId.split(":");
    if (interaction.guildId !== guildId) {
        return interaction.reply({ content: "Este panel pertenece a otro servidor.", flags: MessageFlags.Ephemeral });
    }
    try {
        const result = await runControl(interaction, action);
        if (result === "queue") {
            return interaction.reply({ embeds: [queueEmbed(sessions.get(guildId))], flags: MessageFlags.Ephemeral });
        }
        if (result === "lyrics") {
            const session = sessions.get(guildId);
            if (!session?.currentTrack) throw new Error("No hay una canción actual.");
            const link = new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Buscar letra").setURL(lyricsSearchUrl(session.currentTrack));
            return interaction.reply({ content: `Busca la letra de **${clip(session.currentTrack.title, 180)}**.`, components: [new ActionRowBuilder().addComponents(link)], flags: MessageFlags.Ephemeral });
        }
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
        await updatePanel(sessions.get(guildId));
        return;
    } catch (error) {
        const payload = { content: `🎵 ${error.message}`, flags: MessageFlags.Ephemeral };
        if (interaction.deferred || interaction.replied) return interaction.followUp(payload).catch(() => {});
        return interaction.reply(payload).catch(() => {});
    }
}

module.exports = {
    FILTERS,
    MAX_PLAYLIST_IMPORT,
    MAX_QUEUE_SIZE,
    buildPanelEmbed,
    buildPanelComponents,
    consumeSearch,
    createSearchMenu,
    endSession,
    enqueueTracks,
    executeButton,
    getSettings,
    lyricsSearchUrl,
    queueEmbed,
    resolveQuery,
    runControl,
    scheduleEmptyChannelCheck,
    searchTracks,
    sessions,
    validateRequest
};
