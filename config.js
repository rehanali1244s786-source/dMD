import dotenv from 'dotenv';
dotenv.config();

const config = {
  // Identity & Pairing
  botName: process.env.BOT_NAME || 'DOCK MD',
  customPairCode: process.env.CUSTOM_PAIR_CODE || 'DOCKWIDE',
  prefix: process.env.PREFIX || '.',
  mode: process.env.BOT_MODE || 'public',
  sessionId: process.env.SESSION_ID || 'DOCK_MD_MAIN_SESSION',
  timezone: process.env.TIMEZONE || 'Asia/Karachi',
  port: parseInt(process.env.PORT || '3000', 10),

  // Owners List (Array of sanitized phone numbers)
  owners: (process.env.OWNER_NUMBERS || '923001234567')
    .split(',')
    .map((num) => num.replace(/[^0-9]/g, '').trim())
    .filter(Boolean),

  // Database Configuration
  useMongoAuth: process.env.USE_MONGO_AUTH === 'true',
  mongoUri: process.env.MONGODB_URI || '',

  // Feature Toggles
  autoRead: process.env.AUTO_READ === 'true',
  autoOnline: process.env.AUTO_ONLINE === 'true',
  antiLink: process.env.ANTI_LINK === 'true',
  antiSpam: process.env.ANTI_SPAM === 'true',
  antiDelete: process.env.ANTI_DELETE === 'true',

  // External API Keys
  apis: {
    openai: process.env.OPENAI_API_KEY || '',
    gemini: process.env.GEMINI_API_KEY || '',
    groq: process.env.GROQ_API_KEY || '',
    huggingface: process.env.HUGGINGFACE_API_KEY || '',
    openweather: process.env.OPENWEATHER_API_KEY || '',
    omdb: process.env.OMDB_API_KEY || '',
    tmdb: process.env.TMDB_API_KEY || '',
    giphy: process.env.GIPHY_API_KEY || '',
    pixabay: process.env.PIXABAY_API_KEY || '',
    unsplash: process.env.UNSPLASH_API_KEY || '',
    removebg: process.env.REMOVEBG_API_KEY || '',
    screenshot: process.env.SCREENSHOT_API_KEY || '',
    virustotal: process.env.VIRUSTOTAL_API_KEY || '',
    genius: process.env.GENIUS_ACCESS_TOKEN || '',
    currency: process.env.CURRENCY_API_KEY || '',
    // Keyless Free Base URLs
    popcat: 'https://api.popcat.xyz',
    waifuPics: 'https://api.waifu.pics',
    jikan: 'https://api.jikan.moe/v4',
    dictionary: 'https://api.dictionaryapi.dev/api/v2/entries/en'
  },

  // Standardized Styled Reply Strings
  messages: {
    ownerOnly: '❌ *DOCK MD ACCESS DENIED*\n_This command is restricted to the Bot Owner / Admin only._',
    groupOnly: '❌ *DOCK MD ALERT*\n_This command can only be executed inside a group._',
    adminOnly: '❌ *DOCK MD ALERT*\n_You must be a Group Admin to use this command._',
    botAdminRequired: '❌ *DOCK MD ALERT*\n_Please promote *DOCK MD* to Admin to perform this action._',
    wait: '⏳ *DOCK MD* _is processing your request, please wait..._',
    error: (errMessage) =>
      `⚠️ *DOCK MD SYSTEM ERROR*\n\`\`\`${errMessage || 'An unexpected error occurred.'}\`\`\`\n_Please try again later._`
  }
};

export default config;
