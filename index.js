require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const FormData = require('form-data');
const OpenAI = require('openai');
const puppeteer = require('puppeteer');

// Load environment variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SERPAPI_API_KEY = process.env.SERPAPI_API_KEY;

// Initialize Telegram Bot
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Maintain user conversation history
const userConversations = {};

// Function to search the web using SerpAPI
async function searchWeb(query) {
  try {
    const response = await axios.get('https://google.serper.dev/search', {
      params: {
        q: query,
        api_key: SERPAPI_API_KEY,
        gl: 'ru',
        hl: 'ru',
      },
    });
    return response.data;
  } catch (error) {
    console.error('Error searching the web:', error);
    return null;
  }
}

// Function to extract text from a webpage using Puppeteer
async function extractPageContent(url) {
  try {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2' });

    // Extract the main content of the page
    const content = await page.evaluate(() => {
      return document.body.innerText;
    });

    await browser.close();
    return content;
  } catch (error) {
    console.error('Error extracting page content:', error);
    return null;
  }
}

// Function to summarize content from multiple pages using OpenAI
async function summarizePagesContent(contents) {
  try {
    const prompt = `Проанализируй содержимое следующих страниц и составь краткий свой ответ:\n\n${contents
      .map((content, index) => `Сайт ${index + 1}:\n${content.slice(0, 5000)}`) // Ограничиваем объем текста для анализа
      .join('\n\n')}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500, // Увеличиваем количество токенов для более детального ответа
    });

    return response.choices[0].message.content;
  } catch (error) {
    console.error('Error summarizing pages content:', error);
    return null;
  }
}

// Function to determine if a search is required
async function isSearchRequired(query, chatId) {
  try {
    // Use the conversation history to provide context
    const conversationContext = userConversations[chatId]
      ? userConversations[chatId].map((msg) => `${msg.role}: ${msg.content}`).join('\n')
      : '';

    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content:
            'Ты помогаешь определить, требуется ли поиск в интернете для ответа на запрос пользователя. Ответь "да", если требуется, и "нет", если не требуется. если сам можещь ответить то не обязательно сказать да',
        },
        {
          role: 'user',
          content: `Контекст беседы:\n${conversationContext}\n\nЗапрос: "${query}". Требуется ли поиск в интернете?`,
        },
      ],
      max_tokens: 10,
    });

    return response.choices[0].message.content.trim().toLowerCase() === 'да';
  } catch (error) {
    console.error('Error determining if search is required:', error);
    return false;
  }
}

// Function to execute shell commands
async function executeCommand(command, chatId) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error executing command: ${error.message}`);
        bot.sendMessage(chatId, `Ошибка выполнения команды: ${error.message}`);
        reject(error);
      } else if (stderr) {
        console.error(`stderr: ${stderr}`);
        bot.sendMessage(chatId, `stderr: ${stderr}`);
        resolve(stderr);
      } else {
        console.log(`stdout: ${stdout}`);
        bot.sendMessage(chatId, `stdout: ${stdout}`);
        resolve(stdout);
      }
    });
  });
}

// Function to create and run a Node.js file
async function createAndRunNodeFile(code, chatId) {
  try {
    const fileName = `user_${chatId}_script.js`;
    const filePath = path.join(__dirname, fileName);

    // Step 1: Create the file
    fs.writeFileSync(filePath, code);
    bot.sendMessage(chatId, `Файл ${fileName} создан.`);

    // Step 2: Install dependencies if needed
    if (code.includes('require')) {
      bot.sendMessage(chatId, 'Устанавливаю необходимые библиотеки...');
      await executeCommand(`npm install --prefix ${__dirname}`, chatId);
    }

    // Step 3: Run the file
    bot.sendMessage(chatId, 'Запускаю файл...');
    const output = await executeCommand(`node ${filePath}`, chatId);

    // Step 4: Check for errors and send the output
    if (output.includes('Error')) {
      bot.sendMessage(chatId, 'Обнаружены ошибки. Пытаюсь исправить...');
      // Here you can add logic to fix errors using OpenAI
    } else {
      bot.sendMessage(chatId, `Файл успешно запущен. Вывод:\n${output}`);
    }

    // Clean up: Delete the file
    // fs.unlinkSync(filePath);
    bot.sendMessage(chatId, `Файл ${fileName} удален.`);
  } catch (error) {
    console.error('Error creating or running Node.js file:', error);
    bot.sendMessage(chatId, 'Ошибка при создании или запуске файла.');
  }
}

// Handle "/start" command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  userConversations[chatId] = []; // Initialize conversation history for the user
  bot.sendMessage(chatId, "Чем могу помочь?");
});

// Handle text messages
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  // Ignore messages that are commands (e.g., /start)
  if (msg.text && !msg.text.startsWith('/')) {
    try {
      const userMessage = msg.text;

      // Add the user message to the conversation history
      userConversations[chatId] = userConversations[chatId] || [];
      userConversations[chatId].push({ role: 'user', content: userMessage });

      // Check if the message is a request to create and run a Node.js file
      if (userMessage.toLowerCase().includes('создай файл') || userMessage.toLowerCase().includes('запусти код')) {
        const code = userMessage.replace(/создай файл|запусти код/gi, '').trim();
        await createAndRunNodeFile(code, chatId);
        return;
      }

      // Determine if a search is required
      const searchRequired = await isSearchRequired(userMessage, chatId);

      if (searchRequired) {
        // Perform a web search
        const searchResults = await searchWeb(userMessage);

        if (searchResults && searchResults.organic) {
          // Extract content from the top 3 pages
          const topResults = searchResults.organic.slice(0, 3);
          const pageContents = [];

          for (const result of topResults) {
            const content = await extractPageContent(result.link);
            if (content) {
              pageContents.push(content);
            }
          }

          if (pageContents.length > 0) {
            // Summarize the content from the pages
            const summary = await summarizePagesContent(pageContents);

            if (summary) {
              bot.sendMessage(chatId, summary);
            } else {
              bot.sendMessage(chatId, 'Не удалось проанализировать содержимое страниц.');
            }
          } else {
            bot.sendMessage(chatId, 'Не удалось извлечь содержимое страниц.');
          }
        } else {
          bot.sendMessage(chatId, 'Ничего не найдено.');
        }
      } else {
        // Get a response from ChatGPT
        const chatResponse = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: 'gpt-4o',
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
      }
    } catch (error) {
      console.error('Error:', error.response?.data || error.message);
      bot.sendMessage(chatId, 'Failed to process your message.');
    }
  }
});

// Handle voice messages
bot.on('voice', async (msg) => {
  const chatId = msg.chat.id;
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

    // Determine if a search is required
    const searchRequired = await isSearchRequired(transcription, chatId);

    if (searchRequired) {
      // Perform a web search
      const searchResults = await searchWeb(transcription);

      if (searchResults && searchResults.organic) {
        // Extract content from the top 3 pages
        const topResults = searchResults.organic.slice(0, 3);
        const pageContents = [];

        for (const result of topResults) {
          const content = await extractPageContent(result.link);
          if (content) {
            pageContents.push(content);
          }
        }

        if (pageContents.length > 0) {
          // Summarize the content from the pages
          const summary = await summarizePagesContent(pageContents);

          if (summary) {
            bot.sendMessage(chatId, summary);
          } else {
            bot.sendMessage(chatId, 'Не удалось проанализировать содержимое страниц.');
          }
        } else {
          bot.sendMessage(chatId, 'Не удалось извлечь содержимое страниц.');
        }
      } else {
        bot.sendMessage(chatId, 'Ничего не найдено.');
      }
    } else {
      // Get a response from ChatGPT
      const chatResponse = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o',
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

      bot.sendMessage(chatId, reply);
    }

    fs.unlinkSync(audioPath);
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    bot.sendMessage(chatId, 'Failed to process your voice message.');
  }
});

// Handle photo messages
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const fileId = msg.photo[msg.photo.length - 1].file_id; // Get the highest resolution image
  const userCaption = msg.caption; // Get the user's caption (description) for the image

  try {
    // Get the image file details from Telegram
    const file = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    // Add the image URL and caption (if provided) to the conversation history
    userConversations[chatId] = userConversations[chatId] || [];
    userConversations[chatId].push({
      role: 'user',
      content: [
        { type: 'text', text: userCaption || 'анализировать' }, // Use the user's caption if provided
        { type: 'image_url', image_url: { url: fileUrl } },
      ],
    });

    // Determine if a search is required based on the caption
    const searchRequired = userCaption ? await isSearchRequired(userCaption, chatId) : false;

    if (searchRequired) {
      // Perform a web search
      const searchResults = await searchWeb(userCaption);

      if (searchResults && searchResults.organic) {
        // Extract content from the top 3 pages
        const topResults = searchResults.organic.slice(0, 3);
        const pageContents = [];

        for (const result of topResults) {
          const content = await extractPageContent(result.link);
          if (content) {
            pageContents.push(content);
          }
        }

        if (pageContents.length > 0) {
          // Summarize the content from the pages
          const summary = await summarizePagesContent(pageContents);

          if (summary) {
            bot.sendMessage(chatId, summary);
          } else {
            bot.sendMessage(chatId, 'Не удалось проанализировать содержимое страниц.');
          }
        } else {
          bot.sendMessage(chatId, 'Не удалось извлечь содержимое страниц.');
        }
      } else {
        bot.sendMessage(chatId, 'Ничего не найдено.');
      }
    } else {
      // Call OpenAI API for image analysis
      const response = await openai.chat.completions.create({
        model: "gpt-4o", // Use the vision model
        messages: userConversations[chatId],
        max_tokens: 300, // Adjust as needed
      });

      // Retrieve the response from OpenAI
      const analysis = response.choices[0].message.content;
      bot.sendMessage(chatId, analysis);

      // Add the bot's response to the conversation history
      userConversations[chatId].push({ role: 'assistant', content: analysis });
    }
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    bot.sendMessage(chatId, 'Failed to analyze your image.');
  }
});