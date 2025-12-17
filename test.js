import playdl from "play-dl";

const url = "https://www.youtube.com/watch?v=dWtqYlHneyI";

(async () => {
  const info = await playdl.video_info(url);
  console.log("Formats available:");
  console.log(info.format.map(f => ({ itag: f.itag, container: f.container, codec: f.codec, quality: f.quality_label, audio: f.audio })));
})();
