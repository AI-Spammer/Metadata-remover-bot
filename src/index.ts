import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { Markup, Telegraf } from 'telegraf';
import sharp from 'sharp';
import { PDFDocument, PDFName } from 'pdf-lib';

const BOT_TOKEN = process.env.BOT_TOKEN?.trim();
const TARGET_CHAT_ID = process.env.TARGET_CHAT_ID?.trim();
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME?.trim();
const CHANNEL_ID = process.env.CHANNEL_ID?.trim();
const CHANNEL_JOIN_URL = process.env.CHANNEL_JOIN_URL?.trim();
const ADMIN_ID = process.env.ADMIN_ID?.trim();
const MAX_REMOVALS_PER_HOUR = Number.parseInt(process.env.MAX_REMOVALS_PER_HOUR ?? '10', 10);
const DAILY_RESET_TZ = process.env.DAILY_RESET_TZ?.trim() || 'UTC';

if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN is missing. Add it to your .env file.');
}

if (!CHANNEL_USERNAME && !CHANNEL_ID) {
  console.warn('CHANNEL_USERNAME or CHANNEL_ID is not set. Channel membership checks will be disabled.');
}

const bot = new Telegraf(BOT_TOKEN);

const DATA_DIR = path.join(process.cwd(), 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const LIMITS_FILE = path.join(DATA_DIR, 'limits.json');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const IMAGE_MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

type TelegramFile = {
  file_id: string;
  file_name?: string;
  mime_type?: string;
};

type InputFileSource = Buffer | NodeJS.ReadableStream;

type UserRecord = {
  userId: number;
  username?: string;
  firstName?: string;
  lastSeenAt: string;
  lastChannelCheckDate?: string;
  channelAccessGranted?: boolean;
};

type UsersFile = {
  users: Record<string, UserRecord>;
};

type LimitEntry = {
  timestamps: number[];
};

type LimitsFile = {
  users: Record<string, LimitEntry>;
};

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return fallback;
    try {
      return JSON.parse(trimmed) as T;
    } catch (parseErr) {
      const brokenPath = `${filePath}.broken-${Date.now()}`;
      try {
        await fs.rename(filePath, brokenPath);
      } catch {
        // Ignore rename failures; we still want the bot to start.
      }
      console.warn(`Invalid JSON in ${filePath}. A backup was saved to ${brokenPath}. Using fallback data.`);
      return fallback;
    }
  } catch (err: any) {
    if (err?.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJson(filePath: string, data: unknown) {
  await ensureDataDir();
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, filePath);
}

async function loadUsers(): Promise<UsersFile> {
  return readJson<UsersFile>(USERS_FILE, { users: {} });
}

async function saveUsers(data: UsersFile) {
  await writeJson(USERS_FILE, data);
}

async function loadLimits(): Promise<LimitsFile> {
  return readJson<LimitsFile>(LIMITS_FILE, { users: {} });
}

async function saveLimits(data: LimitsFile) {
  await writeJson(LIMITS_FILE, data);
}

function getTodayKey(timeZone = DAILY_RESET_TZ): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function normalizeUserId(ctx: any): number | null {
  const id = ctx.from?.id;
  return typeof id === 'number' ? id : null;
}

function normalizeUsername(ctx: any): string | undefined {
  return ctx.from?.username ? String(ctx.from.username) : undefined;
}

function normalizeFirstName(ctx: any): string | undefined {
  return ctx.from?.first_name ? String(ctx.from.first_name) : undefined;
}

function getChannelJoinUrl(): string | undefined {
  if (CHANNEL_JOIN_URL) return CHANNEL_JOIN_URL;
  if (CHANNEL_USERNAME) {
    const username = CHANNEL_USERNAME.replace(/^@/, '');
    return `https://t.me/${username}`;
  }
  return undefined;
}

function channelJoinMarkup() {
  const joinUrl = getChannelJoinUrl();
  if (!joinUrl) {
    return Markup.inlineKeyboard([
      Markup.button.callback("I\'ve Joined", "check_join"),
    ]);
  }

  return Markup.inlineKeyboard([
    Markup.button.url('Join Channel', joinUrl),
    Markup.button.callback("I\'ve Joined", "check_join"),
  ]);
}

function getNameExt(fileName?: string): string {
  if (!fileName) return '';
  const lower = fileName.toLowerCase();
  const idx = lower.lastIndexOf('.');
  return idx >= 0 ? lower.slice(idx) : '';
}

function isPdfDocument(doc: TelegramFile): boolean {
  const name = doc.file_name?.toLowerCase() ?? '';
  const mime = doc.mime_type?.toLowerCase() ?? '';
  return mime === 'application/pdf' || name.endsWith('.pdf');
}

function isImageDocument(doc: TelegramFile): boolean {
  const mime = doc.mime_type?.toLowerCase() ?? '';
  const ext = getNameExt(doc.file_name);
  if (mime.startsWith('image/')) return true;
  return IMAGE_EXTENSIONS.has(ext);
}

function isAllowedDocument(doc: TelegramFile): boolean {
  return isPdfDocument(doc) || isImageDocument(doc);
}

function safeBaseName(fileName?: string, fallback = 'document'): string {
  if (!fileName) return fallback;
  const ext = getNameExt(fileName);
  const base = ext ? fileName.slice(0, -ext.length) : fileName;
  const trimmed = base.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function extensionForNameOrMime(fileName?: string, mimeType?: string): string {
  const ext = getNameExt(fileName);
  if (ext) return ext;
  const mime = mimeType?.toLowerCase() ?? '';
  if (IMAGE_MIME_TO_EXT[mime]) return IMAGE_MIME_TO_EXT[mime];
  if (mime === 'application/pdf') return '.pdf';
  if (mime.startsWith('image/')) return '.jpg';
  return '';
}

async function downloadTelegramFile(ctx: any, fileId: string): Promise<Buffer> {
  const link = await ctx.telegram.getFileLink(fileId);
  const res = await fetch(link.toString());
  if (!res.ok) {
    throw new Error(`Failed to download file: ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function stripImageMetadata(
  input: Buffer,
  originalName?: string,
  mimeType?: string,
): Promise<{ buffer: Buffer; filename: string; mimeType: string } | null> {
  try {
    const ext = extensionForNameOrMime(originalName, mimeType);
    const baseName = safeBaseName(originalName, 'image');

    let image = sharp(input, { failOn: 'none' });

    if (ext === '.png') {
      image = image.png();
      return {
        buffer: await image.toBuffer(),
        filename: `${baseName}.png`,
        mimeType: 'image/png',
      };
    }

    if (ext === '.webp') {
      image = image.webp({ effort: 4 });
      return {
        buffer: await image.toBuffer(),
        filename: `${baseName}.webp`,
        mimeType: 'image/webp',
      };
    }

    const buffer = await image.jpeg({ quality: 100, mozjpeg: false }).toBuffer();
    return {
      buffer,
      filename: `${baseName}.jpg`,
      mimeType: 'image/jpeg',
    };
  } catch (err) {
    console.error('Image metadata stripping failed:', err);
    return null;
  }
}

async function stripPdfMetadata(input: Buffer, originalName?: string): Promise<{ buffer: Buffer; filename: string; mimeType: string } | null> {
  try {
    const pdfDoc = await PDFDocument.load(input, { updateMetadata: false });

    const metadataKey = PDFName.of('Metadata');
    if (pdfDoc.catalog.get(metadataKey)) {
      pdfDoc.catalog.delete(metadataKey);
    }

    pdfDoc.setTitle('');
    pdfDoc.setAuthor('');
    pdfDoc.setSubject('');
    pdfDoc.setKeywords([]);
    pdfDoc.setProducer('');
    pdfDoc.setCreator('');

    if (pdfDoc.context?.trailerInfo?.Info) {
      delete pdfDoc.context.trailerInfo.Info;
    }

    const bytes = await pdfDoc.save({ useObjectStreams: false });
    const baseName = safeBaseName(originalName, 'document');

    return {
      buffer: Buffer.from(bytes),
      filename: `${baseName}.pdf`,
      mimeType: 'application/pdf',
    };
  } catch (err) {
    console.error('PDF metadata stripping failed:', err);
    return null;
  }
}

async function sendAsDocument(ctx: any, source: InputFileSource, fileName: string, mimeType?: string, caption?: string) {
  const destination = TARGET_CHAT_ID ? Number(TARGET_CHAT_ID) : ctx.chat.id;
  await ctx.telegram.sendDocument(
    destination,
    { source, filename: fileName },
    { caption, disable_content_type_detection: true, ...(mimeType ? { contentType: mimeType } : {}) } as any,
  );
}

async function processImageAndReply(ctx: any, input: Buffer, originalName?: string, mimeType?: string, caption?: string) {
  const cleaned = await stripImageMetadata(input, originalName, mimeType);
  if (!cleaned) {
    await ctx.reply('Could not process that image.');
    return;
  }
  await sendAsDocument(ctx, cleaned.buffer, cleaned.filename, cleaned.mimeType, caption);
  await ctx.reply('Image accepted and re-sent as a document.');
}

async function processPdfAndReply(ctx: any, input: Buffer, originalName?: string, caption?: string) {
  const cleaned = await stripPdfMetadata(input, originalName);
  if (!cleaned) {
    await ctx.reply('Could not process that PDF.');
    return;
  }
  await sendAsDocument(ctx, cleaned.buffer, cleaned.filename, cleaned.mimeType, caption);
  await ctx.reply('PDF accepted and re-sent as a document.');
}

async function registerUser(ctx: any): Promise<UserRecord | null> {
  const userId = normalizeUserId(ctx);
  if (!userId) return null;

  const usersFile = await loadUsers();
  const id = String(userId);
  const existing = usersFile.users[id];
  const next: UserRecord = {
    userId,
    username: normalizeUsername(ctx),
    firstName: normalizeFirstName(ctx),
    lastSeenAt: new Date().toISOString(),
    lastChannelCheckDate: existing?.lastChannelCheckDate,
    channelAccessGranted: existing?.channelAccessGranted,
  };

  usersFile.users[id] = next;
  await saveUsers(usersFile);
  return next;
}

async function ensureChannelAccess(ctx: any, forceRecheck = false): Promise<boolean> {
  if (!CHANNEL_USERNAME && !CHANNEL_ID) return true;

  const userId = normalizeUserId(ctx);
  if (!userId) return false;

  const usersFile = await loadUsers();
  const id = String(userId);
  const record = usersFile.users[id] ?? {
    userId,
    username: normalizeUsername(ctx),
    firstName: normalizeFirstName(ctx),
    lastSeenAt: new Date().toISOString(),
  };

  const today = getTodayKey();
  const alreadyCheckedToday = record.lastChannelCheckDate === today;
  const shouldReuseResult = alreadyCheckedToday && !forceRecheck && record.channelAccessGranted === true;
  if (shouldReuseResult) {
    usersFile.users[id] = {
      ...record,
      lastSeenAt: new Date().toISOString(),
    };
    await saveUsers(usersFile);
    return true;
  }

  const target = CHANNEL_ID || CHANNEL_USERNAME!;
  let allowed = false;
  try {
    const member = await ctx.telegram.getChatMember(target, userId);
    allowed = ['creator', 'administrator', 'member'].includes(member.status);
  } catch (err) {
    console.error('Channel membership check failed:', err);
    allowed = false;
  }

  usersFile.users[id] = {
    ...record,
    username: normalizeUsername(ctx),
    firstName: normalizeFirstName(ctx),
    lastSeenAt: new Date().toISOString(),
    lastChannelCheckDate: today,
    channelAccessGranted: allowed,
  };
  await saveUsers(usersFile);

  return allowed;
}

async function sendJoinPrompt(ctx: any) {
  const joinUrl = getChannelJoinUrl();
  const text = joinUrl
    ? 'You need to join the required channel before using the bot.'
    : 'You need to join the required channel before using the bot. Ask the admin for the join link.';
  const extra = channelJoinMarkup();
  await ctx.reply(text, extra);
}

async function enforceRateLimit(userId: number): Promise<{ allowed: boolean; remaining: number; resetAt?: number }> {
  const limits = await loadLimits();
  const key = String(userId);
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  const entry = limits.users[key] ?? { timestamps: [] };
  entry.timestamps = entry.timestamps.filter((ts) => ts >= cutoff);

  if (entry.timestamps.length >= MAX_REMOVALS_PER_HOUR) {
    limits.users[key] = entry;
    await saveLimits(limits);
    const oldest = Math.min(...entry.timestamps);
    return {
      allowed: false,
      remaining: 0,
      resetAt: oldest + 60 * 60 * 1000,
    };
  }

  entry.timestamps.push(now);
  limits.users[key] = entry;
  await saveLimits(limits);

  return {
    allowed: true,
    remaining: MAX_REMOVALS_PER_HOUR - entry.timestamps.length,
  };
}

async function isAdmin(ctx: any): Promise<boolean> {
  const userId = normalizeUserId(ctx);
  if (!userId) return false;
  if (ADMIN_ID && String(userId) === ADMIN_ID) return true;
  return false;
}

function formatUserLine(user: UserRecord): string {
  const name = user.username ? `@${user.username}` : (user.firstName ?? 'Unknown');
  return `${user.userId} — ${name}`;
}

bot.use(async (ctx, next) => {
  if (!ctx.message) {
    await next();
    return;
  }

  const userId = normalizeUserId(ctx);
  if (!userId) {
    await next();
    return;
  }

  await registerUser(ctx);

  const text = 'text' in ctx.message ? String(ctx.message.text ?? '') : '';
  if (text.startsWith('/users')) {
    await next();
    return;
  }

  const allowed = await ensureChannelAccess(ctx);
  if (!allowed) {
    await sendJoinPrompt(ctx);
    return;
  }

  await next();
});


bot.action('check_join', async (ctx) => {
  const userId = normalizeUserId(ctx);
  if (!userId) {
    await ctx.answerCbQuery('Could not verify your account.');
    return;
  }

  const allowed = await ensureChannelAccess(ctx, true);
  if (allowed) {
    await ctx.answerCbQuery('Membership confirmed.');
    const message = 'You are now verified. Send a photo, image document, or PDF.';
    if ('message' in ctx.callbackQuery && ctx.callbackQuery.message) {
      await ctx.editMessageText(message).catch(() => undefined);
    } else {
      await ctx.reply(message);
    }
    return;
  }

  await ctx.answerCbQuery('Still not joined yet.');
  await sendJoinPrompt(ctx);
});

bot.start(async (ctx) => {
  await ctx.reply([
    'Send me a photo, an image sent as a document, or a PDF.',
    'I will accept only those file types and send them back as documents.',
    'You must be subscribed to the required channel to use the bot.',
  ].join('\n'));
});

bot.help(async (ctx) => {
  await ctx.reply('Allowed uploads: photos, image documents, and PDF documents. Accepted files are re-sent as documents after processing.');
});

bot.command('users', async (ctx) => {
  if (!(await isAdmin(ctx))) {
    await ctx.reply('You are not allowed to use this command.');
    return;
  }

  const usersFile = await loadUsers();
  const users = Object.values(usersFile.users);
  const uniqueCount = users.length;
  const recent = users
    .slice()
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
    .slice(0, 20)
    .map(formatUserLine)
    .join('\n') || 'No users yet.';

  await ctx.reply([
    `Total unique users: ${uniqueCount}`,
    '',
    'Recent users:',
    recent,
  ].join('\n'));
});

bot.on('photo', async (ctx) => {
  const userId = normalizeUserId(ctx);
  if (!userId) return;

  const rate = await enforceRateLimit(userId);
  if (!rate.allowed) {
    const resetMessage = rate.resetAt ? ` Try again after ${new Date(rate.resetAt).toLocaleTimeString()}.` : '';
    await ctx.reply(`Rate limit reached. You can remove metadata ${MAX_REMOVALS_PER_HOUR} times per hour.${resetMessage}`);
    return;
  }

  const photos = ctx.message.photo;
  const best = photos[photos.length - 1];
  const caption = ctx.message.caption;

  try {
    const fileBuffer = await downloadTelegramFile(ctx, best.file_id);
    await processImageAndReply(ctx, fileBuffer, 'photo.jpg', 'image/jpeg', caption);
  } catch (err) {
    console.error('Photo processing failed:', err);
    await ctx.reply('Could not process that photo.');
  }
});

bot.on('document', async (ctx) => {
  const userId = normalizeUserId(ctx);
  if (!userId) return;

  const doc = ctx.message.document as TelegramFile;
  const caption = ctx.message.caption;

  if (!isAllowedDocument(doc)) {
    await ctx.reply('Only image documents and PDF documents are allowed.');
    return;
  }

  const rate = await enforceRateLimit(userId);
  if (!rate.allowed) {
    const resetMessage = rate.resetAt ? ` Try again after ${new Date(rate.resetAt).toLocaleTimeString()}.` : '';
    await ctx.reply(`Rate limit reached. You can remove metadata ${MAX_REMOVALS_PER_HOUR} times per hour.${resetMessage}`);
    return;
  }

  try {
    const fileBuffer = await downloadTelegramFile(ctx, doc.file_id);

    if (isPdfDocument(doc)) {
      await processPdfAndReply(ctx, fileBuffer, doc.file_name, caption);
      return;
    }

    await processImageAndReply(ctx, fileBuffer, doc.file_name, doc.mime_type, caption);
  } catch (err) {
    console.error('Document processing failed:', err);
    await ctx.reply('Could not process that file.');
  }
});

bot.launch().then(() => {
  console.log('Bot is running');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
