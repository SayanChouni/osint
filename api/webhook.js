// FILE: index.js
// INFORA-PRO — final single-file bot (MarkdownV2 boxed results for /num)

const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const { MongoClient } = require('mongodb');
const { URLSearchParams } = require('url');

// ---------------- CONFIG ----------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'osint_user_db';
const USERS_COL = process.env.COLLECTION_NAME || 'users';
const LOGS_COL = process.env.LOGS_COLLECTION || 'search_logs';
const BLOCKED_COL = process.env.BLOCKED_COLLECTION || 'blocked_numbers';
const ADMIN_USER_ID = process.env.ADMIN_USER_ID
  ? parseInt(process.env.ADMIN_USER_ID, 10)
  : null;

const MANDATORY_CHANNEL_ID =
  process.env.MANDATORY_CHANNEL_ID || '-1002516081531';
const GROUP_JOIN_LINK =
  process.env.GROUP_JOIN_LINK || 'https://t.me/+3TSyKHmwOvRmNDJl';

const FREE_TRIAL_LIMIT = parseInt(process.env.FREE_TRIAL_LIMIT || '2', 10);
const BONUS_TRIAL_LIMIT = 5;
const COST_PER_SEARCH = parseInt(process.env.COST_PER_SEARCH || '2', 10);
const SEARCH_COOLDOWN_MS = parseInt(
  process.env.SEARCH_COOLDOWN_MS || '2000',
  10
);

// FREE ACCESS API
const FREE_ACCESS_API_TOKEN = '9c06662a8be6f2fc0aff86f302586f917bb';
const FREE_ACCESS_API_BASE_URL = 'https://vplink.in/api';
const PAYMENT_CONTACT = '@zecboy';

const API_CONFIG = {
  AADHAAR_FINDER:
    process.env.APISUITE_AADHAAR ||
    'https://nixonsmmapi.s77134867.workers.dev/?mobile=',
};

let MAINTENANCE_MODE = process.env.MAINTENANCE_MODE === '1';

// ---------------- MONGO SETUP ----------------
if (!MONGODB_URI) {
  console.error('MONGODB_URI missing');
  process.exit(1);
}

const mongoClient = new MongoClient(MONGODB_URI, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  maxPoolSize: 1,
});

let db, usersCollection, logsCollection, blockedCollection;

async function connectDB() {
  if (usersCollection) return;

  await mongoClient.connect();
  db = mongoClient.db(DB_NAME);

  usersCollection = db.collection(USERS_COL);
  logsCollection = db.collection(LOGS_COL);
  blockedCollection = db.collection(BLOCKED_COL);

  await usersCollection.createIndex({ _id: 1 });

  await blockedCollection.createIndex({ number: 1 }, { unique: true });
}

// ---------------- BOT ----------------
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN missing');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// MarkdownV2 escape
function escapeMdV2(text) {
  if (!text) return '';
  return String(text)
    .replace(/\\/g, '\\\\')
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

// Address parser
function parseAddress(raw) {
  if (!raw) return { state: '', pincode: '', addressPretty: '' };

  const parts = raw
    .split('!')
    .filter(Boolean)
    .map((p) => p.trim());

  const pincode = parts[parts.length - 1] || '';
  const state = parts[parts.length - 2] || '';

  return {
    state,
    pincode,
    addressPretty: escapeMdV2(parts.join(', ')),
  };
}

// DB — Get User
async function getUserData(uid) {
  await connectDB();

  let u = await usersCollection.findOne({ _id: uid });

  if (!u) {
    u = {
      _id: uid,
      balance: 0,
      search_count: 0,
      bonus_search_count: 0,
      is_suspended: false,
      role: uid === ADMIN_USER_ID ? 'admin' : 'user',
      last_search_ts: 0,
      admin_state: null,
    };
    await usersCollection.insertOne(u);
  }

  if (u.bonus_search_count === undefined) {
    await usersCollection.updateOne(
      { _id: uid },
      { $set: { bonus_search_count: 0 } }
    );
    u.bonus_search_count = 0;
  }

  return u;
}

async function checkMembership(ctx) {
  try {
    const m = await ctx.telegram.getChatMember(
      MANDATORY_CHANNEL_ID,
      ctx.from.id
    );
    return ['member', 'creator', 'administrator'].includes(m.status);
  } catch (e) {
    return false;
  }
}

async function isBlockedNumber(num) {
  await connectDB();
  return !!(await blockedCollection.findOne({ number: num }));
}

async function logSearch(obj) {
  await connectDB();
  await logsCollection.insertOne({ ...obj, ts: new Date() });
}


// Admin-only file send (keeps doc sending for admin use)
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

  if (text.startsWith('/start')) return next();

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
      const isFreeTrial = user.search_count < FREE_TRIAL_LIMIT;
      const isFreeBonus = user.bonus_search_count > 0;
      const hasBalance = user.balance >= COST_PER_SEARCH;

      if (!isFreeTrial && !isFreeBonus && !hasBalance) {
        
        const msg = `⚠️ *INSUFFICIENT BALANCE OR FREE USES ENDED\\!*\n\n*You used your ${FREE_TRIAL_LIMIT} free searches and ${BONUS_TRIAL_LIMIT} bonus searches\\.*\nRecharge to continue or get temporary free access.`;
        
        const rechargeKb = Markup.inlineKeyboard([
           [Markup.button.url('💳 ADD PAYMENT', `https://t.me/${PAYMENT_CONTACT.substring(1)}`)],
           // Use callback button to trigger API call
           [Markup.button.callback('🆓 GET FREE ACCESS (5 Searches)', 'free_access_link')] 
        ]);
        
        return ctx.reply(msg, rechargeKb);
      }

      // Determine cost deduction and counter update
      const updateOps = { $inc: {} };
      let cost = 0;
      let usedFreeType = '';

      if (isFreeBonus) {
        // Use bonus search first
        updateOps.$inc.bonus_search_count = -1;
        usedFreeType = 'Bonus';
      } else if (isFreeTrial) {
        // Use initial free trial
        updateOps.$inc.search_count = 1;
        cost = 0;
        usedFreeType = 'Trial';
      } else {
        // Use paid balance
        updateOps.$inc.search_count = 1;
        updateOps.$inc.balance = -COST_PER_SEARCH;
        cost = COST_PER_SEARCH;
        usedFreeType = 'Paid';
      }
      
      await usersCollection.updateOne({ _id: ctx.from.id }, updateOps);
      const updated = await usersCollection.findOne({ _id: ctx.from.id });
      
      const freeLeft = Math.max(0, FREE_TRIAL_LIMIT - updated.search_count);
      const bonusLeft = Math.max(0, updated.bonus_search_count);

      await ctx.reply(`💳 *Transaction processed\\.* TYPE: ${usedFreeType}\\. COST: ${cost} TK\\. BALANCE: ${escapeMdV2(String(updated.balance))} TK\\. FREE LEFT: ${freeLeft}\\. BONUS LEFT: ${bonusLeft}\\.`, { parse_mode: 'MarkdownV2' });
    }
  }

  return next();
});

// ---------------- START ----------------
bot.start(async (ctx) => {
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

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔎 Try /num', 'try_num')],
    [Markup.button.url('💳 Buy Credits', `https://t.me/${PAYMENT_CONTACT.substring(1)}`), Markup.button.url('📩 Contact Owner', `https://t.me/${PAYMENT_CONTACT.substring(1)}`)]
  ]);
  
  // Handle /start?payload (payload is everything after /start )
  const fullCommand = ctx.message.text.trim();
  const startPayload = fullCommand.split(/\s+/).slice(1).join(' ').trim(); // Get all text after /start
  const isTokenActivated = startPayload.startsWith('token_'); // Checking for the fixed pattern
  
  // Logic: Check if the payload is present and starts with token_
  if (isTokenActivated) {
    // Grant 5 bonus searches 
    const targetUserId = ctx.from.id; // Activation is always for the user sending the command
    await usersCollection.updateOne({ _id: targetUserId }, { $set: { bonus_search_count: BONUS_TRIAL_LIMIT } }, { upsert: true });
    
    // Send success message and initial start message
    await ctx.reply('✅ *TOKEN ACTIVATED\\!* You have received 5 bonus searches\\.', { parse_mode: 'MarkdownV2' });
    await ctx.reply(startMd, { parse_mode: 'MarkdownV2', disable_web_page_preview: true, ...{} });
    return;
  }

  // Normal start response
  if (member) {
    return ctx.reply(startMd, { parse_mode: 'MarkdownV2', disable_web_page_preview: true, ...{} });
  } else {
    const joinKb = Markup.inlineKeyboard([[Markup.button.url('🔒 JOIN MANDATORY GROUP', GROUP_JOIN_LINK)], [Markup.button.callback('🔎 Try /num', 'try_num')] ]);
    return ctx.reply('👋 *WELCOME TO OSINT BOT\\!* You MUST JOIN THE GROUP to use commands\\.', joinKb);
  }
});

bot.action('try_num', (ctx) => {
  ctx.answerCbQuery();
  ctx.reply('To search a number use: /num <phone>');
});

// --- NEW ACTION HANDLER FOR FREE ACCESS (Dynamic API call) ---
bot.action('free_access_link', async (ctx) => {
    await ctx.answerCbQuery('Generating free access link...');
    try {
        // Construct the redirect URL back to the bot with a token/start parameter
        // Using the safe URL format: start=token_USERID
        const longUrl = `https://t.me/infotrac_bot?start=token_${ctx.from.id}`;
        
        // Build the query parameters for the link shortening API
        const params = new URLSearchParams({
            api: FREE_ACCESS_API_TOKEN,
            url: longUrl,
            alias: 'inforaalise' // Keeping manual alias
        });

        // Make the GET request
        const url = `${FREE_ACCESS_API_BASE_URL}?${params.toString()}`;
        // Timeout increased to 20 seconds
        const res = await axios.get(url, { timeout: 20000 }); 
        
        // Check for the expected JSON response structure
        if (res.data && res.data.status === 'success' && res.data.shortenedUrl) {
            const shortUrl = res.data.shortenedUrl;
            
            const message = `🔗 *CLICK BELOW TO ACTIVATE 5 FREE SEARCHES\\!* (This will redirect you back to the bot)\n\n*Link:* ${escapeMdV2(shortUrl)}`;
            
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.url('➡️ GET FREE ACCESS', shortUrl)]
            ]);

            await ctx.reply(message, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup, disable_web_page_preview: true });
        } else if (res.data && res.data.status === 'error') {
             // FIX: Escaping error message from API response before replying
             // Use escapeMdV2 on the API message and also escape the rest of the sentence
             const apiMsg = res.data.message || 'API error message is missing.';
             const escaped = escapeMdV2(`❌ Link API Error: ${apiMsg}. Try again or use Add Payment.`);
             await ctx.reply(escaped, { parse_mode: 'MarkdownV2' });
        } else {
             // Generic failure, using escaped Markdown
             await ctx.reply('❌ Failed to generate free access link \\(Unknown response\\)\\. Please try again or use *Add Payment*\\.', { parse_mode: 'MarkdownV2' });
        }
    } catch (err) {
       // Log the actual error
       console.error('Free access API error:', err.message);
       
       // FIX START: Ensure MarkdownV2 error messages are properly escaped and reply keyboard is provided.
       const rechargeKb = Markup.inlineKeyboard([
           [Markup.button.url('💳 ADD PAYMENT', `https://t.me/${PAYMENT_CONTACT.substring(1)}`)]
       ]);

       let userMsg;
       if (err.code === 'ECONNABORTED' || err.message.includes('timeout')) {
           // Message is now escaped
           userMsg = escapeMdV2('❌ Timeout. The link generator is slow. Please try again in 30 seconds or use Add Payment.');
       } else {
           // Message is now escaped
           userMsg = escapeMdV2('❌ API Error during link generation. Please try again or use Add Payment.');
       }
       
       // Use MarkdownV2 explicitly for the escaped message and include the fallback keyboard.
       await ctx.reply(userMsg, { parse_mode: 'MarkdownV2', reply_markup: rechargeKb.reply_markup });
       // FIX END
    }
});

// ---------------- HELP / BALANCE ----------------
bot.command('balance', async (ctx) => {
  const user = await getUserData(ctx.from.id);
  const freeLeft = Math.max(0, FREE_TRIAL_LIMIT - user.search_count);
  const bonusLeft = Math.max(0, user.bonus_search_count);

  return ctx.reply(`💰 *BALANCE:* ${escapeMdV2(String(user.balance))} TK\n*FREE USES LEFT (Trial):* ${freeLeft}\n*FREE USES LEFT (Bonus):* ${bonusLeft}`, { parse_mode: 'MarkdownV2' });
});

bot.command(['donate','support','buyapi'], (ctx) => ctx.reply(`✨ SUPPORT: DM ${PAYMENT_CONTACT}`, { parse_mode: 'MarkdownV2' }));

// ---------------- FORMAT & SEND STYLED RESULT (Option A) ----------------
async function sendPremiumNumberResult(ctx, apiResultObj, phone, userId) {
  // apiResultObj follows your sample: { status: 'success', data: [ { ... } ] }
  const rec = (apiResultObj && Array.isArray(apiResultObj.data) && apiResultObj.data[0]) ? apiResultObj.data[0] : {};
  
  // The new API response might use different keys, but we rely on your sample structure for mapping
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
    // Fix: Ensure addressRaw is escaped if addressPretty is empty
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
    // API CONFIG key changed to 'mobile=' format, but we keep the structure here.
    const aadhaarUrl = `${API_CONFIG.AADHAAR_FINDER}${encodeURIComponent(phone)}`;

    // Only call the AADHAAR API
    const res = await axios.get(aadhaarUrl, { timeout: 15000 });
    
    // We assume the response data is the object containing 'status' and 'data' array
    const responseData = res.data;
    
    let combined = { status: 'failed', data: [ { error: 'No data from API' } ] };
    
    // Check for success status and valid data array
    if (responseData && responseData.status === 'success' && Array.isArray(responseData.data)) {
        combined = responseData;
    } else {
        // If the API returns data but not in the expected format, log it.
        console.error('API returned non-standard/failed response:', JSON.stringify(responseData));
        combined = responseData || { status: 'failed', data: [ { error: 'API returned non-standard data.' } ] };
    }

    // send premium formatted message
    await sendPremiumNumberResult(ctx, combined, phone, ctx.from.id);

    // log search
    const userUpdated = await usersCollection.findOne({ _id: ctx.from.id });
    const isFree = (userUpdated.search_count <= FREE_TRIAL_LIMIT && userUpdated.search_count > 0 && userUpdated.balance <= 0) || userUpdated.bonus_search_count < BONUS_TRIAL_LIMIT;

    await logSearch({
      user_id: ctx.from.id,
      phone,
      result_summary: {
        aadhaar_status: combined.status
      },
      cost: isFree ? 0 : COST_PER_SEARCH,
      blocked: false
    });

  } catch (err) {
    console.error('num command error:', err.message);
    
    // Log API failure
    const userUpdated = await usersCollection.findOne({ _id: ctx.from.id });
    const isFree = (userUpdated.search_count <= FREE_TRIAL_LIMIT && userUpdated.search_count > 0 && userUpdated.balance <= 0) || userUpdated.bonus_search_count < BONUS_TRIAL_LIMIT;
    
    // Reverse the counter/balance deduction since the search failed due to API error
    const reverseOps = { $inc: {} };
    if (userUpdated.bonus_search_count < BONUS_TRIAL_LIMIT && userUpdated.bonus_search_count >= 0) {
      reverseOps.$inc.bonus_search_count = 1; // Increment bonus back
    } else if (userUpdated.search_count > 0 && userUpdated.search_count <= FREE_TRIAL_LIMIT) {
      reverseOps.$inc.search_count = -1; // Decrement trial back
    } else if (userUpdated.balance < 0) {
      reverseOps.$inc.balance = COST_PER_SEARCH; // Add money back
    }
    
    if (Object.keys(reverseOps.$inc).length > 0) {
        await usersCollection.updateOne({ _id: ctx.from.id }, reverseOps);
    }
    
    await logSearch({
      user_id: ctx.from.id,
      phone,
      result_summary: {
        aadhaar_status: 'failed',
        error: err.message
      },
      cost: isFree ? 0 : COST_PER_SEARCH,
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
    [Markup.button.callback('🔒 ADD BLOCK', 'admin_add_block'), Markup.button.callback('🔓 REMOVE BLOCK', 'admin_remove_block')],
    [Markup.button.callback('➕ ADD BONUS SEARCHES', 'admin_add_bonus_search')] // New admin command
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
    case 'add_bonus_search': await ctx.reply('ADD BONUS SEARCH MODE\nFormat: UserID Amount\nExample: 123456789 5'); break; // New admin action
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
    } else if (state === 'add_bonus_search') {
      if (parts.length !== 2) return ctx.reply('INVALID FORMAT\\. Use: UserID Amount', { parse_mode: 'MarkdownV2' });
      const targetId = parseInt(parts[0], 10);
      const amount = parseInt(parts[1], 10);
      if (!targetId || isNaN(amount)) return ctx.reply('INVALID FORMAT\\. Use: UserID Amount', { parse_mode: 'MarkdownV2' });
      await usersCollection.updateOne({ _id: targetId }, { $inc: { bonus_search_count: amount } }, { upsert: true });
      await ctx.reply(`SUCCESS: ${amount} BONUS SEARCHES ADDED TO USER ${targetId}`, { parse_mode: 'MarkdownV2' });
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
