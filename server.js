import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import os from "os";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import sdk from "microsoft-cognitiveservices-speech-sdk";

dotenv.config();
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const upload = multer({ dest: path.join(os.tmpdir(), "voice") });
const PORT = process.env.PORT || 8080;

app.get("/health", (_, res) => res.status(200).send("OK"));

app.post("/stt/telegram", upload.single("voice"), async (req, res) => {
  const chatId = req.query.chatId || null;
  try {
    if (!req.file) return res.status(400).json({ error: "no_file" });

    const input = req.file.path;
    const wav = path.join(os.tmpdir(), `v${Date.now()}.wav`);

    await new Promise((resolve, reject) =>
      ffmpeg(input)
        .audioCodec("pcm_s16le")
        .audioChannels(1)
        .audioFrequency(16000)
        .format("wav")
        .on("end", resolve)
        .on("error", reject)
        .save(wav)
    );

    const { AZURE_SPEECH_KEY, AZURE_SPEECH_REGION } = process.env;
    if (!AZURE_SPEECH_KEY || !AZURE_SPEECH_REGION)
      return res.status(500).json({ error: "missing_env" });

    const speechConfig = sdk.SpeechConfig.fromSubscription(
      AZURE_SPEECH_KEY,
      AZURE_SPEECH_REGION
    );
    speechConfig.speechRecognitionLanguage = "he-IL";
    const audioConfig = sdk.AudioConfig.fromWavFileInput(fs.readFileSync(wav));
    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

    const text = await new Promise((resolve) =>
      recognizer.recognizeOnceAsync((r) => {
        recognizer.close();
        resolve(r.text || "");
      })
    );

    fs.unlinkSync(input);
    fs.unlinkSync(wav);

    if (!text) return res.status(500).json({ error: "stt_failed" });
    res.json({ text, chatId });
  } catch (e) {
    console.error("STT error:", e);
    res.status(500).json({ error: "stt_failed" });
  }
});

app.listen(PORT, () => console.log(`Relay running on :${PORT}`));
