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

const SONIOX_API_BASE = 'https://api.soniox.com/v1';

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
        .audioFrequency(16000)
        .audioChannels(1)
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

    // 2. STEP 1: Upload file to Soniox
    console.log('Step 1: Uploading file to Soniox...');
    const uploadForm = new FormData();
    uploadForm.append('file', fs.createReadStream(outputPath), {
      filename: 'audio.wav',
      contentType: 'audio/wav'
    });

    const uploadResponse = await axios.post(
      `${SONIOX_API_BASE}/files`,
      uploadForm,
      {
        headers: {
          'Authorization': `Bearer ${process.env.SONIOX_API_KEY}`,
          ...uploadForm.getHeaders()
        },
        timeout: 30000
      }
    );

    const fileId = uploadResponse.data.id;
    console.log(`File uploaded successfully. File ID: ${fileId}`);

    // 3. STEP 2: Create transcription
    console.log('Step 2: Creating transcription...');
const transcriptionResponse = await axios.post(
  `${SONIOX_API_BASE}/transcriptions`,
  {
    model: 'stt-async-v3', 
    file_id: fileId,
    language: 'he'         
  },
      {
        headers: {
          'Authorization': `Bearer ${process.env.SONIOX_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    const transcriptionId = transcriptionResponse.data.id;
    console.log(`Transcription created. ID: ${transcriptionId}. Status: ${transcriptionResponse.data.status}`);

    // 4. STEP 3: Poll for completion (max 30 seconds)
    console.log('Step 3: Polling for transcription completion...');
    let status = transcriptionResponse.data.status;
    let attempts = 0;
    const maxAttempts = 30;

    while (status !== 'completed' && status !== 'error' && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
      attempts++;

    const statusResponse = await axios.get(
  `${SONIOX_API_BASE}/transcriptions/${transcriptionId}`,
  {
    headers: {
      'Authorization': `Bearer ${process.env.SONIOX_API_KEY}`
    }
  }
);

status = statusResponse.data.status;
console.log(`Polling attempt ${attempts}: Status = ${status}`);

// ADD THIS: Log full response when error
if (status === 'error') {
  console.error('❌ SONIOX ERROR DETAILS:', JSON.stringify(statusResponse.data, null, 2));
}
    }

    if (status === 'error') {
      throw new Error('Transcription failed on Soniox side');
    }

    if (status !== 'completed') {
      throw new Error(`Transcription timeout after ${maxAttempts} seconds`);
    }

    // 5. STEP 4: Get transcript
    console.log('Step 4: Fetching transcript...');
    const transcriptResponse = await axios.get(
      `${SONIOX_API_BASE}/transcriptions/${transcriptionId}/transcript`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.SONIOX_API_KEY}`
        }
      }
    );

    const transcription = transcriptResponse.data.text;
    console.log('Transcription:', transcription);

    // Cleanup files
    cleanupFiles(inputPath, outputPath);

    // Return result
    res.json({ 
      text: transcription, 
      chatId: chatId,
      provider: 'soniox',
      transcriptionId: transcriptionId
    });

  } catch (error) {
    console.error('CRITICAL ERROR (handled):', error.message);
    
    if (error.response) {
      console.error('Soniox API Error Status:', error.response.status);
      console.error('Soniox API Error Data:', JSON.stringify(error.response.data));
    }
    
    cleanupFiles(inputPath, outputPath);
    
    res.status(500).json({ 
      error: 'Transcription failed', 
      message: error.message,
      hint: error.response ? `Soniox API error: ${error.response.status}` : 'Check if SONIOX_API_KEY is set correctly'
    });
  }
});

app.listen(port, () => {
  console.log(`Soniox STT Relay listening on port ${port}`);
  console.log('API Key status:', process.env.SONIOX_API_KEY ? 'Configured ✓' : 'MISSING ✗');
});
