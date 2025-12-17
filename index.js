// index.js - Discord bot with in-memory pre-buffer for instant playback
import dotenv from "dotenv";
dotenv.config({ path: "./botid.env" });

import { spawn } from "child_process";
import { Client, GatewayIntentBits, REST, Routes } from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
} from "@discordjs/voice";
import ytSearch from "yt-search";
import { PassThrough } from "stream";

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("Missing TOKEN, CLIENT_ID or GUILD_ID in botid.env");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const queues = new Map(); // guildId -> { connection, player, songs: [{title,url,buffer}] }

// ---------------------- SLASH COMMANDS ----------------------
const commands = [
  { name: "ping", description: "Replies with Pong!" },
  { name: "hello", description: "Says hello!" },
  {
    name: "music",
    description: "Music player (yt-dlp + ffmpeg)",
    options: [
      {
        name: "play",
        type: 1,
        description: "Play music (YouTube link or search)",
        options: [{ name: "query", type: 3, description: "Link or search term", required: true }],
      },
      { name: "skip", type: 1, description: "Skip current song" },
      { name: "stop", type: 1, description: "Stop music and leave" },
      { name: "queue", type: 1, description: "Show queue" },
      { name: "pause", type: 1, description: "Pause playback" },
      { name: "resume", type: 1, description: "Resume playback" },
    ],
  },
];

const rest = new REST({ version: "10" }).setToken(TOKEN);

async function registerCommands() {
  try {
    console.log("Registering slash commands...");
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log("Slash commands registered!");
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
}

// ---------------------- AUDIO STREAM WITH BUFFER ----------------------
async function createBufferedStream(url, bufferSizeMB = 5) {
  console.log(`[createBufferedStream] Spawning yt-dlp for ${url}`);
  const ytdlp = spawn("yt-dlp", ["-o", "-", "-f", "bestaudio", url], { stdio: ["ignore", "pipe", "pipe"] });

  ytdlp.stderr.on("data", (d) => {
    // optional: log progress
    // console.log(`[yt-dlp] ${d.toString().trim()}`);
  });

  const ffmpeg = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-i", "pipe:0",
    "-f", "s16le",
    "-ar", "48000",
    "-ac", "2",
    "pipe:1",
  ], { stdio: ["pipe", "pipe", "pipe"] });

  ytdlp.stdout.pipe(ffmpeg.stdin);

  const passThrough = new PassThrough();
  let buffered = 0;
  const bufferLimit = bufferSizeMB * 1024 * 1024; // MB -> bytes

  ffmpeg.stdout.on("data", (chunk) => {
    buffered += chunk.length;
    passThrough.write(chunk);
  });

  ffmpeg.stdout.on("end", () => {
    passThrough.end();
  });

  // Wait until we have a few MB buffered before returning
  await new Promise((resolve, reject) => {
    const check = () => {
      if (buffered >= bufferLimit) resolve();
      else setTimeout(check, 10);
    };
    check();

    ffmpeg.on("error", reject);
    ytdlp.on("error", reject);
  });

  console.log(`[createBufferedStream] Buffered ${buffered} bytes, starting playback`);

  return { proc: { ytdlp, ffmpeg }, stream: passThrough };
}

// ---------------------- PLAY SONG ----------------------
async function playSong(guildId) {
  const server = queues.get(guildId);
  if (!server || server.songs.length === 0) {
    try { server?.connection?.destroy(); } catch {}
    queues.delete(guildId);
    return;
  }

  const song = server.songs[0];
  console.log(`[playSong] Starting: ${song.title} (${song.url}) at ${new Date().toISOString()}`);

  let audio;
  try {
    audio = song.buffer || await createBufferedStream(song.url, 5);
    song.buffer = audio; // save buffer
  } catch (err) {
    console.error("[playSong] failed to create audio stream:", err);
    server.songs.shift();
    return playSong(guildId);
  }

  const resource = createAudioResource(audio.stream, { inputType: StreamType.Raw });
  server.player.play(resource);
  server.playProcess = audio.proc;

  server.player.once(AudioPlayerStatus.Idle, () => {
    try { server.playProcess?.ytdlp?.kill(); } catch {}
    try { server.playProcess?.ffmpeg?.kill(); } catch {}
    server.songs.shift();
    setImmediate(() => playSong(guildId));
  });

  server.player.once("error", (err) => {
    console.error("[AudioPlayer ERROR]:", err);
    try { server.playProcess?.ytdlp?.kill(); } catch {}
    try { server.playProcess?.ffmpeg?.kill(); } catch {}
    server.songs.shift();
    setImmediate(() => playSong(guildId));
  });
}

// ---------------------- EVENTS ----------------------
client.on("clientReady", () => console.log(`Bot online as ${client.user.tag}`));

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, guildId, member, options } = interaction;

  if (commandName === "ping") return interaction.reply("Pong!");
  if (commandName === "hello") return interaction.reply("Hello 👋");

  if (commandName === "music") {
    const sub = options.getSubcommand();
    const voiceChannel = member?.voice?.channel;

    if (sub === "play") {
      if (!voiceChannel) return interaction.reply("❌ You must be in a voice channel.");
      await interaction.deferReply();

      let song;
      const query = options.getString("query");
      const isUrl = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i.test(query);

      try {
        let info;
        if (isUrl) {
          info = await ytSearch(query);
          const title = info?.videos?.[0]?.title || query;
          song = { title, url: query };
        } else {
          info = await ytSearch(query);
          if (!info?.videos?.length) return interaction.editReply("❌ No results found.");
          const v = info.videos[0];
          song = { title: v.title, url: v.url };
        }

        // Pre-buffer: start fetching 5MB immediately
        song.buffer = await createBufferedStream(song.url, 5);

      } catch (err) {
        console.error("[/music play] search error:", err);
        return interaction.editReply("❌ Failed to resolve the query.");
      }

      let server = queues.get(guildId);
      if (!server) {
        const player = createAudioPlayer();
        const connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId,
          adapterCreator: interaction.guild.voiceAdapterCreator,
        });

        server = { connection, player, songs: [song], playProcess: null };
        queues.set(guildId, server);
        connection.subscribe(player);

        try {
          await playSong(guildId);
          return interaction.editReply(`🎵 Now playing: **${song.title}**`);
        } catch (err) {
          console.error("[/music play] playSong failed:", err);
          queues.delete(guildId);
          try { connection.destroy(); } catch {}
          return interaction.editReply("❌ Failed to play the song.");
        }
      } else {
        server.songs.push(song);
        return interaction.editReply(`✅ Added **${song.title}** to the queue!`);
      }
    }

    if (sub === "skip") {
      return interaction.reply(`Song skipped **${song.title}**`);
    }
    // skip, stop, queue, pause, resume remain same as previous code
  }
});

// ---------------------- SAFETY ----------------------
process.on("unhandledRejection", (r) => console.error("Unhandled Rejection:", r));
process.on("uncaughtException", (err) => console.error("Uncaught Exception:", err));

// ---------------------- START ----------------------
(async () => {
  await registerCommands();
  await client.login(TOKEN);
})();
