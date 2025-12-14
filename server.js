require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const axios = require('axios'); // For Soniox API calls

// 1. SETUP LOGGING
console.log('--- SONIOX STT RELAY STARTING ---');
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
  res.status(200).json({ 
    status: 'ok', 
    provider: 'soniox',
    uptime: Math.floor(process.uptime()),
    memory: Math.floor(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
  });
});

// CLEANUP HELPER
const cleanupFiles = (inputPath, outputPath) => {
  try {
    if (inputPath && fs.existsSync(inputPath)) {
      fs.unlinkSync(inputPath);
      console.log('Cleaned:', path.basename(inputPath));
    }
    if (outputPath && fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
      console.log('Cleaned:', path.basename(outputPath));
    }
  } catch (e) {
    console.error('Cleanup warning:', e.message);
  }
};

// SONIOX STT ENDPOINT
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

    console.log(`File received: ${voiceFile.originalname}, Size: ${voiceFile.size} bytes`);

    // 1. Convert OGG to WAV (16kHz mono - Soniox requirement)
    inputPath = voiceFile.path;
    outputPath = inputPath + '.wav';

    console.log('Starting FFmpeg conversion to 16kHz WAV...');
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('FFmpeg timeout after 20s'));
      }, 20000);

      ffmpeg(inputPath)
        .toFormat('wav')
        .audioFrequency(16000)  // Soniox requires 16kHz
        .audioChannels(1)        // Mono
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

    // 2. Read WAV file as base64 (Soniox API requirement)
    const audioBuffer = fs.readFileSync(outputPath);
    const audioBase64 = audioBuffer.toString('base64');

    console.log('Sending audio to Soniox API...');

    // 3. Call Soniox API
    const response = await axios.post(
      'https://api.soniox.com/transcribe-async',
      {
        audio: audioBase64,
        model: 'enhanced',  // or 'standard' for faster/cheaper
        language: 'he',      // Hebrew
        enable_entities: true,  // Converts "עשר וחצי" → "10:30"
        enable_profanity_filter: false,
        enable_dictation: true
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.SONIOX_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 25000  // 25 second timeout
      }
    );

    console.log('Soniox API Response:', response.status);

    // Cleanup files immediately
    cleanupFiles(inputPath, outputPath);

    // 4. Extract transcription
    if (response.data && response.data.result && response.data.result.length > 0) {
      const transcription = response.data.result[0].text;
      console.log('Transcription:', transcription);

      res.json({ 
        text: transcription, 
        chatId: chatId,
        provider: 'soniox'
      });
    } else {
      console.error('No transcription in Soniox response');
      res.status(500).json({ 
        error: 'No transcription result',
        details: response.data 
      });
    }

  } catch (error) {
    console.error('CRITICAL ERROR (handled):', error.message);
    
    // Log more details if it's an API error
    if (error.response) {
      console.error('Soniox API Error:', error.response.status, error.response.data);
    }
    
    cleanupFiles(inputPath, outputPath);
    
    res.status(500).json({ 
      error: 'Transcription failed', 
      message: error.message,
      hint: 'Check if SONIOX_API_KEY is set correctly'
    });
  }
});

app.listen(port, () => {
  console.log(`Soniox STT Relay listening on port ${port}`);
  console.log('API Key status:', process.env.SONIOX_API_KEY ? 'Configured ✓' : 'MISSING ✗');
});
