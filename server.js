require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const sdk = require('microsoft-cognitiveservices-speech-sdk');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const upload = multer({ dest: 'uploads/' });
const port = process.env.PORT || 3000;

app.get('/health', (req, res) => res.send('OK'));

app.post('/stt/telegram', upload.single('voice'), async (req, res) => {
    try {
        const voiceFile = req.file;
        const chatId = req.body.chatId;

        if (!voiceFile) {
            return res.status(400).json({ error: 'No voice file uploaded' });
        }

        // 1. Convert OGG to WAV (Azure needs WAV/PCM)
        const inputPath = voiceFile.path;
        const outputPath = inputPath + '.wav';

        await new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .toFormat('wav')
                .on('error', (err) => reject(err))
                .on('end', () => resolve())
                .save(outputPath);
        });

        // 2. Send to Azure Speech
        const speechConfig = sdk.SpeechConfig.fromSubscription(
            process.env.AZURE_SPEECH_KEY,
            process.env.AZURE_SPEECH_REGION
        );
        speechConfig.speechRecognitionLanguage = process.env.SPEECH_LANG || "he-IL";

        const audioConfig = sdk.AudioConfig.fromWavFileInput(fs.readFileSync(outputPath));
        const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

        recognizer.recognizeOnceAsync(result => {
            // Cleanup files
            fs.unlinkSync(inputPath);
            fs.unlinkSync(outputPath);

            if (result.reason === sdk.ResultReason.RecognizedSpeech) {
                res.json({
                    text: result.text,
                    chatId: chatId // Echo back the ID so n8n knows who sent it
                });
            } else {
                res.status(500).json({ error: 'Speech not recognized', details: result });
            }
            recognizer.close();
        });

    } catch (error) {
        console.error(error);
        res.status(500).send(error.message);
    }
});

app.listen(port, () => {
    console.log(`STT Relay listening on port ${port}`);
});
