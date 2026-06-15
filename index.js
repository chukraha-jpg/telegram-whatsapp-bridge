import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import sharp from 'sharp';
import qr from 'qrcode-terminal';
import { Telegraf } from 'telegraf';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROUP_NAME = process.env.GROUP_NAME || 'Dosti Deals';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '';
const BLUR_ENABLED = (process.env.BLUR_ENABLED || 'true').toLowerCase() === 'true';
const BLUR_X = Number(process.env.BLUR_X || 0);
const BLUR_Y = Number(process.env.BLUR_Y || 0);
const BLUR_WIDTH = Number(process.env.BLUR_WIDTH || 600);
const BLUR_HEIGHT = Number(process.env.BLUR_HEIGHT || 220);
const BLUR_SIGMA = Number(process.env.BLUR_SIGMA || 18);
const MIN_DELAY_MS = Number(process.env.MIN_DELAY_MS || 8000);
const MAX_DELAY_MS = Number(process.env.MAX_DELAY_MS || 20000);

if (!TELEGRAM_TOKEN) {
  console.error('Missing TELEGRAM_TOKEN');
  process.exit(1);
}

let WHATSAPP_GROUP_ID = '';

const bot = new Telegraf(TELEGRAM_TOKEN);
const waClient = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    executablePath: '/opt/render/project/src/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  }
});

function randomDelay() {
  return Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function notifyAdmin(text) {
  if (!ADMIN_CHAT_ID) return;
  try {
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, text);
  } catch (e) {
    console.error('Admin notify failed:', e.message);
  }
}

waClient.on('qr', (qrCode) => {
  console.log('Scan this WhatsApp QR from Linked Devices:');
  qr.generate(qrCode, { small: true });
});

waClient.on('ready', async () => {
  console.log('WhatsApp client ready');
  const chats = await waClient.getChats();
  const group = chats.find(c => c.isGroup && c.name && c.name.includes(GROUP_NAME));
  if (!group) {
    console.error('WhatsApp group not found. Check GROUP_NAME.');
    await notifyAdmin(`❌ WhatsApp group not found: ${GROUP_NAME}`);
    return;
  }
  WHATSAPP_GROUP_ID = group.id._serialized;
  console.log('Connected group ID:', WHATSAPP_GROUP_ID);
  await notifyAdmin(`✅ Bridge ready. WhatsApp group connected: ${GROUP_NAME}`);
});

waClient.on('auth_failure', async (msg) => {
  console.error('WhatsApp auth failure:', msg);
  await notifyAdmin(`❌ WhatsApp auth failure: ${msg}`);
});

waClient.on('disconnected', async (reason) => {
  console.error('WhatsApp disconnected:', reason);
  await notifyAdmin(`⚠️ WhatsApp disconnected: ${reason}`);
});

function ensureReady(ctx) {
  if (!WHATSAPP_GROUP_ID) {
    ctx.reply('WhatsApp group not ready yet. First connect WhatsApp QR and wait until bridge says ready.');
    return false;
  }
  return true;
}

async function fetchTelegramFileBuffer(fileId) {
  const link = await bot.telegram.getFileLink(fileId);
  const response = await fetch(link.href);
  if (!response.ok) throw new Error(`Failed to fetch Telegram file: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function blurRegion(inputBuffer) {
  if (!BLUR_ENABLED) return inputBuffer;
  const base = sharp(inputBuffer);
  const meta = await base.metadata();
  const x = Math.max(0, Math.min(BLUR_X, (meta.width || 0) - 1));
  const y = Math.max(0, Math.min(BLUR_Y, (meta.height || 0) - 1));
  const w = Math.max(1, Math.min(BLUR_WIDTH, (meta.width || 1) - x));
  const h = Math.max(1, Math.min(BLUR_HEIGHT, (meta.height || 1) - y));

  const region = await sharp(inputBuffer)
    .extract({ left: x, top: y, width: w, height: h })
    .blur(BLUR_SIGMA)
    .toBuffer();

  return await sharp(inputBuffer)
    .composite([{ input: region, left: x, top: y }])
    .jpeg({ quality: 92 })
    .toBuffer();
}

async function sendTextToWhatsApp(text) {
  await sleep(randomDelay());
  await waClient.sendMessage(WHATSAPP_GROUP_ID, text);
}

async function sendImageToWhatsApp(imageBuffer, caption = '') {
  const processed = await blurRegion(imageBuffer);
  const base64 = processed.toString('base64');
  const media = new MessageMedia('image/jpeg', base64, 'photo.jpg');
  await sleep(randomDelay());
  await waClient.sendMessage(WHATSAPP_GROUP_ID, media, { caption });
}

bot.start((ctx) => {
  ctx.reply(
    'Bridge ready command list:\
\
' +
    '1) Send normal text -> goes to WhatsApp group\
' +
    '2) Send photo with caption -> goes to WhatsApp group with caption\
' +
    '3) Send photo without caption -> goes to WhatsApp group photo only\
\
' +
    'Important: blur area is fixed in code using env variables BLUR_X, BLUR_Y, BLUR_WIDTH, BLUR_HEIGHT.'
  );
});

bot.command('status', async (ctx) => {
  await ctx.reply(WHATSAPP_GROUP_ID ? `✅ Connected to WhatsApp group: ${GROUP_NAME}` : '⚠️ WhatsApp not connected yet');
});

bot.on('text', async (ctx) => {
  if (!ensureReady(ctx)) return;
  try {
    await sendTextToWhatsApp(ctx.message.text);
    await ctx.reply('✅ Text sent to WhatsApp group');
  } catch (e) {
    console.error(e);
    await ctx.reply('❌ Failed to send text');
  }
});

bot.on('photo', async (ctx) => {
  if (!ensureReady(ctx)) return;
  try {
    const photos = ctx.message.photo;
    const bestPhoto = photos[photos.length - 1];
    const caption = ctx.message.caption || '';
    const buffer = await fetchTelegramFileBuffer(bestPhoto.file_id);
    await sendImageToWhatsApp(buffer, caption);
    await ctx.reply(caption ? '✅ Photo with caption sent to WhatsApp group' : '✅ Photo sent to WhatsApp group');
  } catch (e) {
    console.error(e);
    await ctx.reply('❌ Failed to send photo');
  }
});

bot.launch();
waClient.initialize();
console.log('Telegram bot launched');
const port = process.env.PORT || 10000;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(port, '0.0.0.0', () => {
  console.log(`HTTP server listening on ${port}`);
});

