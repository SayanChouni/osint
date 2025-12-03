// Required libraries
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
// We don't need querystring as we build URLs manually

// --- CONFIGURATION: Environment Variables ---
const BOT_TOKEN = process.env.BOT_TOKEN;
// IMPORTANT: This is the numeric ID of your PUBLIC GROUP where users execute commands.
const COMMAND_GROUP_ID = parseInt(process.env.COMMAND_GROUP_ID); 
// Private Channel ID provided by user
const MANDATORY_CHANNEL_ID = process.env.MANDATORY_CHANNEL_ID || '-1002516081531'; 

const bot = new Telegraf(BOT_TOKEN);

// --- API Base URLs and Keys ---
const API_CONFIG = {
    NUM_API: "https://osint-info.great-site.net/num.php",
    ADHAR_API: "https://aadhar-info-vishal.0001.net/api2/V2/adhar.php",
    VECHIL_API: "https://reseller-host.vercel.app/api/rc",
    PIN_API: "https://pin-code-info-vishal.22web.org/pincode_api.php",
    NUM_KEY: "Vishal",
    ADHAR_KEY: "FREE"
};

// --- ACCESS AND JOINING CHECK MIDDLEWARE ---
bot.use(async (ctx, next) => {
    const chat = ctx.chat;
    const user = ctx.from;
    
    // 1. Group Exclusivity Check
    if (chat && chat.id !== COMMAND_GROUP_ID) {
        if (chat.type === 'private') {
            ctx.reply('🚫 **ACCESS DENIED!** 🚫\n\n**PLEASE USE THIS BOT ONLY IN OUR AUTHORIZED GROUP.**');
        } 
        return; // Stop processing outside the command group
    }

    // 2. Mandatory Channel Join Check (Only for OSINT commands)
    if (ctx.message && (ctx.message.text.startsWith('/num') || ctx.message.text.startsWith('/adr') || ctx.message.text.startsWith('/v') || ctx.message.text.startsWith('/pin'))) {
        try {
            // Check if user is a member of the mandatory channel
            const member = await ctx.telegram.getChatMember(MANDATORY_CHANNEL_ID, user.id);
            const isMember = ['member', 'administrator', 'creator'].includes(member.status);

            if (!isMember) {
                // If not a member, show joining buttons again
                const keyboard = Markup.inlineKeyboard([
                    [Markup.urlButton("➡️ USE ME HERE (GROUP)", "https://t.me/+3TSyKHmwOvRmNDJl")],
                    [Markup.urlButton("🔒 JOIN OUR PRIVATE CHANNEL", "https://t.me/+0Nw5y6axaAszZTA1")]
                ]);
                return ctx.reply(
                    '⛔️ **ACCESS REQUIRED!** ⛔️\n\n**YOU MUST BE A MEMBER OF BOTH OUR PRIVATE CHANNEL AND THE COMMAND GROUP TO USE OSINT TOOLS.**',
                    keyboard
                );
            }
        } catch (error) {
            console.error("Channel check error:", error.message);
            // This usually happens if the bot is not an admin in the private channel
            return ctx.reply('⚠️ **CONFIGURATION ERROR!** ⚠️\n\n**COULD NOT VERIFY MEMBERSHIP. PLEASE ENSURE THE BOT IS AN ADMIN IN THE PRIVATE CHANNEL.**');
        }
    }

    return next(); // Proceed if all checks pass
});

// --- API HANDLER FUNCTION ---

async function fetchAndSendReport(ctx, apiEndpoint, paramValue, targetName) {
    if (!paramValue) {
        return ctx.reply(`👉 **INPUT MISSING!** 🥺\n\n**PLEASE PROVIDE A VALID ${targetName}.**`);
    }

    ctx.reply(`🔎 **SEARCHING!** 🧐\n\n**INITIATING SCAN FOR ${targetName}:** \`${paramValue}\`...`, { parse_mode: 'Markdown' });

    try {
        const response = await axios.get(apiEndpoint);
        const resultData = response.data;
        
        // Prepare the output text for the TXT file
        const outputText = typeof resultData === 'object' ? 
            `--- OSINT REPORT ---\nTarget: ${targetName} ${paramValue}\n\n${JSON.stringify(resultData, null, 2)}` : 
            `--- OSINT REPORT ---\nTarget: ${targetName} ${paramValue}\n\n${resultData}`;
        
        // Send the TXT file using Buffer
        return ctx.replyWithDocument(
            { source: Buffer.from(outputText, 'utf-8'), filename: `osint_report_${targetName}_${paramValue}.txt` },
            { caption: `✅ **SUCCESS!** 🥳\n\n**OSINT REPORT GENERATED FOR ${targetName}.**` }
        );

    } catch (error) {
        console.error(`Error fetching ${targetName} info:`, error.message);
        // Display API error to the user
        const errorMsg = error.response ? JSON.stringify(error.response.data, null, 2) : error.message;
        return ctx.reply(`❌ **API ERROR!** 🤯\n\n**FAILED TO FETCH DATA. PLEASE CHECK TARGET INPUT AND API STATUS.**\n\`${errorMsg}\``, { parse_mode: 'Markdown' });
    }
}


// --- COMMAND HANDLERS SETUP ---

// COMMAND: /start
bot.start((ctx) => {
    const keyboard = Markup.inlineKeyboard([
        [Markup.urlButton("➡️ USE ME HERE (GROUP)", "https://t.me/+3TSyKHmwOvRmNDJl")],
        [Markup.urlButton("🔒 JOIN OUR PRIVATE CHANNEL", "https://t.me/+0Nw5y6axaAszZTA1")]
    ]);

    ctx.reply(
        '👋 **WELCOME TO OSINT BOT!** 🥳\n\n**TO ACTIVATE THE BOT, YOU MUST BE A MEMBER OF BOTH THE OFFICIAL GROUP AND THE PRIVATE CHANNEL.**\n\n**CLICK BELOW TO JOIN:**',
        keyboard
    );
});

// COMMAND: /num <phone>
bot.command('num', async (ctx) => {
    const phone = ctx.message.text.split(' ')[1];
    const apiUrl = `${API_CONFIG.NUM_API}?key=${API_CONFIG.NUM_KEY}&phone=${phone}`;
    await fetchAndSendReport(ctx, apiUrl, phone, "PHONE NUMBER");
});

// COMMAND: /adr <aadhaar>
bot.command('adr', async (ctx) => {
    const aadhaar = ctx.message.text.split(' ')[1];
    const apiUrl = `${API_CONFIG.ADHAR_API}?key=${API_CONFIG.ADHAR_KEY}&aadhaar=${aadhaar}`;
    await fetchAndSendReport(ctx, apiUrl, aadhaar, "AADHAR NUMBER");
});

// COMMAND: /v <veh_number>
bot.command('v', async (ctx) => {
    const vehNumber = ctx.message.text.split(' ')[1];
    const apiUrl = `${API_CONFIG.VECHIL_API}?number=${vehNumber}`;
    await fetchAndSendReport(ctx, apiUrl, vehNumber, "VEHICLE NUMBER");
});

// COMMAND: /pin <pincode>
bot.command('pin', async (ctx) => {
    const pincode = ctx.message.text.split(' ')[1];
    const apiUrl = `${API_CONFIG.PIN_API}?pincode=${pincode}`;
    await fetchAndSendReport(ctx, apiUrl, pincode, "PIN CODE");
});


// --- Vercel Webhook Handling ---
module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') {
            await bot.handleUpdate(req.body);
            res.status(200).send('OK');
        } else {
            res.status(200).send('OSINT Bot is running via Webhook.');
        }
    } catch (error) {
        console.error('Webhook Error:', error);
        res.status(500).send('Internal Server Error');
    }
};