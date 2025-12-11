require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const sdk = require('microsoft-cognitiveservices-speech-sdk');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

// 1. SETUP & LOGGING
console.log('--- SERVER STARTING ---');
console.log(`FFmpeg Path: ${ffmpegPath}`);

// 2. ENSURE UPLOADS DIRECTORY EXISTS (Critical Fix)
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)){
    console.log('Uploads directory not found, creating it...');
    fs.mkdirSync(uploadDir);
}

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
// Configure Multer to use the ensured directory
const upload = multer({ dest: uploadDir });
const port = process.env.PORT || 3000;

// Middleware for logging requests
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

app.get('/health', (req, res) => res.send('OK'));

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
            ffmpeg(inputPath)
                .toFormat('wav')
                .on('error', (err) => {
                    console.error('FFmpeg Error:', err);
                    reject(err);
                })
                .on('end', () => {
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
        speechConfig.speechRecognitionLanguage = process.env.SPEECH_LANG || "he-IL";

        const audioConfig = sdk.AudioConfig.fromWavFileInput(fs.readFileSync(outputPath));
        const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

        console.log('Sending audio to Azure...');
        recognizer.recognizeOnceAsync(result => {
            console.log(`Azure Result Reason: ${result.reason}`);
            
            // Cleanup files immediately
            try {
                if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
            } catch (cleanupErr) {
                console.error('Cleanup warning:', cleanupErr);
            }

            if (result.reason === sdk.ResultReason.RecognizedSpeech) {
                console.log(`Transcription: ${result.text}`);
                res.json({
                    text: result.text,
                    chatId: chatId 
                });
            } else {
                console.error('Speech not recognized or canceled:', result);
                res.status(500).json({ error: 'Speech not recognized', details: result });
            }
            recognizer.close();
        }, (err) => {
             console.error('Azure Async Error:', err);
             res.status(500).send(err);
        });

    } catch (error) {
        console.error('CRITICAL SERVER ERROR:', error);
        // Attempt cleanup if crash happened mid-process
        try {
            if (inputPath && fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            if (outputPath && fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        } catch (e) {}
        
        res.status(500).send(error.message);
    }
});

app.listen(port, () => {
    console.log(`STT Relay listening on port ${port}`);
});
