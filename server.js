const express = require('express');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');

const app = express();
const upload = multer({ dest: '/tmp/' });

const SONIOX_API_KEY = process.env.SONIOX_API_KEY;

// Helper function for Soniox transcription
async function transcribeWithSoniox(audioPath, chatId) {
  const form = new FormData();
  form.append('audio', fs.createReadStream(audioPath));
  form.append('model', 'he_V2');

  try {
    const response = await axios.post(
      'https://api.soniox.com/transcribe',
      form,
      {
        headers: {
          'Authorization': `Bearer ${SONIOX_API_KEY}`,
          ...form.getHeaders()
        },
        timeout: 30000
      }
    );

    const transcription = response.data.words
      ?.map(w => w.text)
      .join(' ')
      .trim() || response.data.text || '';

    return transcription;
  } catch (error) {
    console.error(`[${chatId}] Soniox error:`, error.response?.data || error.message);
    throw error;
  }
}

// ============================================
// ENDPOINT 1: Telegram/WhatsApp Voice Messages
// ============================================
app.post('/stt/telegram', upload.single('voice'), async (req, res) => {
  const audioPath = req.file.path;
  const chatId = req.body.chatId || 'telegram-unknown';

  try {
    console.log(`[Telegram ${chatId}] Processing...`);
    
    const transcription = await transcribeWithSoniox(audioPath, chatId);
    
    console.log(`[Telegram ${chatId}] Result: "${transcription}"`);
    
    fs.unlinkSync(audioPath);
    
    res.json({
      text: transcription,
      chatId: chatId,
      provider: 'soniox',
      source: 'telegram'
    });
    
  } catch (error) {
    console.error(`[Telegram ${chatId}] Error:`, error.message);
    try { fs.unlinkSync(audioPath); } catch (e) {}
    res.status(500).json({ 
      error: error.response?.data?.message || error.message 
    });
  }
});

// ============================================
// ENDPOINT 2: Twilio Voice Calls
// ============================================
app.post('/stt/twilio', upload.single('file'), async (req, res) => {
  const audioPath = req.file.path;
  const callerId = req.body.From || req.body.CallSid || 'twilio-unknown';

  try {
    console.log(`[Twilio ${callerId}] Processing...`);
    
    const transcription = await transcribeWithSoniox(audioPath, callerId);
    
    console.log(`[Twilio ${callerId}] Result: "${transcription}"`);
    
    fs.unlinkSync(audioPath);
    
    res.json({
      text: transcription,
      chatId: callerId,
      provider: 'soniox',
      source: 'twilio'
    });
    
  } catch (error) {
    console.error(`[Twilio ${callerId}] Error:`, error.message);
    try { fs.unlinkSync(audioPath); } catch (e) {}
    res.status(500).json({ 
      error: error.response?.data?.message || error.message 
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    endpoints: ['/stt/telegram', '/stt/twilio']
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Soniox STT Server on port ${PORT}`);
});
