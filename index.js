require('dotenv').config();
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const FormData = require('form-data');

// Load environment variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Initialize Telegram Bot
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Maintain user conversation history
const userConversations = {};

// Handle "/start" command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  userConversations[chatId] = []; // Initialize conversation history for the user
  bot.sendMessage(
    chatId,
    "Welcome! Send me a text message or voice message, and I'll respond to you!"
  );
});

// Handle text messages
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  // Ignore messages that are not text (handled separately, e.g., voice messages)
  if (msg.text && !msg.text.startsWith('/')) {
    try {
      const userMessage = msg.text;

      // Add the user message to the conversation history
      userConversations[chatId] = userConversations[chatId] || [];
      userConversations[chatId].push({ role: 'user', content: userMessage });

      // Get a response from ChatGPT
      const chatResponse = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4',
          messages: userConversations[chatId],
        },
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const reply = chatResponse.data.choices[0].message.content;

      // Add the bot's response to the conversation history
      userConversations[chatId].push({ role: 'assistant', content: reply });

      // Send the response back to the user
      bot.sendMessage(chatId, reply);
    } catch (error) {
      console.error('Error:', error.response?.data || error.message);
      bot.sendMessage(chatId, 'Failed to process your message.');
    }
  }
});

// Handle voice messages
bot.on('voice', async (msg) => {
  const chatId = msg.chat.id;

  bot.sendMessage(chatId, 'Processing your voice message...');
  const fileId = msg.voice.file_id;

  try {
    // Get the voice message file
    const file = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const audioPath = path.join(__dirname, 'audio.ogg');

    // Download the file
    const writer = fs.createWriteStream(audioPath);
    const response = await axios({
      url: fileUrl,
      method: 'GET',
      responseType: 'stream',
    });
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    // Transcribe the audio file using OpenAI's API
    const formData = new FormData();
    formData.append('file', fs.createReadStream(audioPath));
    formData.append('model', 'whisper-1');

    const transcriptionResponse = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      formData,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          ...formData.getHeaders(),
        },
      }
    );

    const transcription = transcriptionResponse.data.text;
    userConversations[chatId] = userConversations[chatId] || [];
    userConversations[chatId].push({ role: 'user', content: transcription });

    // Get a response from ChatGPT
    const chatResponse = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4',
        messages: userConversations[chatId],
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const reply = chatResponse.data.choices[0].message.content;
    userConversations[chatId].push({ role: 'assistant', content: reply });

    bot.sendMessage(chatId, `Transcription: ${transcription}`);
    bot.sendMessage(chatId, `Answer: ${reply}`);

    fs.unlinkSync(audioPath);
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    bot.sendMessage(chatId, 'Failed to process your voice message.');
  }
});
