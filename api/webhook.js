// FILE: index.js
// Clean, production-friendly single-file bot for "INFORA-PRO"
// Minimal comments: only the 'why' where necessary.

const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const { MongoClient } = require('mongodb');

// ----------------- CONFIG -----------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'osint_user_db';
const USERS_COL = process.env.COLLECTION_NAME || 'users';
const LOGS_COL = process.env.LOGS_COLLECTION || 'search_logs';
const BLOCKED_COL = process.env.BLOCKED_COLLECTION || 'blocked_numbers';
const ADMIN_USER_ID = process.env.ADMIN_USER_ID ? parseInt(process.env.ADMIN_USER_ID, 10) : null;

const MANDATORY_CHANNEL_ID = process.env.MANDATORY_CHANNEL_ID || '-1002516081531';
const GROUP_JOIN_LINK = process.env.GROUP_JOIN_LINK || 'https://t.me/+3TSyKHmwOvRmNDJl';

const FREE_TRIAL_LIMIT = parseInt(process.env.FREE_TRIAL_LIMIT || '1', 10);
const COST_PER_SEARCH = parseInt(process.env.COST_PER_SEARCH || '2', 10);

// Anti-spam cooldown in milliseconds
const SEARCH_COOLDOWN_MS = parseInt(process.env.SEARCH_COOLDOWN_MS || '2000', 10);

// API endpoints (ONLY two used: apisuite namefinder & aadhaar)
const API_CONFIG = {
  NAME_FINDER: process.env.APISUITE_NAMEFINDER || 'https://m.apisuite.in/?api=namefinder&api_key=2907591571c0d74b89dc1244a1bb1715&number=',
  AADHAAR_FINDER: process.env.APISUITE_AADHAAR || 'https://m.apisuite.in/?api=number-to-aadhaar&api_key=2907591571c0d74b89dc1244a1bb1715&number='
};

let MAINTENANCE_MODE = (process.env.MAINTENANCE_MODE === '1');

// ----------------- MONGO SETUP -----------------
if (!MONGODB_URI) {
  console.error('MONGODB_URI required in env');
  process.exit(1);
}
const mongoClient = new MongoClient(MONGODB_URI, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  maxPoolSize: 1
});
let db, usersCollection, logsCollection, blockedCollection;
async function connectDB() {
  if (usersCollection && logsCollection && blockedCollection) return;
  await mongoClient.connect();
  db = mongoClient.db(DB_NAME);
  usersCollection = db.collection(USERS_COL);
  logsCollection = db.collection(LOGS_COL);
  blockedCollection = db.collection(BLOCKED_COL);

  // Indexes for performance
  await usersCollection.createIndex({ _id: 1 }, { unique: true });
  await logsCollection.createIndex({ ts: -1 });
  await blockedCollection.createIndex({ number: 1 }, { unique: true });
}

// ----------------- BOT SETUP -----------------
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN required in env');
  process.exit(1);
}
const bot = new Telegraf(BOT_TOKEN);

// ----------------- UTILITIES -----------------
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
      admin_state: null,
      last_search_ts: 0
    };
    await usersCollection.insertOne(newUser);
    return newUser;
  }
  return user;
}

async function checkMembership(ctx) {
  try {
    const member = await ctx.telegram.getChatMember(MANDATORY_CHANNEL_ID, ctx.from.id);
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch (err) {
    console.error('Membership check error:', err.message);
    return false;
  }
}

async function isBlockedNumber(number) {
  await connectDB();
  const doc = await blockedCollection.findOne({ number });
  return !!doc;
}

async function addBlockedNumber(number, byUserId = null) {
  await connectDB();
  try {
    await blockedCollection.updateOne({ number }, { $set: { number, added_by: byUserId, ts: new Date() } }, { upsert: true });
    return true;
  } catch (err) {
    console.error('addBlockedNumber error:', err.message);
    return false;
  }
}

async function removeBlockedNumber(number) {
  await connectDB();
  const r = await blockedCollection.deleteOne({ number });
  return r.deletedCount > 0;
}

async function logSearch(entry) {
  await connectDB();
  await logsCollection.insertOne(Object.assign({ ts: new Date() }, entry));
}

// Always send documents with disable_web_page_preview to avoid mobile "browser" issue
async function sendTextReport(ctx, filename, content, caption) {
  const buffer = Buffer.from(typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
  try {
    await ctx.replyWithDocument(
      { source: buffer, filename },
      { caption, disable_web_page_preview: true, parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('Error sending document:', err.message);
    await ctx.reply(`${caption}\n\n${typeof content === 'string' ? content : 'Report attached but failed to send file.'}`);
  }
}

// ----------------- MIDDLEWARE -----------------
bot.use(async (ctx, next) => {
  const text = ctx.message && ctx.message.text ? ctx.message.text.trim() : '';
  const isCommand = text && /^\/(num|balance|donate|support|buyapi|admin|status)\b/.test(text);

  if (text.startsWith('/start')) return next();

  const chatType = ctx.chat && ctx.chat.type ? ctx.chat.type : 'private';
  if (isCommand && chatType !== 'private') {
    return ctx.reply('⚠️ **PLEASE USE THIS BOT IN PRIVATE CHAT.** ⚠️', { parse_mode: 'Markdown' });
  }

  if (MAINTENANCE_MODE && ctx.from.id !== ADMIN_USER_ID) {
    return ctx.reply('🛠️ **MAINTENANCE MODE!**\n\n**The bot is under maintenance.**', { parse_mode: 'Markdown' });
  }

  if (isCommand) {
    const user = await getUserData(ctx.from.id);

    // allow admin to type when in admin_state
    if (user.role === 'admin' && user.admin_state && !text.startsWith('/admin')) {
      return next();
    }

    if (user.is_suspended) {
      return ctx.reply('⚠️ **ACCOUNT SUSPENDED!** 🚫\n\n**CONTACT ADMIN.**', { parse_mode: 'Markdown' });
    }

    // membership check
    const member = await checkMembership(ctx);
    if (!member) {
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.url('🔒 JOIN MANDATORY GROUP', GROUP_JOIN_LINK)]
      ]);
      return ctx.reply('⛔️ **ACCESS REQUIRED!** ⛔️\n\n**YOU MUST JOIN THE GROUP TO USE THE BOT.**', keyboard);
    }

    // credits/trial - skip for admin and info-only commands
    if (user.role !== 'admin' && !/^\/(balance|donate|support|buyapi)\b/.test(text)) {
      const isFree = user.search_count < FREE_TRIAL_LIMIT;
      const hasBalance = user.balance >= COST_PER_SEARCH;
      if (!isFree && !hasBalance) {
        const msg = `
⚠️ **INSUFFICIENT BALANCE!**

**YOU HAVE USED YOUR ${FREE_TRIAL_LIMIT} FREE SEARCH.**
**RECHARGE MINIMUM ₹25 TO CONTINUE.**
CONTACT: @zecboy`;
        return ctx.reply(msg, { parse_mode: 'Markdown' });
      }

      // increment search_count and deduct if not free
      const updateOps = { $inc: { search_count: 1 } };
      if (!isFree) updateOps.$inc = Object.assign(updateOps.$inc || {}, { balance: -COST_PER_SEARCH });
      await usersCollection.updateOne({ _id: ctx.from.id }, updateOps);
      const updated = await usersCollection.findOne({ _id: ctx.from.id });
      const freeLeft = Math.max(0, FREE_TRIAL_LIMIT - updated.search_count);
      await ctx.reply(`💳 Transaction processed. COST: ${isFree ? '0' : COST_PER_SEARCH} TK. BALANCE: ${updated.balance} TK. FREE LEFT: ${freeLeft}.`, { parse_mode: 'Markdown' });
    }
  }

  return next();
});

// ----------------- START MESSAGE -----------------
bot.start(async (ctx) => {
  const member = await checkMembership(ctx);
  const startText = `┏━━✨ INFORA PRO ✨━━┓

👋 Hey! I’m your OSINT/Search copilot—fast, precise & private.
📊 ONE TIME FREE TRIAL
• PER searches cost ${COST_PER_SEARCH} credit 💳
• Works in BOT only for privacy 👥🔐

— — — — — — — — — — — — — — — — — — —
🔎 Basic Lookups
• /num <phone> — 10-digit mobile details
• IF YOU WANT TO SEARCH , VECHIL INFO , AREA PIN CODE INFO ,
  TELEGRAM USERNAME TO NUMBER INFO SO DM : @zecboy

— — — — — — — — — — — — — — — — — — —
⚡️ Powered by: @zecboy
🌐 Stay Safe • Respect Privacy • Use Responsibly 🚀
`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔎 Try /num', 'try_num')],
    [Markup.button.url('💳 Buy Credits', 'https://t.me/zecboy'), Markup.button.url('📩 Contact Owner', 'https://t.me/zecboy')]
  ]);

  if (member) {
    return ctx.reply(startText, { parse_mode: 'Markdown', ...{} });
  } else {
    const joinKeyboard = Markup.inlineKeyboard([
      [Markup.button.url('🔒 JOIN MANDATORY GROUP', GROUP_JOIN_LINK)],
      [Markup.button.callback('🔎 Try /num', 'try_num')]
    ]);
    return ctx.reply('👋 WELCOME TO OSINT BOT! You MUST JOIN THE GROUP to use commands:', joinKeyboard);
  }
});

// inline handler for Try button
bot.action('try_num', (ctx) => {
  ctx.answerCbQuery();
  ctx.reply('To search a number use: /num <phone>');
});

// ----------------- SIMPLE HELP / BALANCE -----------------
bot.command('balance', async (ctx) => {
  const user = await getUserData(ctx.from.id);
  const freeLeft = Math.max(0, FREE_TRIAL_LIMIT - user.search_count);
  return ctx.reply(`💰 BALANCE: ${user.balance} TK\nFREE USES LEFT: ${freeLeft}`, { parse_mode: 'Markdown' });
});

bot.command(['donate', 'support', 'buyapi'], (ctx) => {
  return ctx.reply('✨ SUPPORT: DM @zecboy', { parse_mode: 'Markdown' });
});

// ----------------- /num COMMAND (ONLY COMMAND) -----------------
bot.command('num', async (ctx) => {
  const parts = ctx.message.text.split(/\s+/).filter(Boolean);
  const phone = parts[1];
  if (!phone) return ctx.reply("👉 INPUT MISSING! Use: /num <phone>");

  await connectDB();
  const user = await getUserData(ctx.from.id);

  // Cooldown check
  const now = Date.now();
  const last = user.last_search_ts || 0;
  if (now - last < SEARCH_COOLDOWN_MS && ctx.from.id !== ADMIN_USER_ID) {
    return ctx.reply(`⏱️ Please wait ${Math.ceil((SEARCH_COOLDOWN_MS - (now - last))/1000)}s before next search.`);
  }

  // Blocked number check
  if (await isBlockedNumber(phone)) {
    await logSearch({ user_id: ctx.from.id, phone, blocked: true, method: 'blocked_check', ip: null });
    return ctx.reply('🚫 This number is blocked from searches.');
  }

  // Update last_search_ts
  await usersCollection.updateOne({ _id: ctx.from.id }, { $set: { last_search_ts: now } });

  await ctx.reply(`🔎 Searching for: \`${phone}\``, { parse_mode: 'Markdown' });

  // Call the two apis in parallel (apisuite namefinder + aadhaar)
  try {
    const nameUrl = `${API_CONFIG.NAME_FINDER}${encodeURIComponent(phone)}`;
    const aadhaarUrl = `${API_CONFIG.AADHAAR_FINDER}${encodeURIComponent(phone)}`;

    const [nameRes, aadhaarRes] = await Promise.allSettled([
      axios.get(nameUrl, { timeout: 15000 }),
      axios.get(aadhaarUrl, { timeout: 15000 })
    ]);

    const result = {
      PHONE_NUMBER: phone,
      NAME_FINDER: nameRes.status === 'fulfilled' ? nameRes.value.data : { error: nameRes.reason ? nameRes.reason.message : 'failed' },
      AADHAAR_INFO: aadhaarRes.status === 'fulfilled' ? aadhaarRes.value.data : { error: aadhaarRes.reason ? aadhaarRes.reason.message : 'failed' }
    };

    const filename = `num_report_${phone}.txt`;
    const txt = `--- INFORA PRO REPORT ---\nPhone: ${phone}\n\n${JSON.stringify(result, null, 2)}`;

    // send and log
    await sendTextReport(ctx, filename, txt, '✅ Report generated for phone number.');
    await logSearch({
      user_id: ctx.from.id,
      phone,
      result_summary: {
        name_status: nameRes.status,
        aadhaar_status: aadhaarRes.status
      },
      cost: (user.search_count <= FREE_TRIAL_LIMIT ? 0 : COST_PER_SEARCH),
      blocked: false
    });

  } catch (err) {
    console.error('num command error:', err.message);
    return ctx.reply('❌ API error. Please try again later.');
  }
});

// ----------------- ADMIN PANEL -----------------
const adminOnly = (ctx, next) => {
  if (ctx.from.id !== ADMIN_USER_ID) return ctx.reply('❌ ADMIN ACCESS DENIED.');
  return next();
};

bot.command('admin', adminOnly, async (ctx) => {
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('➕ ADD CREDIT', 'admin_add_credit'), Markup.button.callback('➖ REMOVE CREDIT', 'admin_remove_credit')],
    [Markup.button.callback('🛑 SUSPEND USER', 'admin_suspend'), Markup.button.callback('🟢 UNBAN USER', 'admin_unban')],
    [Markup.button.callback('👤 CHECK STATUS', 'admin_status'), Markup.button.callback('📝 VIEW LOGS', 'admin_view_logs')],
    [Markup.button.callback('🔒 ADD BLOCK', 'admin_add_block'), Markup.button.callback('🔓 REMOVE BLOCK', 'admin_remove_block')]
  ]);
  return ctx.reply('Admin Panel:', kb);
});

// Set admin_state and instruct
bot.action(/admin_(.+)/, adminOnly, async (ctx) => {
  const action = ctx.match[1]; // e.g., add_credit
  await connectDB();
  await usersCollection.updateOne({ _id: ctx.from.id }, { $set: { admin_state: action } }, { upsert: true });
  switch (action) {
    case 'add_credit':
      await ctx.reply('ADD CREDIT MODE\nFormat: UserID Amount\nExample: 123456789 50');
      break;
    case 'remove_credit':
      await ctx.reply('REMOVE CREDIT MODE\nFormat: UserID Amount\nExample: 123456789 20');
      break;
    case 'suspend':
      await ctx.reply('SUSPEND MODE\nFormat: UserID\nExample: 123456789');
      break;
    case 'unban':
      await ctx.reply('UNBAN MODE\nFormat: UserID\nExample: 123456789');
      break;
    case 'status':
      await ctx.reply('STATUS MODE\nFormat: UserID\nExample: 123456789');
      break;
    case 'view_logs':
      await ctx.reply('VIEW LOGS MODE\nFormat: number (how many recent logs) Example: 10');
      break;
    case 'add_block':
      await ctx.reply('ADD BLOCK MODE\nFormat: phone Example: 6295533968');
      break;
    case 'remove_block':
      await ctx.reply('REMOVE BLOCK MODE\nFormat: phone Example: 6295533968');
      break;
    default:
      await ctx.reply('Unknown admin action.');
  }
  await ctx.answerCbQuery();
});

// Admin stateful text handler (process first, then clear)
bot.on('text', async (ctx, next) => {
  const userId = ctx.from.id;
  const user = await getUserData(userId);
  if (!(user.role === 'admin' && user.admin_state && !ctx.message.text.startsWith('/admin'))) {
    return next();
  }

  const state = user.admin_state;
  const txt = ctx.message.text.trim();
  const parts = txt.split(/\s+/).filter(Boolean);

  try {
    if (state === 'add_credit' || state === 'remove_credit') {
      if (parts.length !== 2) return ctx.reply('INVALID FORMAT. Use: UserID Amount');
      const targetId = parseInt(parts[0], 10);
      const amount = parseInt(parts[1], 10);
      if (!targetId || isNaN(amount)) return ctx.reply('INVALID FORMAT. Use: UserID Amount');
      const delta = state === 'add_credit' ? amount : -amount;
      await usersCollection.updateOne({ _id: targetId }, { $inc: { balance: delta } }, { upsert: true });
      await ctx.reply(`SUCCESS: ${Math.abs(amount)} TK ${state === 'add_credit' ? 'ADDED TO' : 'REMOVED FROM'} USER ${targetId}`);
    } else if (state === 'suspend' || state === 'unban') {
      if (parts.length !== 1) return ctx.reply('INVALID FORMAT. Use: UserID');
      const targetId = parseInt(parts[0], 10);
      if (!targetId) return ctx.reply('INVALID FORMAT. Use: UserID');
      await usersCollection.updateOne({ _id: targetId }, { $set: { is_suspended: state === 'suspend' } }, { upsert: true });
      await ctx.reply(`SUCCESS: USER ${targetId} ${state === 'suspend' ? 'SUSPENDED' : 'UNBANNED'}`);
    } else if (state === 'status') {
      if (parts.length !== 1) return ctx.reply('INVALID FORMAT. Use: UserID');
      const targetId = parseInt(parts[0], 10);
      const t = await usersCollection.findOne({ _id: targetId });
      return ctx.reply(`USER STATUS:\n${JSON.stringify(t || { _id: targetId, msg: 'No record' }, null, 2)}`);
    } else if (state === 'view_logs') {
      const n = parts.length === 1 ? Math.min(100, parseInt(parts[0], 10) || 10) : 10;
      const logs = await logsCollection.find().sort({ ts: -1 }).limit(n).toArray();
      return sendTextReport(ctx, `logs_last_${n}.txt`, logs, `Last ${n} logs`);
    } else if (state === 'add_block') {
      if (parts.length !== 1) return ctx.reply('INVALID FORMAT. Use: phone');
      const phone = parts[0];
      const ok = await addBlockedNumber(phone, ctx.from.id);
      return ctx.reply(ok ? `Blocked ${phone}` : `Failed to block ${phone}`);
    } else if (state === 'remove_block') {
      if (parts.length !== 1) return ctx.reply('INVALID FORMAT. Use: phone');
      const phone = parts[0];
      const ok = await removeBlockedNumber(phone);
      return ctx.reply(ok ? `Unblocked ${phone}` : `Failed to unblock ${phone}`);
    } else {
      await ctx.reply('UNKNOWN ADMIN STATE.');
    }
  } catch (err) {
    console.error('admin text handler error:', err.message);
    await ctx.reply('ERROR processing admin request.');
  } finally {
    // Clear admin state after processing (success or error)
    await usersCollection.updateOne({ _id: userId }, { $set: { admin_state: null } });
  }
});

// ----------------- WEBHOOK EXPORT -----------------
module.exports = async (req, res) => {
  try {
    await connectDB();
    if (req.method === 'POST') {
      await bot.handleUpdate(req.body);
      return res.status(200).send('OK');
    } else {
      return res.status(200).send('INFORA-PRO Bot is running (webhook).');
    }
  } catch (err) {
    console.error('Webhook handler error:', err.message);
    return res.status(500).send(`Internal Server Error: ${err.message}`);
  }
};

// Optional polling for local dev: enable with BOT_POLLING=1
if (process.env.BOT_POLLING === '1') {
  (async () => {
    try {
      await connectDB();
      await bot.launch();
      console.log('Bot started (polling)');
      process.on('SIGINT', () => bot.stop('SIGINT'));
      process.on('SIGTERM', () => bot.stop('SIGTERM'));
    } catch (err) {
      console.error('Polling launch error:', err.message);
    }
  })();
}
