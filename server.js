const express = require('express');
const multer = require('multer');
const WebSocket = require('ws');
const fs = require('fs');

const app = express();
const upload = multer({ dest: '/tmp/' });

const SONIOX_WS_URL = 'wss://api.soniox.com/transcribe-websocket';
const SONIOX_API_KEY = process.env.SONIOX_API_KEY;

// Helper function for Soniox WebSocket transcription
async function transcribeWithSoniox(audioBuffer, chatId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SONIOX_WS_URL, {
      headers: {
        'Authorization': `Basic ${SONIOX_API_KEY}`
      }
    });

    let transcription = '';
    let isDone = false;

    ws.on('open', () => {
      console.log(`[${chatId}] WebSocket connected`);
      
      // Send config
      ws.send(JSON.stringify({
        model: 'he_V2',
        include_nonfinal: false,
        enable_endpoint_detection: true
      }));

      // Send audio
      ws.send(audioBuffer);
      
      // Signal end of audio
      ws.send(new Uint8Array(0));
    });

    ws.on('message', (data) => {
      try {
        const response = JSON.parse(data);
        
        // Extract final words
        if (response.fw && response.fw.length > 0) {
          transcription = response.fw.map(w => w.t).join(' ');
          console.log(`[${chatId}] Transcribed: "${transcription}"`);
        }
        
        // Check if complete
        if (response.status === 'completed') {
          isDone = true;
          ws.close();
        }
      } catch (e) {
        console.error(`[${chatId}] Parse error:`, e);
      }
    });

    ws.on('error', (error) => {
      console.error(`[${chatId}] WebSocket error:`, error);
      reject(error);
    });

    ws.on('close', () => {
      if (isDone && transcription) {
        resolve(transcription);
      } else {
        reject(new Error('Transcription incomplete'));
      }
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      if (!isDone) {
        ws.close();
        reject(new Error('Transcription timeout'));
      }
    }, 30000);
  });
}

// ============================================
// ENDPOINT 1: Telegram/WhatsApp Voice Messages
// ============================================
app.post('/stt/telegram', upload.single('voice'), async (req, res) => {
  const audioPath = req.file.path;
  const chatId = req.body.chatId || 'telegram-unknown';

  try {
    console.log(`[Telegram ${chatId}] Processing voice message...`);
    
    const audioBuffer = fs.readFileSync(audioPath);
    const transcription = await transcribeWithSoniox(audioBuffer, chatId);
    
    // Cleanup
    fs.unlinkSync(audioPath);
    
    res.json({
      text: transcription,
      chatId: chatId,
      provider: 'soniox-realtime',
      source: 'telegram'
    });
    
  } catch (error) {
    console.error(`[Telegram ${chatId}] Error:`, error);
    try { fs.unlinkSync(audioPath); } catch (e) {}
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ENDPOINT 2: Twilio Voice Calls
// ============================================
app.post('/stt/twilio', upload.single('file'), async (req, res) => {
  const audioPath = req.file.path;
  const callerId = req.body.From || req.body.CallSid || 'twilio-unknown';

  try {
    console.log(`[Twilio ${callerId}] Processing voice recording...`);
    
    const audioBuffer = fs.readFileSync(audioPath);
    const transcription = await transcribeWithSoniox(audioBuffer, callerId);
    
    // Cleanup
    fs.unlinkSync(audioPath);
    
    res.json({
      text: transcription,
      chatId: callerId,
      provider: 'soniox-realtime',
      source: 'twilio'
    });
    
  } catch (error) {
    console.error(`[Twilio ${callerId}] Error:`, error);
    try { fs.unlinkSync(audioPath); } catch (e) {}
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    endpoints: ['/stt/telegram', '/stt/twilio'],
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Soniox STT Server running on port ${PORT}`);
  console.log(`   - Telegram endpoint: /stt/telegram`);
  console.log(`   - Twilio endpoint: /stt/twilio`);
});
