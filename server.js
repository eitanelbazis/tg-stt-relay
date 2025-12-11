require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const sdk = require('microsoft-cognitiveservices-speech-sdk');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

// 1. SETUP LOGGING
console.log('--- SERVER STARTING ---');
console.log('FFmpeg Path:', ffmpegPath);

// 2. ENSURE UPLOADS DIRECTORY EXISTS
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  console.log('Uploads directory not found, creating it...');
  fs.mkdirSync(uploadDir);
}

ffmpeg.setFfmpegPath(ffmpegPath);
const app = express();
const upload = multer({ dest: uploadDir });
const port = process.env.PORT || 3000;

// Middleware for logging requests
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// HEALTH CHECK
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// CLEANUP HELPER (called per request, not on interval)
const cleanupFiles = (inputPath, outputPath) => {
  try {
    if (inputPath && fs.existsSync(inputPath)) {
      fs.unlinkSync(inputPath);
      console.log('Cleaned:', inputPath);
    }
    if (outputPath && fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
      console.log('Cleaned:', outputPath);
    }
  } catch (e) {
    console.error('Cleanup warning:', e.message);
  }
};

app.post('/stt/telegram', upload.single('voice'), async (req, res) => {
  console.log('Received POST /stt/telegram');
  let inputPath = null;
  let outputPath = null;

  try {
    const voiceFile = req.file;
    const chatId = req.body.chatId;

    if (!voiceFile) {
      console.error('Error: No voice file in request');
      return res.status(400).json({ error: 'No voice file uploaded' });
    }

    console.log(`File received: ${voiceFile.originalname}, Size: ${voiceFile.size}, Path: ${voiceFile.path}`);

    // 1. Convert OGG to WAV
    inputPath = voiceFile.path;
    outputPath = inputPath + '.wav';

    console.log('Starting FFmpeg conversion...');
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('FFmpeg timeout after 20s'));
      }, 20000);

      ffmpeg(inputPath)
        .toFormat('wav')
        .on('error', (err) => {
          clearTimeout(timeout);
          console.error('FFmpeg Error:', err);
          reject(err);
        })
        .on('end', () => {
          clearTimeout(timeout);
          console.log('FFmpeg conversion complete.');
          resolve();
        })
        .save(outputPath);
    });

    // 2. Send to Azure Speech
    console.log('Configuring Azure Speech SDK...');
    const speechConfig = sdk.SpeechConfig.fromSubscription(
      process.env.AZURE_SPEECH_KEY,
      process.env.AZURE_SPEECH_REGION
    );
    speechConfig.speechRecognitionLanguage = process.env.SPEECH_LANG || 'he-IL';

    const audioConfig = sdk.AudioConfig.fromWavFileInput(fs.readFileSync(outputPath));
    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

    console.log('Sending audio to Azure...');
    recognizer.recognizeOnceAsync((result) => {
      console.log('Azure Result Reason:', result.reason);

      // Cleanup files immediately
      cleanupFiles(inputPath, outputPath);

      if (result.reason === sdk.ResultReason.RecognizedSpeech) {
        console.log('Transcription:', result.text);
        res.json({ text: result.text, chatId: chatId });
      } else {
        console.error('Speech not recognized or canceled:', result);
        res.status(500).json({ error: 'Speech not recognized', details: result });
      }

      recognizer.close();
    }, (err) => {
      console.error('Azure Async Error:', err);
      cleanupFiles(inputPath, outputPath);
      res.status(500).json({ error: 'Azure STT failed', message: err.message });
      recognizer.close();
    });

  } catch (error) {
    console.error('CRITICAL ERROR (handled):', error);
    cleanupFiles(inputPath, outputPath);
    res.status(500).json({ 
      error: 'Transcription failed', 
      message: 'Please try again or type your message'
    });
  }
});

app.listen(port, () => {
  console.log(`STT Relay listening on port ${port}`);
});
