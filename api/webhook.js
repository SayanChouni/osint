// required libraries
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const { MongoClient } = require('mongodb');

// --- CONFIGURATION: Environment Variables ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const MANDATORY_CHANNEL_ID = process.env.MANDATORY_CHANNEL_ID || '-1002516081531'; 
// NOTE: MANDATORY_CHANNEL_ID now holds the MANDATORY GROUP ID

// MongoDB Configuration 
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = "osint_user_db"; 
const COLLECTION_NAME = "users";

const FREE_TRIAL_LIMIT = 1; // <--- FIXED: 1 FREE SEARCH
const COST_PER_SEARCH = 2; 

const ADMIN_USER_ID = parseInt(process.env.ADMIN_USER_ID); 

// API CONFIG
const API_CONFIG = {
    NUM_API_SUITE: {
        NAME_FINDER: "https://m.apisuite.in/?api=namefinder&api_key=2907591571c0d74b89dc1244a1bb1715&number=",
        AADHAAR_FINDER: "https://m.apisuite.in/?api=number-to-aadhaar&api_key=2907591571c0d74b89dc1244a1bb1715&number="
    },
    ADHAR_API: "https://aadhar-info-vishal.0001.net/api2/V2/adhar.php",
    VECHIL_API: "https://reseller-host.vercel.app/api/rc",
    PIN_API: "https://pin-code-info-vishal.22web.org/pincode_api.php",
    ADHAR_KEY: "FREE"
};

let MAINTENANCE_MODE = false;

// New Options for Vercel/Serverless Environment (for stable connection)
const client = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000, 
    socketTimeoutMS: 45000,
    maxPoolSize: 1 
});

let usersCollection;
const bot = new Telegraf(BOT_TOKEN);

const GROUP_JOIN_LINK = "https://t.me/+0Nw5y6axaAszZTA1"; // Update with your actual group invite link


// --- MongoDB Setup ---
async function connectDB() {
    if (usersCollection) return;
    if (!MONGODB_URI) {
        console.error("MONGODB_URI is not set.");
        throw new Error("Database connection failed: MONGODB_URI missing.");
    }
    try {
        await client.connect();
        const db = client.db(DB_NAME);
        usersCollection = db.collection(COLLECTION_NAME);
    } catch (e) {
        console.error("MongoDB connection failed:", e);
        throw new Error("Database connection failed. Check MONGODB_URI.");
    }
}

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

/**
 * Checks if the user is a member of the mandatory group/channel.
 * Returns true if member, false otherwise.
 */
async function checkMembership(ctx) {
    try {
        const member = await ctx.telegram.getChatMember(MANDATORY_CHANNEL_ID, ctx.from.id);
        const isMember = ['member', 'administrator', 'creator'].includes(member.status);
        return isMember;
    } catch (error) {
        console.error("Membership check error:", error.message);
        return false; 
    }
}


// --- ACCESS AND PAYMENT CHECK MIDDLEWARE ---
bot.use(async (ctx, next) => {
    
    const chat = ctx.chat;
    const user = ctx.from;
    const text = ctx.message ? ctx.message.text : '';
    const isCommand = text && (text.startsWith('/num') || text.startsWith('/adr') || text.startsWith('/v') || text.startsWith('/pin') || text.startsWith('/balance') || text.startsWith('/donate') || text.startsWith('/support') || text.startsWith('/buyapi') || text.startsWith('/admin') || text.startsWith('/status'));

    // Skip all checks for /start command by going directly to the handler
    if (text.startsWith('/start')) {
        return next();
    }
    
    // 1. ONLY process commands in private chat
    if (isCommand && chat.type !== 'private') {
         return ctx.reply('⚠️ **PLEASE USE THIS BOT IN PRIVATE CHAT.** ⚠️');
    }
    
    // 2. Maintenance Mode Check 
    if (MAINTENANCE_MODE && ctx.from.id !== ADMIN_USER_ID) {
        return ctx.reply('🛠️ **MAINTENANCE MODE!** 🛠️\n\n**THE BOT IS CURRENTLY UNDER MAINTENANCE. PLEASE TRY AGAIN LATER.**');
    }

    if (isCommand) {
        const userData = await getUserData(user.id);
        
        // 2a. Handle Admin Panel Input via text message (Stateful Logic)
        if (userData.role === 'admin' && userData.admin_state && !text.startsWith('/admin')) {
            return bot.handleUpdate(ctx.update); 
        }

        if (userData.is_suspended) {
             return ctx.reply('⚠️ **ACCOUNT SUSPENDED!** 🚫\n\n**PLEASE CONTACT THE ADMIN.**');
        }

        // 3. Mandatory Group Join Check 
        const isMember = await checkMembership(ctx);
        if (!isMember) {
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.url("🔒 JOIN MANDATORY GROUP", GROUP_JOIN_LINK)]
            ]);
            // CHANGED: Removed "CHANNEL" from message
            return ctx.reply('⛔️ **ACCESS REQUIRED!** ⛔️\n\n**YOU MUST BE A MEMBER OF THE GROUP TO USE COMMANDS. Use /start.**', keyboard);
        }

        // 4. Credit/Trial Check (Only if not Admin and not /balance or support command)
        if (userData.role !== 'admin' && !text.startsWith('/balance') && !text.startsWith('/donate') && !text.startsWith('/support') && !text.startsWith('/buyapi')) {
            let isFree = userData.search_count < FREE_TRIAL_LIMIT;
            let hasBalance = userData.balance >= COST_PER_SEARCH;

            if (!isFree && !hasBalance) {
                // FIXED: Custom Insufficient Balance Message
                const insufficientBalanceMessage = `
⚠️ **INSUFFICIENT BALANCE!**

**YOU HAVE ALREADY USED YOUR ${FREE_TRIAL_LIMIT} FREE SEARCH.**
**TO CONTINUE USING THE BOT, PLEASE RECHARGE A MINIMUM OF ₹25 TO ADD CREDITS TO YOUR ACCOUNT.**

**AFTER RECHARGE, YOU WILL BE ABLE TO USE ALL FEATURES WITHOUT ANY INTERRUPTION! 🔥**
**FOR CREDIT TOP-UP, PLEASE CONTACT: @ZECBOY 📩**
**THANK YOU FOR USING OUR SERVICE! 😊💙**`;

                return ctx.reply(insufficientBalanceMessage, { parse_mode: 'Markdown' });
            }
            
            // 5. Deduct Credit/Update Trial Count
            let updateQuery = { $inc: { search_count: 1 } };
            
            if (!isFree) {
                updateQuery.$inc.balance = -COST_PER_SEARCH;
            }

            await usersCollection.updateOne({ _id: user.id }, updateQuery);

            const currentStatus = await usersCollection.findOne({ _id: user.id });
            const freeLeft = Math.max(0, FREE_TRIAL_LIMIT - currentStatus.search_count);
            ctx.reply(`💳 **TRANSACTION SUCCESSFUL!**\n\n**COST:** ${isFree ? '0' : COST_PER_SEARCH} TK. **BALANCE LEFT:** ${currentStatus.balance} TK. **FREE USES LEFT:** ${freeLeft}.`);
        }
    }

    return next();
});


// --- API HANDLER FUNCTION (General) ---

async function fetchAndSendReport(ctx, apiEndpoint, paramValue, targetName) {
    if (!paramValue) {
        return ctx.reply(`👉 **INPUT MISSING!** 🥺\n\n**PLEASE PROVIDE A VALID ${targetName}.**`);
    }
    
    ctx.reply(`🔎 **SEARCHING!** 🧐\n\n**INITIATING SCAN FOR ${targetName}:** \`${paramValue}\`...`, { parse_mode: 'Markdown' });

    try {
        const response = await axios.get(apiEndpoint);
        const resultData = response.data;
        
        const outputText = typeof resultData === 'object' ? 
            `**--- OSINT REPORT ---**\n**Target:** ${targetName} ${paramValue}\n\n${JSON.stringify(resultData, null, 2)}` : 
            `**--- OSINT REPORT ---**\n**Target:** ${targetName} ${paramValue}\n\n${resultData}`;
        
        return ctx.replyWithDocument(
            { source: Buffer.from(outputText, 'utf-8'), filename: `osint_report_${targetName}_${paramValue}.txt` },
            { caption: `✅ **SUCCESS!** 🥳\n\n**OSINT REPORT GENERATED FOR ${targetName}.**` }
        );

    } catch (error) {
        console.error(`Error fetching ${targetName} info:`, error.message);
        const errorMsg = error.response ? JSON.stringify(error.response.data, null, 2) : error.message;
        return ctx.reply(`❌ **API ERROR!** 🤯\n\n**FAILED TO FETCH DATA. CHECK TARGET INPUT AND API STATUS.**\n**ERROR MESSAGE:** \`${errorMsg}\``, { parse_mode: 'Markdown' });
    }
}


// --- COMMAND HANDLERS SETUP ---

// COMMAND: /start (Conditional Welcome)
bot.start(async (ctx) => {
    const isMember = await checkMembership(ctx);
    
    if (isMember) {
        // Option 1: User is a member, show the main menu
        const welcomeMessage = `
**┏━━✨INFORA PRO ✨━━┓**

👋 **Hey! I’m your OSINT/Search copilot—fast, precise & private.**
📊 **ONE TIME FREE TRAIL**
**• PER searches cost ${COST_PER_SEARCH} credit 💳**
**• Works in BOT only for privacy 👥🔐**

**— — — — — — — — — — — — — — — — — —**
🔎 **Basic Lookups**
**• /num <phone> — 10-digit mobile details**
**• /adr <aadhar> — Aadhaar (12-digit) info**
**• /familyinfo <aadhar> — Family lookup by Aadhaar (consent required)**
**• /v <vehicle> — Vehicle number lookup**
**• /pin <pincode> —— Area pin code look up** **🛠 Support & Extras**
**• /balance — Balance & searches**
**• /donate — Support the project**
**• /support — Contact support**
**• /buyapi — Private API access**

**— — — — — — — — — — — — — — — — — —**
**⚡️ Powered by: @zecboy**
**🌐 Stay Safe • Respect Privacy • Use Responsibly 🚀**
        `;
        ctx.reply(welcomeMessage, { parse_mode: 'Markdown' });

    } else {
        // Option 2: User is NOT a member, show join prompt
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.url("🔒 JOIN MANDATORY GROUP", GROUP_JOIN_LINK)]
        ]);

        ctx.reply(
            // CHANGED: Display 1 FREE SEARCH
            '👋 **WELCOME TO OSINT BOT!** 🥳\n\n**THIS BOT WORKS ONLY IN PRIVATE CHAT.**\n**YOU GET 1 FREE SEARCH! EACH SEARCH COSTS 2 TK AFTER TRIAL.**\n\n**YOU MUST JOIN THE GROUP BELOW TO USE COMMANDS:**',
            keyboard
        );
    }
});

// COMMAND: /balance (renamed from /credits in menu)
bot.command('balance', async (ctx) => {
    const userData = await getUserData(ctx.from.id);
    const usesLeft = Math.max(0, FREE_TRIAL_LIMIT - userData.search_count);
    
    ctx.reply(`💰 **YOUR ACCOUNT BALANCE** 💰\n\n**BALANCE:** ${userData.balance} TK\n**FREE USES LEFT:** ${usesLeft}`);
});


// --- NEW SUPPORT HANDLERS ---
const supportResponse = '**✨ MESSAGE HERE**\n\n**F E E L . F R E E . T O . D M**\n\n**👉 @zecboy**';

bot.command(['donate', 'support', 'buyapi'], (ctx) => {
    ctx.reply(supportResponse, { parse_mode: 'Markdown' });
});


// --- BASIC LOOKUP COMMANDS ---
// COMMAND: /num <phone> (COMBINED API)
bot.command('num', async (ctx) => {
    const phone = ctx.message.text.split(' ')[1];
    if (!phone) {
        return ctx.reply("👉 **INPUT MISSING!** 🥺\n\n**PLEASE PROVIDE A VALID PHONE NUMBER.**");
    }

    ctx.reply(`🔎 **SEARCHING!** 🧐\n\n**COMBINING DATA FOR PHONE NUMBER:** \`${phone}\`...`, { parse_mode: 'Markdown' });

    try {
        const [nameResponse, aadhaarResponse] = await Promise.all([
            axios.get(`${API_CONFIG.NUM_API_SUITE.NAME_FINDER}${phone}`),
            axios.get(`${API_CONFIG.NUM_API_SUITE.AADHAAR_FINDER}${phone}`)
        ]);

        const combinedResult = {
            "PHONE_NUMBER": phone,
            "NAME_FINDER_INFO": nameResponse.data,
            "AADHAAR_INFO": aadhaarResponse.data,
        };
        
        const outputText = `**--- COMBINED OSINT REPORT ---**\n**Target:** PHONE NUMBER ${phone}\n\n${JSON.stringify(combinedResult, null, 2)}`;
        
        return ctx.replyWithDocument(
            { source: Buffer.from(outputText, 'utf-8'), filename: `osint_report_phone_${phone}.txt` },
            { caption: `✅ **SUCCESS!** 🥳\n\n**COMPREHENSIVE REPORT GENERATED FOR PHONE NUMBER.**` }
        );

    } catch (error) {
        console.error("Combined API Error:", error.message);
        return ctx.reply(`❌ **API ERROR!** 🤯\n\n**FAILED TO GET DATA FROM ONE OR BOTH APIs. CHECK API KEYS/STATUS.**`);
    }
});

// Other Commands using the general handler
bot.command('adr', async (ctx) => {
    const aadhaar = ctx.message.text.split(' ')[1];
    const apiUrl = `${API_CONFIG.ADHAR_API}?key=${API_CONFIG.ADHAR_KEY}&aadhaar=${aadhaar}`;
    await fetchAndSendReport(ctx, apiUrl, aadhaar, "AADHAR NUMBER");
});

bot.command('v', async (ctx) => {
    const vehNumber = ctx.message.text.split(' ')[1];
    const apiUrl = `${API_CONFIG.VECHIL_API}?number=${vehNumber}`;
    await fetchAndSendReport(ctx, apiUrl, vehNumber, "VEHICLE NUMBER");
});

bot.command('pin', async (ctx) => {
    const pincode = ctx.message.text.split(' ')[1];
    const apiUrl = `${API_CONFIG.PIN_API}?pincode=${pincode}`;
    await fetchAndSendReport(ctx, apiUrl, pincode, "PIN CODE");
});

// Dummy command for /familyinfo
bot.command('familyinfo', (ctx) => {
    return ctx.reply("⚠️ **COMMAND INCOMPLETE!** ⚠️\n\n**API for family lookup is currently not implemented.**");
});


// --- ADMIN PANEL COMMANDS ---

const adminCheck = (ctx, next) => {
    if (ctx.from.id !== ADMIN_USER_ID) return ctx.reply("❌ **ADMIN ACCESS DENIED.**");
    return next();
};

// COMMAND: /admin (Admin Menu)
bot.command('admin', adminCheck, (ctx) => {
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('➕ ADD CREDIT', 'admin_add_credit')],
        [Markup.button.callback('➖ REMOVE CREDIT', 'admin_remove_credit')],
        [Markup.button.callback('🛑 SUSPEND USER', 'admin_suspend')],
        [Markup.button.callback('🟢 UNBAN USER', 'admin_unban')],
        [Markup.button.callback('👤 CHECK STATUS', 'admin_status')] 
    ]);

    ctx.reply('👑 **ADMIN CONTROL PANEL** 👑\n\n**Select an action below:**', keyboard);
});

// --- STATEFUL MESSAGE HANDLER (Admin Input Processing) ---
bot.on('text', async (ctx, next) => {
    const userId = ctx.from.id;
    const userData = await getUserData(userId);

    // Only process if the user is an admin and has an active state
    if (userData.role === 'admin' && userData.admin_state && ctx.chat.type === 'private') {
        const state = userData.admin_state;
        const input = ctx.message.text.split(/\s+/).filter(Boolean);
        
        // Reset state after processing
        await usersCollection.updateOne({ _id: userId }, { $set: { admin_state: null } });

        if (state.includes('credit')) {
            const [targetIdStr, amountStr] = input;
            const targetId = parseInt(targetIdStr);
            const amount = parseInt(amountStr);

            if (!targetId || isNaN(targetId) || !amount || isNaN(amount)) {
                return ctx.reply('❌ **INVALID FORMAT.** Please use: `UserID Amount`');
            }
            
            const creditChange = state === 'admin_add_credit' ? amount : -amount;
            const actionVerb = state === 'admin_add_credit' ? 'ADDED TO' : 'REMOVED FROM';

            await usersCollection.updateOne(
                { _id: targetId },
                { $inc: { balance: creditChange } },
                { upsert: true }
            );

            return ctx.reply(`✅ **SUCCESS!** 💰\n\n**${Math.abs(amount)} TK ${actionVerb} USER ${targetId}.**`);
        } 
        
        else if (state === 'admin_suspend' || state === 'admin_unban') {
            const targetId = parseInt(input[0]);
            const isSuspended = state === 'admin_suspend';
            
            if (!targetId || isNaN(targetId)) {
                return ctx.reply('❌ **INVALID FORMAT.** Please use: `UserID`');
            }
            
            await usersCollection.updateOne(
                { _id: targetId },
                { $set: { is_suspended: isSuspended } }
            );

            const statusVerb = isSuspended ? 'SUSPENDED' : 'UNBANNED';
            return ctx.reply(`✅ **SUCCESS!** 🛑\n\n**USER ${targetId} HAS BEEN ${statusVerb}.**`);
        } 
        
        else if (state === 'admin_status') {
             const targetId = parseInt(input[0]);
             if (!targetId || isNaN(targetId)) {
                return ctx.reply('❌ **INVALID FORMAT.** Please use: `UserID`');
             }
             const tempCtx = { ...ctx, message: { text: `/status ${targetId}` } };
             return bot.handleUpdate(tempCtx.update); 
        }

    }
    
    // If it's a normal message and not an admin command, pass it on
    next();
});

// --- ACTION HANDLER (Button Clicks) ---
bot.action(/admin_(.+)/, adminCheck, async (ctx) => {
    // 1. Clean up the previous message/keyboard
    ctx.editMessageReplyMarkup({}); 
    
    const action = ctx.match[1];
    const userId = ctx.from.id;
    
    // 2. Set the Admin's state based on the button clicked
    await usersCollection.updateOne({ _id: userId }, { $set: { admin_state: action } });

    switch (action) {
        case 'add_credit':
            ctx.reply('👉 **ADD CREDIT MODE**\n\n**FORMAT:** `UserID Amount`\n\nExample: `123456789 50`');
            break;
        case 'remove_credit':
            ctx.reply('👉 **REMOVE CREDIT MODE**\n\n**FORMAT:** `UserID Amount`\n\nExample: `123456789 20`');
            break;
        case 'suspend':
            ctx.reply('👉 **SUSPEND USER MODE**\n\n**FORMAT:** `UserID`\n\nExample: `123456789`');
            break;
        case 'unban':
            ctx.reply('👉 **UNBAN USER MODE**\n\n**FORMAT:** `UserID`\n\nExample: `123456789`');
            break;
        case 'status':
            ctx.reply('👉 **CHECK STATUS MODE**\n\n**FORMAT:** `UserID`\n\nExample: `123456789`');
            break;
        default:
            ctx.reply('⚠️ **UNKNOWN ACTION.**');
    }
    // Answer callback query to stop loading icon
    ctx.answerCbQuery();
});

// --- Vercel Webhook Handling ---
module.exports = async (req, res) => {
    try {
        await connectDB();
        if (req.method === 'POST') {
            await bot.handleUpdate(req.body);
            res.status(200).send('OK');
        } else {
            res.status(200).send('OSINT Bot is running via Webhook.');
        }
    } catch (error) {
        console.error('Webhook or DB Error:', error);
        res.status(500).send(`Internal Server Error: ${error.message}`);
    }
};
