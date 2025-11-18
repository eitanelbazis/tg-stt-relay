const chatId =
  $json.chatId
  || $('Telegram Trigger – All').item.json.message?.chat?.id
  || $('Telegram Trigger – All').item.json.edited_message?.chat?.id
  || $('Telegram Trigger – All').item.json.channel_post?.chat?.id
  || $('Telegram Trigger – All').item.json.edited_channel_post?.chat?.id
  || $('Telegram Trigger – All').item.json.callback_query?.message?.chat?.id;

let reply = '';
let intent = 'other';
let slots = {};

const fromChain = $json;

// Case A: Chain already returned structured fields (after Structured Output Parser)
if (typeof fromChain?.reply === 'string') {
  reply = fromChain.reply;
  intent = fromChain.intent ?? 'other';
  slots = fromChain.slots ?? {};
} else {
  // Case B: Chain returned a JSON string in text/response
  const candidate = typeof $json.text === 'string'
    ? $json.text
    : (typeof $json.response === 'string' ? $json.response : '');
  if (candidate) {
    try {
      const obj = JSON.parse(candidate);
      reply = obj.reply ?? candidate;
      intent = obj.intent ?? 'other';
      slots  = obj.slots  ?? {};
    } catch {
      reply = candidate;
    }
  }
}

if (!reply || !String(reply).trim()) reply = 'איך אפשר לעזור?';

return { json: { chatId, reply, intent, slots } };
