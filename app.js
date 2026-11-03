require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const express = require('express');
const app = express();

// 設定（.env必須）
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // 設定必須
const AUTH_ROLE_ID = process.env.AUTH_ROLE_ID; // 設定必須：ロールID
const GUILD_ID = process.env.GUILD_ID; // 設定必須：サーバーID

// === 1. IP取得ロジック (本物のIPを確実に) ===
const getUserIP = (req) => {
    // x-forwarded-for はクライアント -> プロキシ -> サーバーの順序で入っている
    const forwarded = req.headers['x-forwarded-for'];
    let ip = forwarded? forwarded.split(/, +/)[0]: req.connection.remoteAddress;
    // IPv6の "ffff:" プレフィックスをつけたIPを標準的なIPv4アドレスに変換
    if (ip.includes(':ffff:')) {
    ip = ip.split(':')[3];
  }
    return ip;
};

// === 2. アプリケーション準備 (Botサーバー) ===
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent]
});
let guildRef = null; // サーバー情報を保持

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
    // ロールを付与する対象のサーバーを取得
    const guild = client.guilds.cache.get(GUILD_ID);
    if (guild) {
    guildRef = guild;
    console.log(`Ready. Target Guild: ${guild.name} (ID: ${GUILD_ID})`);
    } else {
    console.error(`ERROR: Bot is not in the Guild ID: ${GUILD_ID}`);
  }
});

// === 3. OAuth2 URL生成 ===
const getOAuth2Url = (userId) => {
    const state = encodeURIComponent(userId);
    return `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&scope=email&response_type=code&redirect_uri=${encodeURIComponent(process.env.URL)}/callback&state=${state}`;
};

// === 4. Discord インタラクション処理 (ボタン操作) ===
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'auth') {
    startAuth(interaction);
  }
});

// コマンド: /auth
async function startAuth(interaction) {
    sessions[interaction.user.id] = { step: 1 };
    const row = new ActionRowBuilder()
 .addComponents(
    new ButtonBuilder()
 .setCustomId('btn_auth_step1')
 .setLabel('認証する')
 .setStyle(ButtonStyle.Success)
 );

    await interaction.reply({ 
    content: '次のステップへ進んでください。\nボタンが見えない場合はリロードしてください。', 
    ephemeral: true, 
    components: [row] 
  });
}

// ボタンクリック: 認証開始 -> ウェブサイトへ誘導
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;
  
    // セッション確認
    const session = sessions[interaction.user.id];
    if (!session || session.step!== 1) return;

    // 本人確認
    if (session.step === 1 && interaction.customId === 'btn_auth_step1') {
    sessions[interaction.user.id] = { step: 2 };

    // 認証ボタン不可、ウェブサイトへ飛ぶボタンのみを表示
    const row = new ActionRowBuilder()
 .addComponents(
    new ButtonBuilder()
 .setLabel('ウェブサイトに飛ぶ (OAuth2)')
 .setStyle(ButtonStyle.Primary)
 .setURL(getOAuth2Url(interaction.user.id))
 );

    await interaction.update({ 
    content: '次はウェブサイトに飛んで証明書を発行してください。', 
    components: [row] 
  });
  }
});

// === 5. Webサーバー処理 (Express) ===

// Webhook通知
async function sendWebhook(email, ip) {
    if (!WEBHOOK_URL) throw new Error("No WEBHOOK_URL in env");
 try {
    // DiscordのWebhook APIを叩く
    const res = await axios.post(WEBHOOK_URL, {
    content: `**认证者**: ${email}\n\n**IP Address**: ${ip}`, 
    username: "Auth Bot",
    avatar_url: client.user.displayAvatarURL()
  });
   } catch (e) {
    console.error("Webhook Error:", e.message);
    throw e; // エラーを呼び出し元に返す
  }
}

// ロール付与ロジック
async function grantRole(userId, email, ip) {
 try {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) throw new Error("Guild not found");

    // Botが把握しているメンバー一覧から取得
    // Botが起動していれば、メンバーがキャッシュされているはず
    const member = await guild.members.fetch(userId);
    const role = await guild.roles.fetch(AUTH_ROLE_ID);

    if (member && role) {
    // ロールの追加
    await member.roles.add(role);
    console.log(`[OK] Role added for ${userId} (${email}) - IP: ${ip}`);
    } else {
    console.warn(`[Warning] Role or User not found. User: ${userId}, RoleID: ${AUTH_ROLE_ID}`);
  }
    } catch (error) {
    console.error(`[Error] Grant Role Failed: ${error.message}`);
    // エラーをWebhookにも通知してもいい
    throw error;
  }
}

// リダイレクト先 /callback
app.get('/callback', async (req, res) => {
    const code = req.query.code;
    const state = decodeURIComponent(req.query.state || '');
    const userId = state;

    if (!code ||!userId) {
    return res.redirect(process.env.URL + '/auth-error');
 }

 try {
    // 0. トークン取得
    const tokenData = await axios.post('https://discord.com/api/oauth2/token', {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: process.env.URL + '/callback'
    }, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const email = tokenData.data.email;
    const ip = getUserIP(req); // 本物のIP取得

    // 1. Webhookを飛ばす (ログとして記録)
    await sendWebhook(email, ip);

    // 2. ロールをBotに付与させる
    await grantRole(userId, email, ip);

    // 3. 成功画面表示
    res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>認証実行結果</title></head>
    <body style="font-family: sans-serif; text-align: center; margin-top: 50px;">
    <h1>✅ チェック完了</h1>
    <p><strong>メール:</strong> ${email}</p>
    <p><strong>IP:</strong> ${ip}</p>
    <p><strong></strong></p>
    <p>ロールが付与されました。</p>
    </body>
    </html>
 `);

    } catch (err) {
    console.error("Main Loop Callback Error:", err.response? err.response.data: err.message);
    res.send(`エラーが発生しました。<br>ログを確認してください (` + err.message + `)`);
  }
});

// === 修正済み エラーページ (ここから) ===
app.get('/auth-error', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
    <style>
    body { font-family: 'Segoe UI', sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background-color: #f0f0f0; text-align: center; margin: 0; }
   .container { background-color: white; padding: 30px; border-radius: 10px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); max-width: 400px; width: 80%; }
    h2 { color: #e74c3c; margin-top: 0; }
    p { color: #555; line-height: 1.6; }
    </style>
    </head>
    <body>
    <div class="container">
    <h2>認証エラー</h2>
    <p>認証に失敗しました。</p>
    <p>ブラウザの戻るボタンを押して<br>Botのチャンネルで <code>/auth</code> をもう一度実行してください。</p>
    </div>
    </body>
    </html>
   `);
});
// === エラーページ (ここまで) ===

// アプリ起動
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    client.login(TOKEN);
});
