console.log('boot', { dryRun: process.env.DRY_RUN || '0', node: process.version });
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const morgan = require('morgan');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffmpeg = require('fluent-ffmpeg');
const { Readable } = require('stream');
const sdk = require('microsoft-cognitiveservices-speech-sdk');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(morgan('tiny'));

app.get('/health', (_req, res) => res.status(200).send('OK'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
});

function withTimeout(promise, ms, label = 'op') {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}_timeout`)), ms)),
  ]);
}

async function oggToWav16k(buffer) {
  return await withTimeout(new Promise((resolve, reject) => {
    const input = Readable.from(buffer);
    const cmd = ffmpeg()
      .input(input)
      .audioChannels(1)
      .audioFrequency(16000)
      .audioCodec('pcm_s16le')
      .format('wav')
      .on('start', c => console.log('ffmpeg_start', c))
      .on('error', e => reject(e));

    const chunks = [];
    const out = cmd.pipe();
    out.on('data', d => chunks.push(d));
    out.on('end', () => resolve(Buffer.concat(chunks)));
    out.on('error', reject);
  }), 7000, 'ffmpeg');
}

function makeSpeechConfig() {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key || !region) {
    const err = new Error('missing_azure_env');
    err.code = 'missing_azure_env';
    throw err;
  }
  const speechConfig = sdk.SpeechConfig.fromSubscription(key, region);
  speechConfig.speechRecognitionLanguage = process.env.SPEECH_LANG || 'he-IL';
  return speechConfig;
}

function recognizeOnceFromWavBuffer(wavBuffer) {
  return new Promise((resolve, reject) => {
    const pushStream = sdk.AudioInputStream.createPushStream();
    pushStream.write(wavBuffer);
    pushStream.close();

    let recognizer;
    try {
      const speechConfig = makeSpeechConfig();
      const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
      recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
    } catch (e) {
      return reject(e);
    }

    recognizer.recognizeOnceAsync(
      (result) => {
        recognizer.close();
        if (result.reason === sdk.ResultReason.RecognizedSpeech) return resolve(result.text || '');
        if (result.reason === sdk.ResultReason.NoMatch) return resolve('');
        return reject(new Error(result.errorDetails || 'speech_failed'));
      },
      (err) => {
        recognizer.close();
        reject(err);
      }
    );
  });
}

app.post('/stt/telegram', upload.single('voice'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no_file' });

    if (process.env.DRY_RUN === '1') {
      return res.json({ ok: true, bytes: req.file.size, mimetype: req.file.mimetype });
    }

    console.log('convert_start', req.file.mimetype, req.file.size);
    const wavBuffer = await oggToWav16k(req.file.buffer);
    console.log('convert_ok', wavBuffer.length);

    console.log('stt_start');
    const text = await withTimeout(recognizeOnceFromWavBuffer(wavBuffer), 15000, 'speech');
    console.log('stt_ok', text.length);

    const chatId = req.body?.chatId || null;
    return res.json({ text, chatId });
  } catch (err) {
    console.error('stt_route_error', err.message);
    return next(err);
  }
});

app.use((err, _req, res, _next) => {
  if (err && err.name === 'MulterError') {
    return res.status(400).json({ error: 'multer', code: err.code, message: err.message });
  }
  if (err && err.code === 'missing_azure_env') {
    return res.status(500).json({ error: 'config', message: 'Missing AZURE_SPEECH_KEY or AZURE_SPEECH_REGION' });
  }
  console.error('unhandled_error', err);
  return res.status(500).json({ error: 'server', message: err?.message || 'internal error' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => { console.log(`stt relay listening on ${port}`); });
