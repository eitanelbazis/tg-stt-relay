# tg-stt-relay (n8n + Telegram voice → Azure Speech)

## Endpoints
- `GET /health` → OK
- `POST /stt/telegram` (multipart/form-data)
  - file field: **voice** (the Telegram OGG/Opus)
  - text field: **chatId** (optional passthrough)

### n8n HTTP Request (v4.3) config
- Body Content Type: **Form-Data**
- Row 1: **n8n Binary File** → Name=`voice`, Input Data Field Name=`data`
- Row 2: **String** → Name=`chatId`, Value=`{{$json.chatId || $json.message?.chat?.id}}`
- Headers: **Off**

## Env
```
AZURE_SPEECH_KEY=...
AZURE_SPEECH_REGION=eastus2
SPEECH_LANG=he-IL
PORT=3000
```