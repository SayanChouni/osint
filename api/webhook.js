// FILE: index.js
// Minimal inline comments; configuration & why-notes only where appropriate.

// --- Required libs ---
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const { MongoClient } = require('mongodb');

// --- PATCH: Browser User-Agent for bypassing "use a browser with Javascript support" pages ---
const BROWSER_HEADERS = {
  timeout: 15000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "application/json,text/plain,*/*",
  }
};

// --- CONFIG: Environment Variables (sane defaults where applicable) ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'osint_user_db';
const COLLECTION_NAME = process.env.COLLECTION_NAME || 'users';
const ADMIN_USER_ID = process.env.ADMIN_USER_ID ? parseInt(process.env.ADMIN_USER_ID, 10) : null;

const MANDATORY_CHANNEL_ID = process.env.MANDATORY_CHANNEL_ID || '-1002516081531';
const GROUP_JOIN_LINK = "https://t.me/+3TSyKHmwOvRmNDJl";

// API keys
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

const FREE_TRIAL_LIMIT = parseInt(process.env.FREE_TRIAL_LIMIT || "1", 10);
const COST_PER_SEARCH = parseInt(process.env.COST_PER_SEARCH || "2", 10);

let MAINTENANCE_MODE = (process.env.MAINTENANCE_MODE === '1');

// --- MongoDB client setup ---
if (!MONGODB_URI) {
  console.error("MONGODB_URI is required in env.");
  process.exit(1);
}

const mongoClient = new MongoClient(MONGODB_URI, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
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

// --- Utility ---
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

async function checkMembership(ctx) {
  try {
    const member = await ctx.telegram.getChatMember(
      MANDATORY_CHANNEL_ID,
      ctx.from.id
    );
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch (err) {
    console.error("Membership check error:", err.message);
    return false;
  }
}

async function sendTextReport(ctx, filename, content, caption) {
  const buffer = Buffer.from(
    typeof content === 'string'
      ? content
      : JSON.stringify(content, null, 2),
    'utf8'
  );

  try {
    await ctx.replyWithDocument(
      { source: buffer, filename },
      { caption, parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error("Error sending document:", err.message);
    await ctx.reply(`${caption}\n\n${content}`);
  }
}

// --- Middleware ---
bot.use(async (ctx, next) => {
  const text = ctx.message?.text?.trim() || '';
  const isCommand = /^\/(num|adr|v|pin|balance|donate|support|buyapi|admin|status)/.test(text);

  if (text.startsWith('/start')) return next();

  const chatType = ctx.chat?.type || 'private';
  if (isCommand && chatType !== 'private')
    return ctx.reply('⚠️ **PLEASE USE THIS BOT IN PRIVATE CHAT.** ⚠️', { parse_mode: 'Markdown' });

  if (MAINTENANCE_MODE && ctx.from.id !== ADMIN_USER_ID)
    return ctx.reply('🛠️ **MAINTENANCE MODE!**', { parse_mode: 'Markdown' });

  if (isCommand) {
    const userData = await getUserData(ctx.from.id);

    if (userData.role === 'admin' && userData.admin_state && !text.startsWith('/admin'))
      return next();

    if (userData.is_suspended)
      return ctx.reply('⚠️ **ACCOUNT SUSPENDED!**', { parse_mode: 'Markdown' });

    const isMember = await checkMembership(ctx);
    if (!isMember) {
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.url("🔒 JOIN MANDATORY GROUP", GROUP_JOIN_LINK)]
      ]);
      return ctx.reply('⛔️ **ACCESS REQUIRED!**', keyboard);
    }

    if (userData.role !== 'admin' && !/^\/(balance|donate|support|buyapi)/.test(text)) {
      const isFree = userData.search_count < FREE_TRIAL_LIMIT;
      const hasBalance = userData.balance >= COST_PER_SEARCH;

      if (!isFree && !hasBalance) {
        return ctx.reply(`
⚠️ **INSUFFICIENT BALANCE!**

**YOU USED YOUR FREE TRIAL.**
**RECHARGE MIN ₹25 — CONTACT @ZECBOY**
`, { parse_mode: 'Markdown' });
      }

      const updateOps = { $inc: { search_count: 1 } };
      if (!isFree) updateOps.$inc.balance = -COST_PER_SEARCH;

      await usersCollection.updateOne({ _id: ctx.from.id }, updateOps);
      const updated = await usersCollection.findOne({ _id: ctx.from.id });
      const freeLeft = Math.max(0, FREE_TRIAL_LIMIT - updated.search_count);

      await ctx.reply(
        `💳 **TRANSACTION SUCCESSFUL!** Cost: ${isFree ? 0 : COST_PER_SEARCH} • Balance: ${updated.balance} • Free left: ${freeLeft}`,
        { parse_mode: 'Markdown' }
      );
    }
  }
  return next();
});

// --- /start ---
bot.start(async (ctx) => {
  const isMember = await checkMembership(ctx);
  if (isMember) {
    const welcome = `
**┏━━✨ INFORA PRO ✨━━┓**

1 FREE SEARCH • Then ${COST_PER_SEARCH} TK/search

Commands:
/num <phone>
/adr <aadhaar>
/v <vehicle>
/pin <pincode>

Powered by @zecboy
`;
    return ctx.reply(welcome, { parse_mode: 'Markdown' });
  }

  return ctx.reply(
    "JOIN GROUP FIRST:",
    Markup.inlineKeyboard([[Markup.button.url("🔒 JOIN", GROUP_JOIN_LINK)]])
  );
});

// --- /balance ---
bot.command('balance', async (ctx) => {
  const user = await getUserData(ctx.from.id);
  return ctx.reply(
    `Balance: ${user.balance} • Free left: ${Math.max(0, FREE_TRIAL_LIMIT - user.search_count)}`,
    { parse_mode: 'Markdown' }
  );
});

// Support commands
bot.command(['donate', 'support', 'buyapi'], (ctx) =>
  ctx.reply("Contact: @zecboy", { parse_mode: 'Markdown' })
);

// --- Helper for /adr /v /pin ---
async function fetchAndSendReport(ctx, apiUrl, targetValue, targetName) {
  if (!targetValue)
    return ctx.reply(`ENTER VALID ${targetName}`);

  await ctx.reply(`Searching ${targetName}: ${targetValue}`);

  try {
    const response = await axios.get(apiUrl, BROWSER_HEADERS);
    const txt = `--- REPORT ---\n${JSON.stringify(response.data, null, 2)}`;
    return sendTextReport(ctx, `report_${targetValue}.txt`, txt, "Result:");
  } catch (err) {
    return ctx.reply("API ERROR: " + err.message);
  }
}

// --- Commands ---
bot.command('adr', (ctx) => {
  const aadhaar = ctx.message.text.split(/\s+/)[1];
  const url = `${API_CONFIG.ADHAR_API}?key=${API_CONFIG.ADHAR_KEY}&aadhaar=${aadhaar}`;
  return fetchAndSendReport(ctx, url, aadhaar, "AADHAAR");
});

bot.command('v', (ctx) => {
  const veh = ctx.message.text.split(/\s+/)[1];
  const url = `${API_CONFIG.VECHIL_API}?number=${veh}`;
  return fetchAndSendReport(ctx, url, veh, "VEHICLE");
});

bot.command('pin', (ctx) => {
  const pin = ctx.message.text.split(/\s+/)[1];
  const url = `${API_CONFIG.PIN_API}?pincode=${pin}`;
  return fetchAndSendReport(ctx, url, pin, "PIN");
});

// --- /num (Primary + Fallback) ---
bot.command('num', async (ctx) => {
  const phone = ctx.message.text.split(/\s+/)[1];
  if (!phone) return ctx.reply("Enter phone number");

  await ctx.reply(`Checking primary: ${phone}`);

  const primaryUrl = `http://osint-info.great-site.net/api.php?phone=${phone}`;

  try {
    const primaryResp = await axios.get(primaryUrl, BROWSER_HEADERS);
    if (primaryResp.data && JSON.stringify(primaryResp.data).trim() !== "") {
      const txt = `--- PRIMARY DATA ---\n${JSON.stringify(primaryResp.data, null, 2)}`;
      return sendTextReport(ctx, `primary_${phone}.txt`, txt, "Primary OK");
    }
  } catch (e) {
    console.log("Primary failed:", e.message);
  }

  await ctx.reply("Primary empty. Checking secondary…");

  try {
    const [nameRes, aadhaarRes] = await Promise.allSettled([
      axios.get(`${API_CONFIG.NUM_API_SUITE.NAME_FINDER}${phone}`, BROWSER_HEADERS),
      axios.get(`${API_CONFIG.NUM_API_SUITE.AADHAAR_FINDER}${phone}`, BROWSER_HEADERS)
    ]);

    const combined = {
      PHONE: phone,
      NAME: nameRes.status === "fulfilled" ? nameRes.value.data : nameRes.reason?.message,
      AADHAAR: aadhaarRes.status === "fulfilled" ? aadhaarRes.value.data : aadhaarRes.reason?.message
    };

    const txt = JSON.stringify(combined, null, 2);
    return sendTextReport(ctx, `combined_${phone}.txt`, txt, "Secondary OK");
  } catch (e) {
    return ctx.reply("ALL FAILED");
  }
});

// --- Admin Panel (unchanged) ---
const adminCheck = (ctx, next) => {
  if (ctx.from.id !== ADMIN_USER_ID) return ctx.reply("❌ Admin only");
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
  return ctx.reply("ADMIN PANEL", keyboard);
});

// Admin text handler + actions (unchanged)
bot.on('text', async (ctx, next) => {
  const user = await getUserData(ctx.from.id);
  if (!(user.role === 'admin' && user.admin_state)) return next();

  const state = user.admin_state;
  const parts = ctx.message.text.trim().split(/\s+/);
  await usersCollection.updateOne({ _id: ctx.from.id }, { $set: { admin_state: null } });

  if (state === 'add_credit' || state === 'remove_credit') {
    const uid = parseInt(parts[0]);
    const amount = parseInt(parts[1]);
    if (!uid || !amount) return ctx.reply("Format: UserID Amount");

    await usersCollection.updateOne(
      { _id: uid },
      { $inc: { balance: state === 'add_credit' ? amount : -amount } },
      { upsert: true }
    );
    return ctx.reply("Updated.");
  }

  if (state === 'suspend' || state === 'unban') {
    const uid = parseInt(parts[0]);
    await usersCollection.updateOne(
      { _id: uid },
      { $set: { is_suspended: state === 'suspend' } },
      { upsert: true }
    );
    return ctx.reply("Done.");
  }

  if (state === 'status') {
    const uid = parseInt(parts[0]);
    const target = await usersCollection.findOne({ _id: uid });
    return ctx.reply(JSON.stringify(target, null, 2));
  }
});

bot.action(/admin_(.+)/, adminCheck, async (ctx) => {
  await ctx.editMessageReplyMarkup({});
  const action = ctx.match[1];

  await usersCollection.updateOne(
    { _id: ctx.from.id },
    { $set: { admin_state: action } }
  );

  const msg = {
    add_credit: "Format: UserID Amount",
    remove_credit: "Format: UserID Amount",
    suspend: "Format: UserID",
    unban: "Format: UserID",
    status: "Format: UserID"
  }[action] || "Unknown";

  await ctx.reply(msg);
  await ctx.answerCbQuery();
});

// --- Webhook handler ---
module.exports = async (req, res) => {
  try {
    await connectDB();
    if (req.method === 'POST') {
      await bot.handleUpdate(req.body);
      return res.status(200).send('OK');
    }
    return res.status(200).send('Bot running');
  } catch (err) {
    return res.status(500).send(err.message);
  }
};
