import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import sdk from 'microsoft-cognitiveservices-speech-sdk';
import FF from '@ffmpeg-installer/ffmpeg';

const app = express();
const PORT = process.env.PORT || 8080;

const ffmpegPath = FF.path;
process.env.FFMPEG_PATH = ffmpegPath;

const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY || process.env.AZURE_SPEECH_KEY_1 || '';
const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION || '';

const upload = multer({
  dest: path.join(os.tmpdir(), 'tg-voice'),
  limits: { fileSize: 25 * 1024 * 1024 }
});

app.get('/health', (_req, res) => res.status(200).send('OK'));

app.get('/envcheck', (_req, res) => {
  res.json({
    hasKey: !!AZURE_SPEECH_KEY,
    region: AZURE_SPEECH_REGION || null,
    ffmpegPath,
    nodeEnv: process.env.NODE_ENV || null
  });
});

app.post('/stt/telegram', upload.single('voice'), async (req, res) => {
  const chatId = req.query.chatId || req.body?.chatId || null;

  try {
    if (!AZURE_SPEECH_KEY || !AZURE_SPEECH_REGION) {
      return res.status(500).json({ error: 'stt_failed', reason: 'missing_azure_env' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'no_file' });
    }

    const inFile = req.file.path;
    const outFile = path.join(os.tmpdir(), `tg-${Date.now()}-16000.wav`);

    await new Promise((resolve, reject) => {
      const ff = spawn(ffmpegPath, ['-y', '-i', inFile, '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '16000', outFile]);
      ff.on('error', reject);
      ff.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg_exit_${code}`))));
    });

    const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_SPEECH_KEY, AZURE_SPEECH_REGION);
    speechConfig.speechRecognitionLanguage = 'he-IL';

    const pushStream = sdk.AudioInputStream.createPushStream(
      sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1)
    );

    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(outFile);
      rs.on('data', chunk => pushStream.write(chunk));
      rs.on('end', () => { pushStream.close(); resolve(); });
      rs.on('error', reject);
    });

    const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

    const text = await new Promise(resolve => {
      const timer = setTimeout(() => {
        try { recognizer.close(); } catch {}
        resolve('');
      }, 15000);
      recognizer.recognizeOnceAsync(result => {
        clearTimeout(timer);
        try { recognizer.close(); } catch {}
        resolve(result?.text || '');
      });
    });

    try { fs.unlinkSync(inFile); } catch {}
    try { fs.unlinkSync(outFile); } catch {}

    if (!text) {
      return res.status(500).json({ error: 'stt_failed' });
    }

    return res.json({ text, chatId });
  } catch (err) {
    try { if (req.file?.path) fs.unlinkSync(req.file.path); } catch {}
    return res.status(500).json({ error: 'stt_failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Listening on ${PORT}`);
});
