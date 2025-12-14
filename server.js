require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const axios = require('axios');
const FormData = require('form-data');

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
    memory: Math.floor(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
    apiKeyConfigured: !!process.env.SONIOX_API_KEY
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

    // 1. Convert OGG to WAV (16kHz mono for Soniox)
    inputPath = voiceFile.path;
    outputPath = inputPath + '.wav';

    console.log('Starting FFmpeg conversion to 16kHz mono WAV...');
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

    // 2. Prepare multipart form data
    const formData = new FormData();
    formData.append('audio', fs.createReadStream(outputPath), {
      filename: 'audio.wav',
      contentType: 'audio/wav'
    });
    formData.append('model', 'enhanced');  // or 'standard' for faster/cheaper
    formData.append('language', 'he');      // Hebrew
    formData.append('enable_entities', 'true'); // Converts "עשר וחצי" → "10:30"

    console.log('Sending audio to Soniox API...');

    // 3. Call Soniox API
    const response = await axios.post(
      'https://api.soniox.com/v1/transcribe',
      formData,
      {
        headers: {
          'Authorization': `Bearer ${process.env.SONIOX_API_KEY}`,
          ...formData.getHeaders()
        },
        timeout: 25000  // 25 second timeout
      }
    );

    console.log('Soniox API Response Status:', response.status);

    // Cleanup files immediately
    cleanupFiles(inputPath, outputPath);

    // 4. Extract transcription
    if (response.data && response.data.words && response.data.words.length > 0) {
      // Soniox returns word-level data, concatenate to get full text
      const transcription = response.data.words.map(w => w.text).join(' ');
      console.log('Transcription:', transcription);

      res.json({ 
        text: transcription, 
        chatId: chatId,
        provider: 'soniox',
        confidence: response.data.words[0]?.confidence || null
      });
    } else if (response.data && response.data.text) {
      // Alternative: some responses have direct text field
      console.log('Transcription:', response.data.text);
      res.json({ 
        text: response.data.text, 
        chatId: chatId,
        provider: 'soniox'
      });
    } else {
      console.error('No transcription in Soniox response:', response.data);
      res.status(500).json({ 
        error: 'No transcription result',
        details: response.data 
      });
    }

  } catch (error) {
    console.error('CRITICAL ERROR (handled):', error.message);
    
    // Log more details if it's an API error
    if (error.response) {
      console.error('Soniox API Error Status:', error.response.status);
      console.error('Soniox API Error Data:', JSON.stringify(error.response.data));
    }
    
    cleanupFiles(inputPath, outputPath);
    
    res.status(500).json({ 
      error: 'Transcription failed', 
      message: error.message,
      hint: error.response ? 'Check Soniox API error above' : 'Check if SONIOX_API_KEY is set correctly'
    });
  }
});

app.listen(port, () => {
  console.log(`Soniox STT Relay listening on port ${port}`);
  console.log('API Key status:', process.env.SONIOX_API_KEY ? 'Configured ✓' : 'MISSING ✗');
});

