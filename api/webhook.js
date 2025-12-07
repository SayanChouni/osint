// FILE: index.js
// Minimal inline comments; configuration & why-notes only where appropriate.

// --- Required libs ---
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const { MongoClient } = require('mongodb');

// --- NETWORK: Browser-like headers to bypass "use a browser" pages ---
const BROWSER_HEADERS = {
  timeout: 15000,
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*"
  }
};

// --- CONFIG: Environment Variables (sane defaults where applicable) ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'osint_user_db';
const COLLECTION_NAME = process.env.COLLECTION_NAME || 'users';
const ADMIN_USER_ID = process.env.ADMIN_USER_ID ? parseInt(process.env.ADMIN_USER_ID, 10) : null;

const MANDATORY_CHANNEL_ID = process.env.MANDATORY_CHANNEL_ID || '-1002516081531'; // can be group id
const GROUP_JOIN_LINK = "https://t.me/+3TSyKHmwOvRmNDJl"; // FINAL: confirmed by you (A)

// API keys: prefer environment variables; fallback to old keys if present
const API_CONFIG = {
  NUM_API_SUITE: {
    NAME_FINDER: process.env.APISUITE_NAMEFINDER || "https://m.apisuite.in/?api=namefinder&api_key=2907591571c0d74b89dc1244a1bb1715&number=",
    AADHAAR_FINDER: process.env.APISUITE_AADHAAR || "https://m.apisuite.in/?api=number-to-aadhaar&api_key=2907591571c0d74b89dc1244a1bb1715&number="
  },
  ADHAR_API: process.env.ADHAR_API || "https://aadhar-info-vishal.0001.net/api2/V2/adhar.php",
  VECHIL_API: process.env.VECHIL_API || "https://reseller-host.vercel.app/api/rc",
  PIN_API: process.env.PIN_API || "https://pin-code-info-vishal.22web.org/pincode_api.php",
  ADHAR_KEY: process.env.ADHAR_KEY || "FREE"
};

// Cost & trial settings
const FREE_TRIAL_LIMIT = parseInt(process.env.FREE_TRIAL_LIMIT || "1", 10);
const COST_PER_SEARCH = parseInt(process.env.COST_PER_SEARCH || "2", 10);

// Maintenance mode toggle (admin only bypass)
let MAINTENANCE_MODE = (process.env.MAINTENANCE_MODE === '1');

// --- MongoDB client setup (tuned for serverless) ---
if (!MONGODB_URI) {
  console.error("MONGODB_URI is required in env.");
  process.exit(1);
}

const mongoClient = new MongoClient(MONGODB_URI, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  // small pool to avoid serverless overload
  maxPoolSize: 1
});

let usersCollection = null;
async function connectDB() {
  if (usersCollection) return;
  await mongoClient.connect();
  const db = mongoClient.db(DB_NAME);
  usersCollection = db.collection(COLLECTION_NAME);
}

// --- Telegraf bot init ---
if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is required in env.");
  process.exit(1);
}
const bot = new Telegraf(BOT_TOKEN);

// --- Utility functions ---
async function getUserData(userId) {
  await connectDB();
  const user = await usersCollection.findOne({ _id: userId });
  if (!user) {
    const newUser = {
      _id: userId,
      balance: 0,
      search_count: 0,
      is_suspended: false,
      role: (userId === ADMIN_USER_ID ? 'admin' : 'user'),
      admin_state: null
    };
    await usersCollection.insertOne(newUser);
    return newUser;
  }
  return user;
}

// Returns true if the user is member/creator/admin in mandatory group
async function checkMembership(ctx) {
  try {
    const member = await ctx.telegram.getChatMember(MANDATORY_CHANNEL_ID, ctx.from.id);
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch (err) {
    console.error("Membership check error:", err.message);
    return false;
  }
}

// --- NEW: Pretty inline text report (Simple Clean Style) ---
function safeString(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v, null, 2);
  return String(v);
}

function buildSimpleReport(title, meta = {}, body = null) {
  // title: string, meta: object of simple key-values (phone, status...), body: object or string (printed as code block)
  const lines = [];
  lines.push(`✨ *${escapeMD(title)}* ✨`);
  lines.push('');
  // meta bullets
  for (const [k, v] of Object.entries(meta)) {
    lines.push(`🔹 *${escapeMD(String(k).toUpperCase())}:* ${escapeMD(safeString(v))}`);
  }
  if (body !== null) {
    lines.push('');
    // include JSON/code block for body
    const bodyText = (typeof body === 'object') ? JSON.stringify(body, null, 2) : String(body);
    lines.push('📄 *DATA:*');
    lines.push('```');
    lines.push(bodyText);
    lines.push('```');
  }
  return lines.join('\n');
}

// Minimal Markdown escaping for Telegram Markdown
function escapeMD(text) {
  return String(text)
    .replace(/([_*[\]()`~>#+-=|{}.!])/g, '\\$1');
}

async function sendTextReport(ctx, title, meta = {}, body = null) {
  try {
    const msg = buildSimpleReport(title, meta, body);
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error("Error sending text report:", err.message);
    await ctx.reply(`⚠️ *DISPLAY ERROR*: ${escapeMD(err.message)}`, { parse_mode: 'Markdown' });
  }
}

// --- Middleware: checks & charges ---
bot.use(async (ctx, next) => {
  // Some updates may not have message (e.g., callback_query), extract text safely
  const text = (ctx.message && ctx.message.text) ? ctx.message.text.trim() : '';
  const isCommand = text && /^\/(num|adr|v|pin|balance|donate|support|buyapi|admin|status)\b/.test(text);

  // always allow /start through (handled in start)
  if (text.startsWith('/start')) return next();

  // Only process commands in private chat
  const chatType = (ctx.chat && ctx.chat.type) ? ctx.chat.type : 'private';
  if (isCommand && chatType !== 'private') {
    return ctx.reply('⚠️ **PLEASE USE THIS BOT IN PRIVATE CHAT.** ⚠️', { parse_mode: 'Markdown' });
  }

  // Maintenance mode block (admin bypass)
  if (MAINTENANCE_MODE && ctx.from.id !== ADMIN_USER_ID) {
    return ctx.reply('🛠️ **MAINTENANCE MODE!**\n\n**The bot is currently under maintenance. Please try again later.**', { parse_mode: 'Markdown' });
  }

  if (isCommand) {
    const userData = await getUserData(ctx.from.id);

    // Admin inline input handling: if admin has admin_state and sends text (not /admin), allow handler to process later
    if (userData.role === 'admin' && userData.admin_state && !text.startsWith('/admin')) {
      // let downstream handlers handle it (stateful admin)
      return next();
    }

    if (userData.is_suspended) {
      return ctx.reply('⚠️ **ACCOUNT SUSPENDED!** 🚫\n\n**PLEASE CONTACT THE ADMIN.**', { parse_mode: 'Markdown' });
    }

    // Membership enforcement
    const isMember = await checkMembership(ctx);
    if (!isMember) {
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.url("🔒 JOIN MANDATORY GROUP", GROUP_JOIN_LINK)]
      ]);
      return ctx.reply('⛔️ **ACCESS REQUIRED!** ⛔️\n\n**YOU MUST BE A MEMBER OF THE GROUP TO USE COMMANDS. Use /start.**', keyboard);
    }

    // Credit / trial deduction (skip for admin and non-charge commands)
    if (userData.role !== 'admin' && !/^\/(balance|donate|support|buyapi)\b/.test(text)) {
      const isFree = userData.search_count < FREE_TRIAL_LIMIT;
      const hasBalance = userData.balance >= COST_PER_SEARCH;

      if (!isFree && !hasBalance) {
        const insufficientBalanceMessage = `
⚠️ **INSUFFICIENT BALANCE!**

**YOU HAVE ALREADY USED YOUR ${FREE_TRIAL_LIMIT} FREE SEARCH.**
**TO CONTINUE USING THE BOT, PLEASE RECHARGE A MINIMUM OF ₹25 TO ADD CREDITS TO YOUR ACCOUNT.**

**AFTER RECHARGE, YOU WILL BE ABLE TO USE ALL FEATURES WITHOUT ANY INTERRUPTION! 🔥**
**FOR CREDIT TOP-UP, PLEASE CONTACT: @ZECBOY 📩**
**THANK YOU FOR USING OUR SERVICE! 😊💙**`;
        return ctx.reply(insufficientBalanceMessage, { parse_mode: 'Markdown' });
      }

      // Deduct or increment usage count atomically
      const updateOps = { $inc: { search_count: 1 } };
      if (!isFree) updateOps.$inc.balance = -COST_PER_SEARCH;
      await usersCollection.updateOne({ _id: ctx.from.id }, updateOps);
      const updated = await usersCollection.findOne({ _id: ctx.from.id });
      const freeLeft = Math.max(0, FREE_TRIAL_LIMIT - updated.search_count);
      await ctx.reply(`💳 **TRANSACTION SUCCESSFUL!**\n\n**COST:** ${isFree ? '0' : COST_PER_SEARCH} TK. **BALANCE LEFT:** ${updated.balance} TK. **FREE USES LEFT:** ${freeLeft}.`, { parse_mode: 'Markdown' });
    }
  }

  return next();
});

// --- COMMAND: /start ---
bot.start(async (ctx) => {
  const isMember = await checkMembership(ctx);
  if (isMember) {
    const welcomeMessage = `
**┏━━✨ INFORA PRO ✨━━┓**

👋 **Hey! I’m your OSINT/Search copilot—fast, precise & private.**
📊 **ONE TIME FREE TRIAL**
**• PER searches cost ${COST_PER_SEARCH} credit 💳**
**• Works in BOT only for privacy 👥🔐**

**— — — — — — — — — — — — — — — — — —**
🔎 **Basic Lookups**
• /num <phone> — 10-digit mobile details
• /adr <aadhar> — Aadhaar (12-digit) info
• /familyinfo <aadhar> — Family lookup (not implemented)
• /v <vehicle> — Vehicle number lookup
• /pin <pincode> — Area pin code look up
**— — — — — — — — — — — — — — — — — —**
**⚡️ Powered by: @zecboy**
**🌐 Stay Safe • Respect Privacy • Use Responsibly 🚀**
`;
    return ctx.reply(welcomeMessage, { parse_mode: 'Markdown' });
  } else {
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.url("🔒 JOIN MANDATORY GROUP", GROUP_JOIN_LINK)]
    ]);
    return ctx.reply('👋 **WELCOME TO OSINT BOT!** 🥳\n\n**THIS BOT WORKS ONLY IN PRIVATE CHAT.**\n**YOU GET 1 FREE SEARCH! EACH SEARCH COSTS 2 TK AFTER TRIAL.**\n\n**YOU MUST JOIN THE GROUP BELOW TO USE COMMANDS:**', keyboard);
  }
});

// --- COMMAND: /balance ---
bot.command('balance', async (ctx) => {
  const user = await getUserData(ctx.from.id);
  const usesLeft = Math.max(0, FREE_TRIAL_LIMIT - user.search_count);
  return ctx.reply(`💰 **YOUR ACCOUNT BALANCE** 💰\n\n**BALANCE:** ${user.balance} TK\n**FREE USES LEFT:** ${usesLeft}`, { parse_mode: 'Markdown' });
});

// --- SIMPLE SUPPORT COMMANDS ---
const supportResponse = '**✨ MESSAGE HERE**\n\n**F E E L . F R E E . T O . D M**\n\n**👉 @zecboy**';
bot.command(['donate', 'support', 'buyapi'], (ctx) => ctx.reply(supportResponse, { parse_mode: 'Markdown' }));

// --- HELPER: generic fetch+send used by /adr, /v, /pin ---
async function fetchAndSendReport(ctx, apiUrl, targetValue, targetName) {
  if (!targetValue) {
    return ctx.reply(`👉 **INPUT MISSING!** 🥺\n\n**PLEASE PROVIDE A VALID ${targetName}.**`);
  }

  await ctx.reply(`🔎 **SEARCHING!** 🧐\n\n**INITIATING SCAN FOR ${targetName}:** \`${targetValue}\`...`, { parse_mode: 'Markdown' });

  try {
    const response = await axios.get(apiUrl, BROWSER_HEADERS);
    const resultData = response.data;
    // send inline, simple clean style
    return sendTextReport(ctx, `${targetName} RESULT`, { [targetName]: targetValue }, resultData);
  } catch (err) {
    console.error(`Error fetching ${targetName} info:`, err.message);
    const errorMsg = (err.response && err.response.data) ? JSON.stringify(err.response.data, null, 2) : err.message;
    return ctx.reply(`❌ **API ERROR!** 🤯\n\n**FAILED TO FETCH DATA. CHECK TARGET INPUT AND API STATUS.**\n**ERROR:** \`${errorMsg}\``, { parse_mode: 'Markdown' });
  }
}

// --- COMMANDS: /adr, /v, /pin ---
bot.command('adr', async (ctx) => {
  const parts = ctx.message.text.split(/\s+/).filter(Boolean);
  const aadhaar = parts[1];
  const apiUrl = `${API_CONFIG.ADHAR_API}?key=${API_CONFIG.ADHAR_KEY}&aadhaar=${aadhaar}`;
  return fetchAndSendReport(ctx, apiUrl, aadhaar, "AADHAR NUMBER");
});

bot.command('v', async (ctx) => {
  const parts = ctx.message.text.split(/\s+/).filter(Boolean);
  const veh = parts[1];
  const apiUrl = `${API_CONFIG.VECHIL_API}?number=${veh}`;
  return fetchAndSendReport(ctx, apiUrl, veh, "VEHICLE NUMBER");
});

bot.command('pin', async (ctx) => {
  const parts = ctx.message.text.split(/\s+/).filter(Boolean);
  const pin = parts[1];
  const apiUrl = `${API_CONFIG.PIN_API}?pincode=${pin}`;
  return fetchAndSendReport(ctx, apiUrl, pin, "PIN CODE");
});

// --- /familyinfo placeholder ---
bot.command('familyinfo', (ctx) => ctx.reply("⚠️ **COMMAND INCOMPLETE!** ⚠️\n\n**API for family lookup is currently not implemented.**"));

// --- UPDATED /num COMMAND (PRIMARY -> FALLBACK logic) ---
bot.command('num', async (ctx) => {
  const parts = ctx.message.text.split(/\s+/).filter(Boolean);
  const phone = parts[1];
  if (!phone) return ctx.reply("👉 **INPUT MISSING!** 🥺\n\n**PLEASE PROVIDE A VALID PHONE NUMBER.**");

  // Inform user quickly
  await ctx.reply(`🔎 **SEARCHING...**\n\n**Checking primary database for:** \`${phone}\``, { parse_mode: 'Markdown' });

  // STEP 1: Primary API
  const primaryUrl = `http://osint-info.great-site.net/api.php?phone=${encodeURIComponent(phone)}`;
  try {
    const primaryResp = await axios.get(primaryUrl, BROWSER_HEADERS);
    const data = primaryResp.data;

    // Consider non-empty body as valid result (string or object)
    const primaryHasData = (data !== null && data !== undefined && (!(typeof data === 'string') || data.trim() !== ''));

    if (primaryHasData) {
      return sendTextReport(ctx, "PRIMARY OSINT REPORT", { PHONE: phone }, data);
    }
    // else fallthrough to fallback APIs
  } catch (err) {
    console.log("Primary API error (will fallback):", err.message);
  }

  // STEP 2: Fallback APIs (run in parallel)
  await ctx.reply(`⚠️ **Primary database empty or error.**\n\n➡️ Checking secondary APIs...`, { parse_mode: 'Markdown' });

  try {
    const nameUrl = `${API_CONFIG.NUM_API_SUITE.NAME_FINDER}${encodeURIComponent(phone)}`;
    const aadhaarUrl = `${API_CONFIG.NUM_API_SUITE.AADHAAR_FINDER}${encodeURIComponent(phone)}`;

    const [nameRes, aadhaarRes] = await Promise.allSettled([
      axios.get(nameUrl, BROWSER_HEADERS),
      axios.get(aadhaarUrl, BROWSER_HEADERS)
    ]);

    const combined = {
      PHONE_NUMBER: phone,
      NAME_FINDER_INFO: nameRes.status === 'fulfilled' ? (nameRes.value.data) : { error: nameRes.reason ? nameRes.reason.message : 'failed' },
      AADHAAR_INFO: aadhaarRes.status === 'fulfilled' ? (aadhaarRes.value.data) : { error: aadhaarRes.reason ? aadhaarRes.reason.message : 'failed' }
    };

    return sendTextReport(ctx, "SECONDARY OSINT REPORT", { PHONE: phone }, combined);
  } catch (err) {
    console.error("Fallback APIs error:", err.message);
    return ctx.reply("❌ **ALL APIs FAILED!**\nPlease try again later.");
  }
});

// --- ADMIN PANEL (simple button-driven) ---
const adminCheck = (ctx, next) => {
  if (ctx.from.id !== ADMIN_USER_ID) return ctx.reply("❌ **ADMIN ACCESS DENIED.**");
  return next();
};

bot.command('admin', adminCheck, async (ctx) => {
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('➕ ADD CREDIT', 'admin_add_credit')],
    [Markup.button.callback('➖ REMOVE CREDIT', 'admin_remove_credit')],
    [Markup.button.callback('🛑 SUSPEND USER', 'admin_suspend')],
    [Markup.button.callback('🟢 UNBAN USER', 'admin_unban')],
    [Markup.button.callback('👤 CHECK STATUS', 'admin_status')]
  ]);
  return ctx.reply('👑 **ADMIN CONTROL PANEL** 👑\n\n**Select an action below:**', keyboard);
});

// Admin stateful text handling
bot.on('text', async (ctx, next) => {
  // Only handle if user is admin and has admin_state set
  const userId = ctx.from.id;
  const user = await getUserData(userId);
  if (!(user.role === 'admin' && user.admin_state)) return next();

  const state = user.admin_state; // e.g., 'add_credit', 'suspend'
  const inputParts = ctx.message.text.trim().split(/\s+/).filter(Boolean);
  // reset admin state
  await usersCollection.updateOne({ _id: userId }, { $set: { admin_state: null } });

  // Handle states
  if (state === 'add_credit' || state === 'remove_credit') {
    const targetId = parseInt(inputParts[0], 10);
    const amount = parseInt(inputParts[1], 10);
    if (!targetId || isNaN(amount)) return ctx.reply('❌ **INVALID FORMAT.** Please use: `UserID Amount`');
    const delta = state === 'add_credit' ? amount : -amount;
    await usersCollection.updateOne({ _id: targetId }, { $inc: { balance: delta } }, { upsert: true });
    const verb = state === 'add_credit' ? 'ADDED TO' : 'REMOVED FROM';
    return ctx.reply(`✅ **SUCCESS!** 💰\n\n**${Math.abs(amount)} TK ${verb} USER ${targetId}.**`);
  } else if (state === 'suspend' || state === 'unban') {
    const targetId = parseInt(inputParts[0], 10);
    if (!targetId) return ctx.reply('❌ **INVALID FORMAT.** Please use: `UserID`');
    const isSuspended = state === 'suspend';
    await usersCollection.updateOne({ _id: targetId }, { $set: { is_suspended: isSuspended } }, { upsert: true });
    const statusVerb = isSuspended ? 'SUSPENDED' : 'UNBANNED';
    return ctx.reply(`✅ **SUCCESS!** 🛑\n\n**USER ${targetId} HAS BEEN ${statusVerb}.**`);
  } else if (state === 'status') {
    const targetId = parseInt(inputParts[0], 10);
    if (!targetId) return ctx.reply('❌ **INVALID FORMAT.** Please use: `UserID`');
    const target = await usersCollection.findOne({ _id: targetId });
    return ctx.reply(`👤 **USER STATUS**\n\n${JSON.stringify(target || { _id: targetId, msg: 'No record' }, null, 2)}`);
  } else {
    return ctx.reply('⚠️ **UNKNOWN ADMIN STATE.**');
  }
});

// Admin action button handler
bot.action(/admin_(.+)/, adminCheck, async (ctx) => {
  await ctx.editMessageReplyMarkup({}); // tidy keyboard
  const action = ctx.match[1]; // e.g., add_credit
  const userId = ctx.from.id;
  await usersCollection.updateOne({ _id: userId }, { $set: { admin_state: action } });
  switch (action) {
    case 'add_credit':
      await ctx.reply('👉 **ADD CREDIT MODE**\n\n**FORMAT:** `UserID Amount`\n\nExample: `123456789 50`');
      break;
    case 'remove_credit':
      await ctx.reply('👉 **REMOVE CREDIT MODE**\n\n**FORMAT:** `UserID Amount`\n\nExample: `123456789 20`');
      break;
    case 'suspend':
      await ctx.reply('👉 **SUSPEND USER MODE**\n\n**FORMAT:** `UserID`\n\nExample: `123456789`');
      break;
    case 'unban':
      await ctx.reply('👉 **UNBAN USER MODE**\n\n**FORMAT:** `UserID`\n\nExample: `123456789`');
      break;
    case 'status':
      await ctx.reply('👉 **CHECK STATUS MODE**\n\n**FORMAT:** `UserID`\n\nExample: `123456789`');
      break;
    default:
      await ctx.reply('⚠️ **UNKNOWN ACTION.**');
  }
  await ctx.answerCbQuery();
});

// --- Vercel / Netlify / Serverless Webhook handler export ---
module.exports = async (req, res) => {
  try {
    await connectDB();
    if (req.method === 'POST') {
      // Expect Telegram update body
      await bot.handleUpdate(req.body);
      return res.status(200).send('OK');
    } else {
      // Info for GET
      return res.status(200).send('OSINT Bot is running via Webhook.');
    }
  } catch (err) {
    console.error('Webhook or DB Error:', err.message);
    return res.status(500).send(`Internal Server Error: ${err.message}`);
  }
};

// If you run locally with polling (development), uncomment below
// (Use env var BOT_POLLING=1 to enable local polling)
/*
if (process.env.BOT_POLLING === '1') {
  (async () => {
    await connectDB();
    bot.launch();
    console.log('Bot started with polling');
    process.on('SIGINT', () => bot.stop('SIGINT'));
    process.on('SIGTERM', () => bot.stop('SIGTERM'));
  })();
}
*/
