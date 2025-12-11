// FILE: index.js
// INFORA-PRO — final single-file bot (MarkdownV2 boxed results for /num)

const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const { MongoClient } = require('mongodb');

// ---------------- CONFIG ----------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'osint_user_db';
const USERS_COL = process.env.COLLECTION_NAME || 'users';
const LOGS_COL = process.env.LOGS_COLLECTION || 'search_logs';
const BLOCKED_COL = process.env.BLOCKED_COLLECTION || 'blocked_numbers';
const ADMIN_USER_ID = process.env.ADMIN_USER_ID ? parseInt(process.env.ADMIN_USER_ID, 10) : null;

const MANDATORY_CHANNEL_ID = process.env.MANDATORY_CHANNEL_ID || '-1002516081531';
const BOT_USERNAME = process.env.BOT_USERNAME || 'infotrac_bot'; 
const GROUP_JOIN_LINK = process.env.GROUP_JOIN_LINK || 'https://t.me/+3TSyKHmwOvRmNDJl';

const FREE_TRIAL_LIMIT = parseInt(process.env.FREE_TRIAL_LIMIT || '1', 10);
const COST_PER_SEARCH = parseInt(process.env.COST_PER_SEARCH || '2', 10);
const SEARCH_COOLDOWN_MS = parseInt(process.env.SEARCH_COOLDOWN_MS || '2000', 10);

const API_CONFIG = {
  NAME_FINDER: process.env.APISUITE_NAMEFINDER || 'https://m.apisuite.in/?api=namefinder&api_key=a5cd2d1b9800cccb42c216a20ed1eb33&number=',
  AADHAAR_FINDER: process.env.APISUITE_AADHAAR || 'https://m.apisuite.in/?api=number-to-aadhaar&api_key=a5cd2d1b9800cccb42c216a20ed1eb33&number='
};
const VPLINK_BASE_URL = 'https://vplink.in';
// The user is redirected to the bot's standard link after VPLINK task
const CALLBACK_SIMPLE_LINK = `https://t.me/${BOT_USERNAME}`;
// VPLINK API URL using the simple callback link
const VPLINK_API_URL = `https://vplink.in/api?api=9c06662a8be6f2fc0aff86f302586f967fe917bb&url=${encodeURIComponent(CALLBACK_SIMPLE_LINK)}&alias=inforatrack&format=text`;

let MAINTENANCE_MODE = (process.env.MAINTENANCE_MODE === '1');

// ---------------- MONGO SETUP ----------------
if (!MONGODB_URI) {
  console.error('MONGODB_URI required');
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

  await usersCollection.createIndex({ _id: 1 });
  await logsCollection.createIndex({ ts: -1 });
  await blockedCollection.createIndex({ number: 1 }, { unique: true });
}

// ---------------- BOT SETUP ----------------
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN required');
  process.exit(1);
}
const bot = new Telegraf(BOT_TOKEN);

// ---------------- HELPERS ----------------
function escapeMdV2(text) {
  if (text === null || text === undefined) return '';
  const s = String(text);
  return s.replace(/\\/g, '\\\\')
    .replace(/_/g, '\\_')
    .replace(/\*/g, '\\*')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/~/g, '\\~')
    .replace(/`/g, '\\`')
    .replace(/>/g, '\\>')
    .replace(/#/g, '\\#')
    .replace(/\+/g, '\\+')
    .replace(/-/g, '\\-')
    .replace(/=/g, '\\=')
    .replace(/\|/g, '\\|')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\./g, '\\.')
    .replace(/!/g, '\\!');
}

function parseAddress(addressRaw) {
  if (!addressRaw || typeof addressRaw !== 'string') return { state: '', pincode: '', addressPretty: escapeMdV2(String(addressRaw || '')) };
  const parts = addressRaw.split('!').filter(Boolean).map(p => p.trim()).filter(Boolean);
  const pincodeCandidate = parts.length ? parts[parts.length - 1] : '';
  const stateCandidate = parts.length >= 2 ? parts[parts.length - 2] : '';
  const addressPretty = parts.join(', ');
  return { state: stateCandidate || '', pincode: pincodeCandidate || '', addressPretty: escapeMdV2(addressPretty) };
}

// DB helpers
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
      last_search_ts: 0,
      free_access_claimed: false,
      free_access_started: false // NEW: Track if user initiated the free access flow
    };
    await usersCollection.insertOne(newUser);
    return newUser;
  }
  // Ensure old users have the flags
  if (user.free_access_claimed === undefined) {
    user.free_access_claimed = false;
    await usersCollection.updateOne({ _id: userId }, { $set: { free_access_claimed: false } });
  }
  if (user.free_access_started === undefined) {
    user.free_access_started = false;
    await usersCollection.updateOne({ _id: userId }, { $set: { free_access_started: false } });
  }
  return user;
}

async function checkMembership(ctx) {
  try {
    const mem = await ctx.telegram.getChatMember(MANDATORY_CHANNEL_ID, ctx.from.id);
    return ['member', 'administrator', 'creator'].includes(mem.status);
  } catch (err) {
    console.error('membership check failed:', err.message);
    return false;
  }
}

async function isBlockedNumber(number) {
  await connectDB();
  const doc = await blockedCollection.findOne({ number });
  return !!doc;
}

async function logSearch(entry) {
  await connectDB();
  await logsCollection.insertOne(Object.assign({ ts: new Date() }, entry));
}

async function sendAdminFile(ctx, filename, obj, caption) {
  const buffer = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2), 'utf8');
  try {
    await ctx.replyWithDocument({ source: buffer, filename }, { caption, disable_web_page_preview: true });
  } catch (err) {
    console.error('sendAdminFile error:', err.message);
    await ctx.reply(`${caption}\n\n${typeof obj === 'string' ? obj : 'Failed to send file.'}`);
  }
}

// ---------------- MIDDLEWARE ----------------
bot.use(async (ctx, next) => {
  const text = ctx.message && ctx.message.text ? ctx.message.text.trim() : '';
  const isCmd = text && /^\/(num|balance|donate|support|buyapi|admin|status)\b/.test(text); 
  
  // Allow /start and inline button presses to pass
  if (text.startsWith('/start') || ctx.callbackQuery) return next(); 

  const chatType = ctx.chat && ctx.chat.type ? ctx.chat.type : 'private';
  if (isCmd && chatType !== 'private') {
    return ctx.reply('⚠️ *PLEASE USE THIS BOT IN PRIVATE CHAT\\.* ⚠️', { parse_mode: 'MarkdownV2' });
  }

  if (MAINTENANCE_MODE && ctx.from.id !== ADMIN_USER_ID) {
    return ctx.reply('🛠️ *MAINTENANCE MODE* — Bot temporarily unavailable\\.', { parse_mode: 'MarkdownV2' });
  }

  if (isCmd) {
    const user = await getUserData(ctx.from.id);

    if (user.role === 'admin' && user.admin_state && !text.startsWith('/admin')) {
      return next();
    }

    if (user.is_suspended) {
      return ctx.reply('⚠️ *ACCOUNT SUSPENDED\\!* 🚫', { parse_mode: 'MarkdownV2' });
    }

    // membership
    const member = await checkMembership(ctx);
    if (!member) {
      const keyboard = Markup.inlineKeyboard([[Markup.button.url('🔒 JOIN MANDATORY GROUP', GROUP_JOIN_LINK)]]);
      return ctx.reply('⛔️ *ACCESS REQUIRED\\!* You must join the group\\.', keyboard);
    }

    // credits/trial
    if (user.role !== 'admin' && !/^\/(balance|donate|support|buyapi)\b/.test(text)) { 
      const isFree = user.search_count < FREE_TRIAL_LIMIT;
      const hasBalance = user.balance >= COST_PER_SEARCH;
      if (!isFree && !hasBalance) {
        // --- CUSTOM MODIFICATION: INSUFFICIENT BALANCE BUTTONS ---
        let claimPrompt;
        if (user.free_access_claimed) {
          claimPrompt = 'Recharge to continue\\.';
        } else if (user.free_access_started) {
          claimPrompt = `*Task initiated\\.* Run \`/start\` to find the *Claim Button*\\!`;
        } else {
          claimPrompt = '*Click the Free Access button below to start the process\\.*';
        }

        const msg = `⚠️ *INSUFFICIENT BALANCE\\!*\n\n*You used your ${FREE_TRIAL_LIMIT} free search\\.*\n${claimPrompt}`;
        
        const buttons = [
          [Markup.button.url('💳 ADD PAYMENT', 'https://t.me/zecboy')],
        ];

        if (!user.free_access_claimed) {
          buttons.push([Markup.button.callback('🎁 GET FREE ACCESS (5 Searches)', 'get_free_access')]);
        }

        const keyboard = Markup.inlineKeyboard(buttons);
        return ctx.reply(msg, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup });
        // -----------------------------------------------------------
      }

      // increment and deduct atomically
      const updateOps = { $inc: { search_count: 1 } };
      if (!isFree) updateOps.$inc = Object.assign(updateOps.$inc || {}, { balance: -COST_PER_SEARCH });
      await usersCollection.updateOne({ _id: ctx.from.id }, updateOps);
      const updated = await usersCollection.findOne({ _id: ctx.from.id });
      const freeLeft = Math.max(0, FREE_TRIAL_LIMIT - updated.search_count);
      await ctx.reply(`💳 *Transaction processed\\.* COST: ${isFree ? '0' : COST_PER_SEARCH} TK\\. BALANCE: ${escapeMdV2(String(updated.balance))} TK\\. FREE LEFT: ${freeLeft}\\.`, { parse_mode: 'MarkdownV2' });
    }
  }

  return next();
});

// ---------------- START ----------------
bot.start(async (ctx) => {
  const payload = ctx.startPayload; // Check if there's a start parameter (like /start activate_free_5)
  await connectDB();
  const user = await getUserData(ctx.from.id);
  
  // --- Handle Deep Link Activation (if VPLINK works with deep links) ---
  // This block is simplified to handle only the claim button flow below.
  // If payload handling is needed for other features, it should be here.
  
  // --- Existing /start logic ---
  const member = await checkMembership(ctx);
  const startMd = [
    '████████████████████',
    '*✨ INFORA PRO ✨*',
    '████████████████████',
    '',
    '👤 *Private OSINT Lookup*',
    '🎁 *Free Trial Enabled*',
    '',
    '🔎 *Lookup Available:*',
    '📱 `/num <phone>`',
    '',
    '📌 *More Services:*',
    '🚗 Vehicle • 🏠 PIN Code • 👤 Username',
    '➡️ DM: @zecboy',
    '',
    '⚡ *Powered by INFORA PRO*'
  ].join('\n');

  let buttons = [
    [Markup.button.callback('🔎 Try /num', 'try_num')],
    [Markup.button.url('💳 Buy Credits', 'https://t.me/zecboy'), Markup.button.url('📩 Contact Owner', 'https://t.me/zecboy')]
  ];

  // NEW: If user initiated the flow but hasn't claimed, show the CLAIM button
  if (user.free_access_started && !user.free_access_claimed) {
    buttons.unshift([Markup.button.callback('✅ CLICK TO GET 5 SEARCHES', 'claim_free_5')]);
  }

  const keyboard = Markup.inlineKeyboard(buttons);

  if (member) {
    return ctx.reply(startMd, { parse_mode: 'MarkdownV2', disable_web_page_preview: true, reply_markup: keyboard.reply_markup });
  } else {
    const joinKb = Markup.inlineKeyboard([[Markup.button.url('🔒 JOIN MANDATORY GROUP', GROUP_JOIN_LINK)], [Markup.button.callback('🔎 Try /num', 'try_num')] ]);
    return ctx.reply('👋 *WELCOME TO OSINT BOT\\!* You MUST JOIN THE GROUP to use commands\\.', joinKb);
  }
});

bot.action('try_num', (ctx) => {
  ctx.answerCbQuery();
  ctx.reply('To search a number use: /num <phone>');
});

// ---------------- CLAIM BUTTON HANDLER (New Secure Action) ----------------
bot.action('claim_free_5', async (ctx) => {
  await ctx.answerCbQuery('Checking claim status...');
  await connectDB();
  const userId = ctx.from.id;
  const user = await getUserData(userId);

  if (!user.free_access_started) {
    return ctx.reply('⚠️ *ERROR\\!* You must click the "GET FREE ACCESS" button first to start the process\\.', { parse_mode: 'MarkdownV2' });
  }
  if (user.free_access_claimed) {
    return ctx.reply('⚠️ *CREDIT ALREADY CLAIMED\\!* 🚫\n\nYou have already claimed your 5 free searches\\. Recharge to continue\\.', { parse_mode: 'MarkdownV2' });
  }
  
  // Grant 5 credits and set both flags
  const amountToGrant = 5; 
  await usersCollection.updateOne(
    { _id: userId }, 
    { 
      $inc: { balance: amountToGrant }, 
      $set: { free_access_claimed: true, free_access_started: false } // Reset started flag
    }, 
    { upsert: true }
  );

  const updatedUser = await usersCollection.findOne({ _id: userId });
  
  // Edit the message to remove the claim button
  try {
    await ctx.editMessageText(`🎉 *YOUR 5 SEARCHES ACTIVATED\\!* ✅\n\n*${amountToGrant} credits added to your balance\\.*\n*CURRENT BALANCE:* ${escapeMdV2(String(updatedUser.balance))} TK\\.`, { parse_mode: 'MarkdownV2' });
  } catch (e) {
    // In case the message cannot be edited (too old)
    await ctx.reply(`🎉 *YOUR 5 SEARCHES ACTIVATED\\!* ✅\n\n*${amountToGrant} credits added to your balance\\.*\n*CURRENT BALANCE:* ${escapeMdV2(String(updatedUser.balance))} TK\\.`, { parse_mode: 'MarkdownV2' });
  }
});


// ---------------- FREE ACCESS HANDLER (Initiates the VPLINK flow) ----------------
bot.action('get_free_access', async (ctx) => {
  await ctx.answerCbQuery('Fetching free access link...');
  
  const user = await getUserData(ctx.from.id);
  if (user.free_access_claimed) {
    return ctx.reply('⚠️ *FREE ACCESS ALREADY CLAIMED\\!* Recharge to continue\\.', { parse_mode: 'MarkdownV2' });
  }

  try {
    // 1. Set the 'started' flag before redirecting
    await usersCollection.updateOne({ _id: ctx.from.id }, { $set: { free_access_started: true } });
    
    // 2. Call VPLINK API
    const response = await axios.get(VPLINK_API_URL, { timeout: 10000 });
    const redirectLink = response.data.trim();

    if (!redirectLink || !redirectLink.startsWith(VPLINK_BASE_URL)) {
      // If VPLINK fails, reset the 'started' flag so the user can try again.
      await usersCollection.updateOne({ _id: ctx.from.id }, { $set: { free_access_started: false } });
      throw new Error(redirectLink ? `Invalid link structure received: ${redirectLink}` : 'VPLINK API returned an empty response.');
    }

    // 3. Send the user the link + instruction to run /start
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.url('🔗 COMPLETE VPLINK TASK', redirectLink)]
    ]);

    await ctx.reply('*⚠️ TASK STARTED\\!* Please complete the task via the link below\\. *After completion, run* \`/start\` *to get your claim button\\!*', {
      parse_mode: 'MarkdownV2',
      reply_markup: keyboard.reply_markup,
      disable_web_page_preview: true
    });

  } catch (err) {
    console.error('Free access API fetch error:', err.message);
    
    const rawErrorMessage = err.message || 'Unknown network error.';
    const displayMessage = rawErrorMessage.includes('400') ? 'VPLINK API rejected the request (Check VPLINK API key/config).' : rawErrorMessage;

    await ctx.reply(`❌ API Error: Failed to generate free access link\\.\nError: ${escapeMdV2(displayMessage)}\\.`, { parse_mode: 'MarkdownV2' });
  }
});

// ---------------- HELP / BALANCE ----------------
bot.command('balance', async (ctx) => {
  const user = await getUserData(ctx.from.id);
  const freeLeft = Math.max(0, FREE_TRIAL_LIMIT - user.search_count);
  return ctx.reply(`💰 *BALANCE:* ${escapeMdV2(String(user.balance))} TK\n*FREE USES LEFT:* ${freeLeft}`, { parse_mode: 'MarkdownV2' });
});

bot.command(['donate','support','buyapi'], (ctx) => ctx.reply('✨ SUPPORT: DM @zecboy', { parse_mode: 'MarkdownV2' }));

// ---------------- FORMAT & SEND STYLED RESULT (Option A) ----------------
async function sendPremiumNumberResult(ctx, apiResultObj, phone, userId) {
  // apiResultObj follows your sample: { status: 'success', data: [ { ... } ] }
  const rec = (apiResultObj && Array.isArray(apiResultObj.data) && apiResultObj.data[0]) ? apiResultObj.data[0] : {};
  const name = escapeMdV2(rec.name || rec.NAME || rec.full_name || 'N/A');
  const father = escapeMdV2(rec.father_name || rec.father || 'N/A');
  const mobile = escapeMdV2(rec.mobile || phone || 'N/A');
  const aadhaar = escapeMdV2(rec.adhaar_number || rec.aadhaar_number || rec.adhaar || 'N/A');
  const circle = escapeMdV2(rec.circle || 'N/A');
  const addressRaw = rec.address || rec.ADDRESS || '';
  const { state, pincode, addressPretty } = parseAddress(addressRaw);

  const ts = new Date().toLocaleString('en-GB', { hour12: true });

  const mdLines = [
    '████████████████████',
    `*📱 NUMBER INFORMATION*`,
    '████████████████████',
    '',
    `*👤 Name:* ${name}`,
    `*👨‍👦 Father Name:* ${father}`,
    `*📞 Mobile:* ${mobile}`,
    `*🆔 Aadhaar:* ${aadhaar}`,
    `*🌐 Circle:* ${circle}`,
    '',
    `*🏡 Address:*`,
    // Fix: Ensure addressRaw is escaped if addressPretty is empty (addresses the "Character '!' issue)
    `${addressPretty || escapeMdV2(String(addressRaw || 'N/A'))}`,
    '',
    `*📮 Pincode:* ${escapeMdV2(String(pincode || 'N/A'))}`,
    `*📍 State:* ${escapeMdV2(String(state || 'N/A'))}`,
    '',
    `*🕒 Queried On:* ${escapeMdV2(ts)}`,
    `*👤 Searched By:* ${escapeMdV2(String(userId))}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    '*⚠️ Use this information responsibly\\.*'
  ];

  const out = mdLines.join('\n');
  try {
    await ctx.reply(out, { parse_mode: 'MarkdownV2', disable_web_page_preview: true });
  } catch (err) {
    console.error('sendPremiumNumberResult error:', err.message);
    await ctx.reply('Result ready but failed to format; sending raw JSON.');
    await sendAdminFile(ctx, `raw_${phone}.txt`, apiResultObj, 'Raw API response');
  }
}

// ---------------- /num COMMAND (only command) ----------------
bot.command('num', async (ctx) => {
  const parts = ctx.message.text.split(/\s+/).filter(Boolean);
  const phone = parts[1];
  if (!phone) return ctx.reply('👉 INPUT MISSING\\! Use: /num <phone>');

  await connectDB();
  const user = await getUserData(ctx.from.id);

  // cooldown
  const now = Date.now();
  const last = user.last_search_ts || 0;
  if (now - last < SEARCH_COOLDOWN_MS && ctx.from.id !== ADMIN_USER_ID) {
    return ctx.reply(`⏱️ Please wait ${Math.ceil((SEARCH_COOLDOWN_MS - (now - last))/1000)}s before next search\\.`, { parse_mode: 'MarkdownV2' });
  }

  // block check
  if (await isBlockedNumber(phone)) {
    await logSearch({ user_id: ctx.from.id, phone, blocked: true, method: 'blocked_check' });
    return ctx.reply('🚫 This number is blocked from searches\\.', { parse_mode: 'MarkdownV2' });
  }

  // update last_search_ts
  await usersCollection.updateOne({ _id: ctx.from.id }, { $set: { last_search_ts: now } });

  await ctx.reply(`🔎 Searching for: *${escapeMdV2(phone)}*`, { parse_mode: 'MarkdownV2' });

  // ------------------ MODIFIED LOGIC: ONLY CALL AADHAAR API ------------------
  try {
    const aadhaarUrl = `${API_CONFIG.AADHAAR_FINDER}${encodeURIComponent(phone)}`;

    // Only call the AADHAAR API
    const aadhaarRes = await axios.get(aadhaarUrl, { timeout: 15000 });

    let combined = { status: 'success', data: [] };
    
    if (aadhaarRes.data && Array.isArray(aadhaarRes.data.data)) {
        combined = aadhaarRes.data;
    } else if (aadhaarRes.data) {
        combined = aadhaarRes.data;
    } else {
        combined = { status: 'failed', data: [ { error: 'No data from API' } ] };
    }

    // send premium formatted message
    await sendPremiumNumberResult(ctx, combined, phone, ctx.from.id);

    // log search
    await logSearch({
      user_id: ctx.from.id,
      phone,
      result_summary: {
        aadhaar_status: 'fulfilled' 
      },
      cost: (user.search_count <= FREE_TRIAL_LIMIT ? 0 : COST_PER_SEARCH),
      blocked: false
    });

  } catch (err) {
    console.error('num command error:', err.message);
    // Log API failure
    await logSearch({
      user_id: ctx.from.id,
      phone,
      result_summary: {
        aadhaar_status: 'failed',
        error: err.message
      },
      cost: (user.search_count <= FREE_TRIAL_LIMIT ? 0 : COST_PER_SEARCH),
      blocked: false
    });
    return ctx.reply('❌ API error\\. Please try again later\\.', { parse_mode: 'MarkdownV2' });
  }
});

// ---------------- ADMIN PANEL ----------------
const adminOnly = (ctx, next) => {
  if (ctx.from.id !== ADMIN_USER_ID) return ctx.reply('❌ ADMIN ACCESS DENIED\\.', { parse_mode: 'MarkdownV2' });
  return next();
};

bot.command('admin', adminOnly, async (ctx) => {
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('➕ ADD CREDIT', 'admin_add_credit'), Markup.button.callback('➖ REMOVE CREDIT', 'admin_remove_credit')],
    [Markup.button.callback('🛑 SUSPEND USER', 'admin_suspend'), Markup.button.callback('🟢 UNBAN USER', 'admin_unban')],
    [Markup.button.callback('👤 CHECK STATUS', 'admin_status'), Markup.button.callback('📝 VIEW LOGS', 'admin_view_logs')],
    [Markup.button.callback('🔒 ADD BLOCK', 'admin_add_block'), Markup.button.callback('🔓 REMOVE BLOCK', 'admin_remove_block')]
  ]);
  return ctx.reply('*Admin Panel*', { parse_mode: 'MarkdownV2', reply_markup: kb.reply_markup });
});


bot.action(/admin_(.+)/, adminOnly, async (ctx) => {
  const action = ctx.match[1];
  await connectDB();
  await usersCollection.updateOne({ _id: ctx.from.id }, { $set: { admin_state: action } }, { upsert: true });
  switch (action) {
    case 'add_credit': await ctx.reply('ADD CREDIT MODE\nFormat: UserID Amount\nExample: 123456789 50'); break;
    case 'remove_credit': await ctx.reply('REMOVE CREDIT MODE\nFormat: UserID Amount\nExample: 123456789 20'); break;
    case 'suspend': await ctx.reply('SUSPEND MODE\nFormat: UserID\nExample: 123456789'); break;
    case 'unban': await ctx.reply('UNBAN MODE\nFormat: UserID\nExample: 123456789'); break;
    case 'status': await ctx.reply('STATUS MODE\nFormat: UserID\nExample: 123456789'); break;
    case 'view_logs': await ctx.reply('VIEW LOGS MODE\nFormat: number (how many recent logs) Example: 10'); break;
    case 'add_block': await ctx.reply('ADD BLOCK MODE\nFormat: phone Example: 7047997398'); break;
    case 'remove_block': await ctx.reply('REMOVE BLOCK MODE\nFormat: phone Example: 7047997398'); break;
    default: await ctx.reply('Unknown admin action'); break;
  }
  await ctx.answerCbQuery();
});

// Admin text handler — process first, clear state after processing
bot.on('text', async (ctx, next) => {
  const userId = ctx.from.id;
  const user = await getUserData(userId);
  if (!(user.role === 'admin' && user.admin_state && !ctx.message.text.startsWith('/admin'))) return next();

  const state = user.admin_state;
  const txt = ctx.message.text.trim();
  const parts = txt.split(/\s+/).filter(Boolean);

  try {
    if (state === 'add_credit' || state === 'remove_credit') {
      if (parts.length !== 2) return ctx.reply('INVALID FORMAT\\. Use: UserID Amount', { parse_mode: 'MarkdownV2' });
      const targetId = parseInt(parts[0], 10);
      const amount = parseInt(parts[1], 10);
      if (!targetId || isNaN(amount)) return ctx.reply('INVALID FORMAT\\. Use: UserID Amount', { parse_mode: 'MarkdownV2' });
      const delta = state === 'add_credit' ? amount : -amount;
      await usersCollection.updateOne({ _id: targetId }, { $inc: { balance: delta } }, { upsert: true });
      await ctx.reply(`SUCCESS: ${Math.abs(amount)} TK ${state === 'add_credit' ? 'ADDED TO' : 'REMOVED FROM'} USER ${targetId}`, { parse_mode: 'MarkdownV2' });
    } else if (state === 'suspend' || state === 'unban') {
      if (parts.length !== 1) return ctx.reply('INVALID FORMAT\\. Use: UserID', { parse_mode: 'MarkdownV2' });
      const targetId = parseInt(parts[0], 10);
      if (!targetId) return ctx.reply('INVALID FORMAT\\. Use: UserID', { parse_mode: 'MarkdownV2' });
      await usersCollection.updateOne({ _id: targetId }, { $set: { is_suspended: state === 'suspend' } }, { upsert: true });
      await ctx.reply(`SUCCESS: USER ${targetId} ${state === 'suspend' ? 'SUSPENDED' : 'UNBANNED'}`, { parse_mode: 'MarkdownV2' });
    } else if (state === 'status') {
      if (parts.length !== 1) return ctx.reply('INVALID FORMAT\\. Use: UserID', { parse_mode: 'MarkdownV2' });
      const targetId = parseInt(parts[0], 10);
      const t = await usersCollection.findOne({ _id: targetId });
      // Using MarkdownV2 code block for status
      return ctx.reply(`USER STATUS:\n\`\`\`json\n${JSON.stringify(t || { _id: targetId, msg: 'No record' }, null, 2)}\n\`\`\``, { parse_mode: 'MarkdownV2' });
    } else if (state === 'view_logs') {
      const n = parts.length === 1 ? Math.min(100, parseInt(parts[0], 10) || 10) : 10;
      const logs = await logsCollection.find().sort({ ts: -1 }).limit(n).toArray();
      return sendAdminFile(ctx, `logs_last_${n}.txt`, logs, `Last ${n} logs`);
    } else if (state === 'add_block') {
      if (parts.length !== 1) return ctx.reply('INVALID FORMAT\\. Use: phone', { parse_mode: 'MarkdownV2' });
      const phone = parts[0];
      const ok = await addBlockedNumber(phone, ctx.from.id);
      return ctx.reply(ok ? `Blocked ${escapeMdV2(phone)}` : `Failed to block ${escapeMdV2(phone)}`, { parse_mode: 'MarkdownV2' });
    } else if (state === 'remove_block') {
      if (parts.length !== 1) return ctx.reply('INVALID FORMAT\\. Use: phone', { parse_mode: 'MarkdownV2' });
      const phone = parts[0];
      const ok = await removeBlockedNumber(phone);
      return ctx.reply(ok ? `Unblocked ${escapeMdV2(phone)}` : `Failed to unblock ${escapeMdV2(phone)}`, { parse_mode: 'MarkdownV2' });
    } else {
      await ctx.reply('UNKNOWN ADMIN STATE', { parse_mode: 'MarkdownV2' });
    }
  } catch (err) {
    console.error('admin handler error:', err.message);
    await ctx.reply('ERROR processing admin request', { parse_mode: 'MarkdownV2' });
  } finally {
    // clear admin_state after attempt
    await usersCollection.updateOne({ _id: userId }, { $set: { admin_state: null } });
  }
});

// ---------------- WEBHOOK EXPORT ----------------
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
    // Ensure the message sent in the response is a simple string for safety
    return res.status(500).send(`Internal Server Error: ${err.message}`);
  }
};

// Optional polling for dev: set BOT_POLLING=1
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
