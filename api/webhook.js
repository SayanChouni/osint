// required libraries
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const { MongoClient } = require('mongodb');

// --- CONFIGURATION: Environment Variables ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const MANDATORY_CHANNEL_ID = process.env.MANDATORY_CHANNEL_ID || '-1002516081531'; 

// MongoDB Configuration 
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = "osint_user_db"; 
const COLLECTION_NAME = "users";

const FREE_TRIAL_LIMIT = 2;
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

const bot = new Telegraf(BOT_TOKEN);

// --- MongoDB Setup ---
const client = new MongoClient(MONGODB_URI);
let usersCollection;

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
            role: (userId === ADMIN_USER_ID ? 'admin' : 'user') 
        };
        await usersCollection.insertOne(newUser);
        return newUser;
    }
    return user;
}

// --- ACCESS AND PAYMENT CHECK MIDDLEWARE ---
bot.use(async (ctx, next) => {
    
    const chat = ctx.chat;
    const user = ctx.from;
    const isCommand = ctx.message && (ctx.message.text && (ctx.message.text.startsWith('/num') || ctx.message.text.startsWith('/adr') || ctx.message.text.startsWith('/v') || ctx.message.text.startsWith('/pin') || ctx.message.text.startsWith('/balance') || ctx.message.text.startsWith('/start')));

    // Skip all checks for /start command by going directly to the handler
    if (ctx.message && ctx.message.text && ctx.message.text.startsWith('/start')) {
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
        
        if (userData.is_suspended) {
             return ctx.reply('⚠️ **ACCOUNT SUSPENDED!** 🚫\n\n**PLEASE CONTACT THE ADMIN.**');
        }

        // 3. Mandatory Channel Join Check 
        try {
            const member = await ctx.telegram.getChatMember(MANDATORY_CHANNEL_ID, user.id);
            const isMember = ['member', 'administrator', 'creator'].includes(member.status);
            if (!isMember) {
                // FIXED: Using Markup.button.url
                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.url("🔒 JOIN OUR PRIVATE CHANNEL", "https://t.me/+0Nw5y6axaAszZTA1")]
                ]);
                return ctx.reply('⛔️ **ACCESS REQUIRED!** ⛔️\n\n**YOU MUST BE A MEMBER OF THE CHANNEL TO USE COMMANDS.**', keyboard);
            }
        } catch (error) {
            console.error("Channel check error:", error.message);
            if (error.message.includes('chat member status is inaccessible')) {
                 return ctx.reply('⚠️ **CONFIG ERROR!** ⚠️\n\n**PLEASE MAKE SURE THE BOT IS AN ADMIN IN THE PRIVATE CHANNEL.**');
            }
        }

        // 4. Credit/Trial Check (Only if not Admin and not /balance command)
        if (userData.role !== 'admin' && !ctx.message.text.startsWith('/balance')) {
            let isFree = userData.search_count < FREE_TRIAL_LIMIT;
            let hasBalance = userData.balance >= COST_PER_SEARCH;

            if (!isFree && !hasBalance) {
                // FIXED: Using Markup.button.url
                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.url(`💰 DEPOSIT MONEY (2 TK/SEARCH)`, "YOUR_PAYMENT_LINK")] 
                ]);
                return ctx.reply(
                    `⛔️ **LOW BALANCE!** ⛔️\n\n**YOUR BALANCE IS ${userData.balance} TK. EACH SEARCH COSTS ${COST_PER_SEARCH} TK.**\n\n**FREE TRIAL OVER. PLEASE DEPOSIT TO CONTINUE.**`,
                    keyboard
                );
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
            `--- OSINT REPORT ---\nTarget: ${targetName} ${paramValue}\n\n${JSON.stringify(resultData, null, 2)}` : 
            `--- OSINT REPORT ---\nTarget: ${targetName} ${paramValue}\n\n${resultData}`;
        
        return ctx.replyWithDocument(
            { source: Buffer.from(outputText, 'utf-8'), filename: `osint_report_${targetName}_${paramValue}.txt` },
            { caption: `✅ **SUCCESS!** 🥳\n\n**OSINT REPORT GENERATED FOR ${targetName}.**` }
        );

    } catch (error) {
        console.error(`Error fetching ${targetName} info:`, error.message);
        const errorMsg = error.response ? JSON.stringify(error.response.data, null, 2) : error.message;
        return ctx.reply(`❌ **API ERROR!** 🤯\n\n**FAILED TO FETCH DATA. CHECK TARGET INPUT AND API STATUS.**\n\`${errorMsg}\``, { parse_mode: 'Markdown' });
    }
}


// --- COMMAND HANDLERS SETUP ---

// COMMAND: /start
bot.start((ctx) => {
    // FIXED: Using Markup.button.url
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.url("🔒 JOIN OUR PRIVATE CHANNEL", "https://t.me/+0Nw5y6axaAszZTA1")]
    ]);

    ctx.reply(
        '👋 **WELCOME TO OSINT BOT!** 🥳\n\n**THIS BOT WORKS ONLY IN PRIVATE CHAT.**\n**YOU GET 2 FREE SEARCHES! EACH SEARCH COSTS 2 TK AFTER TRIAL.**\n\n**YOU MUST JOIN THE CHANNEL BELOW TO USE COMMANDS:**',
        keyboard
    );
});

// COMMAND: /balance
bot.command('balance', async (ctx) => {
    const userData = await getUserData(ctx.from.id);
    const usesLeft = Math.max(0, FREE_TRIAL_LIMIT - userData.search_count);
    
    ctx.reply(`💰 **YOUR ACCOUNT BALANCE** 💰\n\n**BALANCE:** ${userData.balance} TK\n**FREE USES LEFT:** ${usesLeft}`);
});

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
        
        const outputText = `--- COMBINED OSINT REPORT ---\nTarget: PHONE NUMBER ${phone}\n\n${JSON.stringify(combinedResult, null, 2)}`;
        
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


// --- ADMIN PANEL COMMANDS ---

const adminCheck = (ctx, next) => {
    if (ctx.from.id !== ADMIN_USER_ID) return ctx.reply("❌ **ADMIN ACCESS DENIED.**");
    return next();
};

// COMMAND: /add_balance <UserID> <Amount>
bot.command('add_balance', adminCheck, async (ctx) => {
    const [cmd, targetIdStr, amountStr] = ctx.message.text.split(/\s+/);
    const targetId = parseInt(targetIdStr);
    const amount = parseInt(amountStr);

    if (!targetId || isNaN(targetId) || !amount || isNaN(amount)) {
        return ctx.reply('👉 **FORMAT:** /add_balance <UserID> <Amount>');
    }

    const updated = await usersCollection.updateOne(
        { _id: targetId },
        { $inc: { balance: amount } },
        { upsert: true } 
    );
    
    if (updated.modifiedCount === 1 || updated.upsertedCount === 1) {
        ctx.reply(`✅ **SUCCESS!** 💰\n\n**${amount} TK ADDED TO USER ${targetId}.**`);
    } else {
         ctx.reply(`⚠️ **ERROR:** Could not update user.`);
    }
});

// COMMAND: /status <UserID>
bot.command('status', adminCheck, async (ctx) => {
    const targetIdStr = ctx.message.text.split(/\s+/)[1];
    const targetId = parseInt(targetIdStr);
    
    if (!targetId || isNaN(targetId)) {
        return ctx.reply('👉 **FORMAT:** /status <UserID>');
    }
    
    const user = await getUserData(targetId);
    if (!user) return ctx.reply('⚠️ **USER NOT FOUND.**');
    
    const usesLeft = Math.max(0, FREE_TRIAL_LIMIT - user.search_count);
    
    ctx.reply(`👤 **USER STATUS REPORT** 📋
    
**ID:** ${user._id}
**Role:** ${user.role.toUpperCase()}
**Balance:** ${user.balance} TK
**Free Searches Left:** ${usesLeft}
**Suspended:** ${user.is_suspended ? 'YES 🛑' : 'NO ✅'}`
    );
});


// COMMAND: /suspend <UserID> <true/false>
bot.command('suspend', adminCheck, async (ctx) => {
    const [cmd, targetIdStr, statusStr] = ctx.message.text.split(/\s+/);
    const targetId = parseInt(targetIdStr);
    const status = statusStr.toLowerCase() === 'true';

    if (!targetId || isNaN(targetId) || (statusStr !== 'true' && statusStr !== 'false')) {
        return ctx.reply('👉 **FORMAT:** /suspend <UserID> <true/false>');
    }

    const updated = await usersCollection.updateOne(
        { _id: targetId },
        { $set: { is_suspended: status } }
    );
    
    if (updated.modifiedCount === 1) {
        ctx.reply(`✅ **SUCCESS!** 🛑\n\n**USER ${targetId} SUSPENSION SET TO ${status}.**`);
    } else {
         ctx.reply(`⚠️ **USER NOT FOUND.**`);
    }
});

// COMMAND: /maintenance_on
bot.command('maintenance_on', adminCheck, (ctx) => {
    MAINTENANCE_MODE = true;
    ctx.reply('🛠️ **MAINTENANCE MODE ACTIVATED!** 🛠️\n\n**BOT IS NOW OFFLINE FOR NON-ADMINS.**');
});

// COMMAND: /maintenance_off
bot.command('maintenance_off', adminCheck, (ctx) => {
    MAINTENANCE_MODE = false;
    ctx.reply('🎉 **MAINTENANCE MODE DEACTIVATED!** 🎉\n\n**BOT IS NOW LIVE!**');
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
