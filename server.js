const express = require('express');
const multer = require('multer');
const WebSocket = require('ws');
const fs = require('fs');

const app = express();
const upload = multer({ dest: '/tmp/' });

const SONIOX_WS_URL = 'wss://api.soniox.com/transcribe-websocket';
const SONIOX_API_KEY = process.env.SONIOX_API_KEY;

app.post('/stt/telegram', upload.single('voice'), async (req, res) => {
  const audioPath = req.file.path;
  const chatId = req.body.chatId || 'unknown';

  try {
    console.log(`[${chatId}] Starting Soniox real-time transcription...`);
    
    const audioBuffer = fs.readFileSync(audioPath);
    
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
      
      // Signal end
      ws.send(new Uint8Array(0));
    });

    ws.on('message', (data) => {
      try {
        const response = JSON.parse(data);
        
        if (response.fw && response.fw.length > 0) {
          transcription = response.fw.map(w => w.t).join(' ');
          console.log(`[${chatId}] Got: "${transcription}"`);
        }
        
        if (response.status === 'completed') {
          isDone = true;
          ws.close();
        }
      } catch (e) {
        console.error(`[${chatId}] Parse error:`, e);
      }
    });

    ws.on('error', (error) => {
      console.error(`[${chatId}] WS error:`, error);
      cleanup();
      if (!res.headersSent) {
        res.status(500).json({ error: error.message });
      }
    });

    ws.on('close', () => {
      cleanup();
      if (isDone && transcription) {
        res.json({
          text: transcription,
          chatId: chatId,
          provider: 'soniox-realtime'
        });
      } else if (!res.headersSent) {
        res.status(500).json({ error: 'Transcription incomplete' });
      }
    });

    const cleanup = () => {
      try {
        fs.unlinkSync(audioPath);
      } catch (e) {}
    };

    setTimeout(() => {
      if (!isDone) {
        ws.close();
        cleanup();
        if (!res.headersSent) {
          res.status(408).json({ error: 'Timeout' });
        }
      }
    }, 30000);

  } catch (error) {
    console.error(`[${chatId}] Error:`, error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Soniox real-time STT running on port ${PORT}`);
});
