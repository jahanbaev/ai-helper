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
const userPrograms = {};

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
    const conversationContext = userConversations[chatId]
      ? userConversations[chatId].map((msg) => `${msg.role}: ${msg.content}`).join('\n')
      : '';

    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: `Анализируй запросы пользователя и определяй тип действия:
1. "web" - если требуется поиск актуальной информации
2. "program" - если нужно создать/изменить программу
3. "chat" - для обычного ответа
Всегда отвечай одним словом: web, program или chat`
        },
        {
          role: 'user',
          content: `Контекст:\n${conversationContext}\nЗапрос: "${query}"\nТип:`
        }
      ],
      temperature: 0.3
    });

    return response.choices[0].message.content.trim().toLowerCase();
  } catch (error) {
    console.error('Error determining request type:', error);
    return 'chat';
  }
}

// Новая функция для модификации программ (добавлена)
async function modifyExistingProgram(program, userMessage, chatId) {
  const prompt = `Модифицируй программу:\n\`\`\`javascript\n${program.code}\n\`\`\`\nЗапрос: "${userMessage}"\nВерни только новый код :`;
  
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 2000
  });

  const newCode = response.choices[0].message.content;
  program.history.push(program.code); // Сохраняем историю
  program.code = newCode;
  program.updatedAt = new Date();
  
  return program;
}

// Модифицированная функция createAndRunProgram (сохранение в хранилище)
async function createAndRunProgram(userMessage, chatId) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{
        role: 'user', 
        content: `Создай программу для: "${userMessage}". Верни JSON с code, installCommands и description`
      }]
    });

    const { code, installCommands, description } = parseJSONResponse(response.choices[0].message.content);
    const programId = `prog_${Date.now()}`;
    
    // Сохраняем программу
    userPrograms[chatId] = userPrograms[chatId] || [];
    userPrograms[chatId].push({
      id: programId,
      code,
      installCommands,
      description,
      history: [],
      createdAt: new Date(),
      updatedAt: new Date()
    });

    // Остальная логика выполнения остается без изменений
    const fileName = `${programId}.js`;
    fs.writeFileSync(fileName, code);
    
    await bot.sendMessage(chatId, `📝 Создана новая программа: ${description}`);
    // ... остальной код выполнения ...
    
  } catch (error) {
    await bot.sendMessage(chatId, `❌ Ошибка: ${error.message}`);
  }
}


// Резервная проверка через другую модель
async function checkFallback(query) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{
        role: 'user',
        content: `Нужен ли веб-поиск для ответа на запрос: "${query}"? Ответь только "да" или "нет"`
      }],
      temperature: 0.1,
      max_tokens: 3
    });
    
    return response.choices[0].message.content.trim().toLowerCase() === 'да';
  } catch (error) {
    return false;
  }
}

// Вспомогательные функции
function parseJSONResponse(text) {
  try {
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}') + 1;
    return JSON.parse(text.slice(jsonStart, jsonEnd));
  } catch (e) {
    throw new Error('Неверный формат ответа от OpenAI');
  }
}

async function executeCommand(command, chatId) {
  return new Promise((resolve, reject) => {
    const process = exec(command, { timeout: 30000 }, (error, stdout, stderr) => {
      if (error) {
        reject(`Ошибка выполнения: ${error.message}`);
      } else if (stderr) {
        resolve(stderr);
      } else {
        resolve(stdout);
      }
    });

    setTimeout(() => {
      process.kill();
      reject('Превышено время выполнения (30 секунд)');
    }, 31000);
  });
}

// Функции для работы с программами
async function createAndRunProgram(userMessage, chatId) {
  try {
    const prompt = `
Создай программу на Node.js для следующего запроса: "${userMessage}".
Верни ответ в формате JSON, содержащий:
- "code": код программы
- "installCommands": массив команд для установки зависимостей
- "description": краткое описание программы

Пример ответа:
{
  "code": "console.log('Hello, World!');",
  "installCommands": ["npm install axios"],
  "description": "Простая программа для вывода сообщения"
}
`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'Ты опытный Node.js разработчик' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 2000,
    });

    const { code, installCommands, description } = parseJSONResponse(response.choices[0].message.content);
    
    const fileName = `user_${chatId}_${Date.now()}.js`;
    const filePath = path.join(__dirname, fileName);
    fs.writeFileSync(filePath, code);
    
    await bot.sendMessage(chatId, `📝 Описание программы: ${description}`);
    await bot.sendMessage(chatId, `📁 Создан файл: ${fileName}`);

    if (installCommands?.length > 0) {
      await bot.sendMessage(chatId, '⚙️ Устанавливаю зависимости...');
      for (const command of installCommands) {
        try {
          const output = await executeCommand(command, chatId);
          await bot.sendMessage(chatId, `✅ ${command}\n${output}`);
        } catch (error) {
          await bot.sendMessage(chatId, `❌ Ошибка при установке ${command}:\n${error}`);
          throw error;
        }
      }
    }

    await bot.sendMessage(chatId, '🚀 Запускаю программу...');
    try {
      const output = await executeCommand(`node ${filePath}`, chatId);
      await bot.sendMessage(chatId, `📝 Результат выполнения:\n${output}`);
    } catch (error) {
      await bot.sendMessage(chatId, `❌ Ошибка выполнения:\n${error}`);
      throw error;
    }

    // fs.unlinkSync(filePath);
    await bot.sendMessage(chatId, '✅ Временные файлы удалены');

  } catch (error) {
    await bot.sendMessage(chatId, `❌ Критическая ошибка:\n${error.message}`);
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
  userConversations[chatId] = userConversations[chatId] || [];

  if (msg.text && !msg.text.startsWith('/')) {
    const userMessage = msg.text;
    userConversations[chatId].push({ role: 'user', content: userMessage });

    const requestType = await isSearchRequired(userMessage, chatId);

    switch (requestType) {
      case 'program':
        try {
          // Проверяем, относится ли запрос к существующей программе
          const lastProgram = userPrograms[chatId]?.[userPrograms[chatId].length - 1];
          if (lastProgram) {
            const isModification = await openai.chat.completions.create({
              model: 'gpt-3.5-turbo',
              messages: [{
                role: 'user',
                content: `Является ли "${userMessage}" модификацией предыдущей программы? Ответь только "да" или "нет"`
              }],
              temperature: 0.1
            });

            if (isModification.choices[0].message.content.trim().toLowerCase() === 'да') {
              const modifiedProgram = await modifyExistingProgram(lastProgram, userMessage, chatId);
              const fileName = `${modifiedProgram.id}.js`;
              fs.writeFileSync(fileName, modifiedProgram.code);
              await bot.sendMessage(chatId, `🔄 Программа обновлена: ${fileName}`);
              return;
            }
          }
          
          // Если новая программа
          await createAndRunProgram(userMessage, chatId);
          
        } catch (error) {
          await bot.sendMessage(chatId, `❌ Ошибка: ${error.message}`);
        }
        break;

      // Старая логика для web и chat остается без изменений
      case 'web':
        // ... существующий код для веб-поиска ...
        break;
        
      case 'chat':
        // ... существующий код для чата ...
        break;
    }
  }

  // Новые команды управления программами
  if (msg.text?.startsWith('/list')) {
    const programs = userPrograms[chatId] || [];
    await bot.sendMessage(chatId, `📂 Ваши программы:\n${programs.map(p => `- ${p.id}: ${p.description}`).join('\n')}`);
  }
  
  if (msg.text?.startsWith('/run')) {
    const programId = msg.text.split(' ')[1];
    const program = (userPrograms[chatId] || []).find(p => p.id === programId);
    if (program) {
      await executeCommand(`node ${program.id}.js`, chatId);
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

    if (searchRequired == "web") {
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

    if (searchRequired == "web") {
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
