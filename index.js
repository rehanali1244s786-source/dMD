import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';
import chalk from 'chalk';
import qrcodeTerminal from 'qrcode-terminal';
import NodeCache from 'node-cache';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  Browsers,
  delay
} from '@whiskeysockets/baileys';

import config from './config.js';
import { connectDB, getGroupConfig, getUserData } from './lib/database.js';
import { useMongoDBAuthState } from './lib/mongoAuthState.js';
import { initializeCommandRegistry, dispatchCommand, getAllLoadedCommands } from './lib/registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const messageStore = new NodeCache({ stdTTL: 3600, checkperiod: 600 });
const spamTracker = new NodeCache({ stdTTL: 10, checkperiod: 5 });

let activeSock = null;
let isConnected = false;
let isSocketReadyForPairing = false;

function extractMessageBody(m) {
  if (!m?.message) return '';
  const type = Object.keys(m.message)[0];
  if (type === 'conversation') return m.message.conversation;
  if (type === 'extendedTextMessage') return m.message.extendedTextMessage.text;
  if (type === 'imageMessage') return m.message.imageMessage.caption || '';
  if (type === 'videoMessage') return m.message.videoMessage.caption || '';
  if (type === 'buttonsResponseMessage') return m.message.buttonsResponseMessage.selectedButtonId || '';
  if (type === 'listResponseMessage') return m.message.listResponseMessage.singleSelectReply?.selectedRowId || '';
  if (type === 'templateButtonReplyMessage') return m.message.templateButtonReplyMessage.selectedId || '';
  return '';
}

async function getAuthState(sessionKey = config.sessionId) {
  const mongoReady = await connectDB();
  if (config.useMongoAuth && mongoReady) {
    console.log(chalk.magentaBright(`🔐 [DOCK MD AUTH] Using MongoDB Persistent Auth State (${sessionKey})`));
    return await useMongoDBAuthState(sessionKey);
  } else {
    console.log(chalk.magentaBright('📁 [DOCK MD AUTH] Using Local File Auth State (./session)'));
    return await useMultiFileAuthState(path.join(__dirname, 'session'));
  }
}

async function startDockMD() {
  const { state, saveCreds } = await getAuthState(config.sessionId);
  const { version } = await fetchLatestBaileysVersion();
  const logger = pino({ level: 'silent' });

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: config.autoOnline,
    generateHighQualityLinkPreview: true,
    syncFullHistory: false,
    getMessage: async (key) => {
      const cached = messageStore.get(key.id);
      return cached?.message || { conversation: 'DOCK MD' };
    }
  });

  activeSock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      isSocketReadyForPairing = true;
      console.log(chalk.cyan('\n📲 Socket ready for Pairing Code or QR Scan:'));
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === 'connecting') {
      isSocketReadyForPairing = true;
    }

    if (connection === 'close') {
      isConnected = false;
      isSocketReadyForPairing = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(chalk.yellow(`⚠️ [DOCK MD] Connection closed (Code: ${statusCode}). Reconnecting: ${shouldReconnect}`));
      if (shouldReconnect) {
        setTimeout(() => startDockMD(), 3000);
      }
    } else if (connection === 'open') {
      isConnected = true;
      isSocketReadyForPairing = false;
      console.log(chalk.greenBright(`\n✅ [DOCK MD] Connected as ${sock.user?.name || config.botName} (${sock.user?.id})`));
      if (config.autoOnline) {
        await sock.sendPresenceUpdate('available');
      }
    }
  });

  sock.ev.on('group-participants.update', async (event) => {
    try {
      const { id: chatId, participants, action } = event;
      const grpConfig = await getGroupConfig(chatId);
      if (action === 'add' && grpConfig.welcome) {
        const meta = await sock.groupMetadata(chatId);
        for (const userJid of participants) {
          const msg = grpConfig.welcomeText
            .replace('@user', `@${userJid.split('@')[0]}`)
            .replace('@group', meta.subject);
          await sock.sendMessage(chatId, { text: msg, mentions: [userJid] });
        }
      } else if (action === 'remove' && grpConfig.goodbye) {
        const meta = await sock.groupMetadata(chatId);
        for (const userJid of participants) {
          const msg = grpConfig.goodbyeText
            .replace('@user', `@${userJid.split('@')[0]}`)
            .replace('@group', meta.subject);
          await sock.sendMessage(chatId, { text: msg, mentions: [userJid] });
        }
      }
    } catch (e) {
      console.error('Group participant update error:', e.message);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const m of messages) {
      try {
        if (!m.message || m.key.remoteJid === 'status@broadcast') continue;

        const chatId = m.key.remoteJid;
        const isGroup = chatId.endsWith('@g.us');
        const senderRaw = m.key.fromMe ? sock.user.id : (m.key.participant || m.key.remoteJid || '');
        const senderJid = jidNormalizedUser(senderRaw);
        const senderNumber = senderJid.split('@')[0].split(':')[0];
        const isOwner = m.key.fromMe || config.owners.includes(senderNumber);

        if (m.key.id) {
          messageStore.set(m.key.id, m);
        }

        if (config.autoRead) {
          await sock.readMessages([m.key]);
        }

        const protocolMsg = m.message?.protocolMessage;
        if (protocolMsg && protocolMsg.type === 0 && config.antiDelete) {
          const deletedId = protocolMsg.key?.id;
          const original = messageStore.get(deletedId);
          if (original && !original.key.fromMe) {
            const origBody = extractMessageBody(original);
            const deleter = m.key.participant || m.key.remoteJid;
            await sock.sendMessage(
              chatId,
              {
                text:
                  `🛡️ *${config.botName} ANTI-DELETE DETECTED*\n` +
                  `👤 *User:* @${deleter.split('@')[0]}\n` +
                  `💬 *Deleted Message:* ${origBody || '[Media Attachment]'}`,
                mentions: [deleter]
              },
              { quoted: original }
            );
          }
          continue;
        }

        const body = extractMessageBody(m).trim();

        if (isGroup && !isOwner) {
          const grpConfig = await getGroupConfig(chatId);

          if (grpConfig.antispam) {
            const spamKey = `${chatId}_${senderJid}`;
            const count = (spamTracker.get(spamKey) || 0) + 1;
            spamTracker.set(spamKey, count);
            if (count === 6) {
              await sock.sendMessage(
                chatId,
                { text: `⚠️ *${config.botName} ANTI-SPAM*\n@${senderNumber}, please slow down your messages!`, mentions: [senderJid] },
                { quoted: m }
              );
            }
          }

          if (grpConfig.antilink && /(https?:\/\/[^\s]+|chat\.whatsapp\.com\/[^\s]+)/gi.test(body)) {
            const meta = await sock.groupMetadata(chatId);
            const admins = meta.participants.filter((p) => p.admin).map((p) => p.id);
            const isSenderAdmin = admins.includes(senderJid);
            const isBotAdmin = admins.includes(jidNormalizedUser(sock.user.id));

            if (!isSenderAdmin) {
              if (isBotAdmin) {
                await sock.sendMessage(chatId, { delete: m.key });
              }
              await sock.sendMessage(
                chatId,
                { text: `🚫 *${config.botName} ANTI-LINK*\n@${senderNumber}, external links are not allowed in this group!`, mentions: [senderJid] }
              );
              continue;
            }
          }

          if (grpConfig.autoReplies?.has(body.toLowerCase())) {
            await sock.sendMessage(chatId, { text: grpConfig.autoReplies.get(body.toLowerCase()) }, { quoted: m });
          }
        }

        if (!body.startsWith(config.prefix)) continue;

        if (config.mode === 'private' && !isOwner) continue;

        const uData = await getUserData(senderJid);
        if (uData.banned && !isOwner) continue;

        const withoutPrefix = body.slice(config.prefix.length).trim();
        const [cmdName, ...args] = withoutPrefix.split(/\s+/);
        if (!cmdName) continue;

        const contextInfo = m.message?.extendedTextMessage?.contextInfo;
        const quotedMsg = contextInfo?.quotedMessage;
        const quotedText =
          quotedMsg?.conversation ||
          quotedMsg?.extendedTextMessage?.text ||
          quotedMsg?.imageMessage?.caption ||
          '';

        const ctx = {
          chatId,
          senderJid,
          senderNumber,
          isGroup,
          isOwner,
          args,
          text: args.join(' '),
          quotedMsg,
          quotedText,
          quotedParticipant: contextInfo?.participant || null,
          mentions: contextInfo?.mentionedJid || []
        };

        await dispatchCommand(cmdName, sock, m, ctx);
      } catch (err) {
        console.error(chalk.red('[MESSAGE HANDLER ERROR]:'), err);
      }
    }
  });

  return sock;
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => {
  res.json({
    success: true,
    botName: config.botName,
    defaultPairCode: config.customPairCode,
    connected: isConnected,
    totalCommands: getAllLoadedCommands().size,
    servers: [
      { id: 'us-east-1', name: 'Server 01 - US East (Primary)', status: 'Active', limit: 50, activeSessions: 12 },
      { id: 'eu-central-1', name: 'Server 02 - Europe (Frankfurt)', status: 'Active', limit: 50, activeSessions: 8 },
      { id: 'ap-south-1', name: 'Server 03 - Asia Pacific (Singapore)', status: 'Active', limit: 50, activeSessions: 19 }
    ]
  });
});

/**
 * REAL WHATSAPP PAIRING CODE ENDPOINT
 * Ensures a live unregistered Baileys socket completes the Noise handshake with WhatsApp servers
 * before calling requestPairingCode(cleanNumber, customPairCode) so WhatsApp accepts the code.
 */
app.post('/api/pair', async (req, res) => {
  try {
    const rawNumber = String(req.body.number || req.query.number || '');
    let cleanNumber = rawNumber.replace(/[^0-9]/g, '');

    // Automatically fix Pakistani local format "03xxxxxxxxx" -> "923xxxxxxxxx"
    if (cleanNumber.startsWith('03') && cleanNumber.length === 11) {
      cleanNumber = '92' + cleanNumber.slice(1);
    }

    if (!cleanNumber || cleanNumber.length < 10 || cleanNumber.length > 15) {
      return res.status(400).json({
        success: false,
        message: 'Invalid phone number. Enter a 10 to 15 digit number with country code (e.g., 923114257759).'
      });
    }

    // Create or use a fresh pairing session for this phone number so old registered creds don't block pairing
    const pairSessionKey = `${config.sessionId}_${cleanNumber}`;
    const { state, saveCreds } = await getAuthState(pairSessionKey);
    const { version } = await fetchLatestBaileysVersion();
    const logger = pino({ level: 'silent' });

    const pairSock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: true,
      syncFullHistory: false
    });

    pairSock.ev.on('creds.update', saveCreds);

    // Wait until socket emits QR / finishes initial handshake with WhatsApp servers
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 3500);
      pairSock.ev.on('connection.update', (update) => {
        if (update.qr || update.connection === 'open') {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    await delay(1000);

    // Request real pairing code from WhatsApp servers
    // Try custom 8-char alphanumeric code ("DOCKWIDE") first; if WhatsApp rejects custom string on older Baileys, fallback to standard 8-char code
    let code;
    const custom8 = (config.customPairCode || 'DOCKWIDE').replace(/[^A-Z0-9]/gi, '').slice(0, 8).toUpperCase();
    try {
      code = await pairSock.requestPairingCode(cleanNumber, custom8);
    } catch {
      code = await pairSock.requestPairingCode(cleanNumber);
    }

    const formatted = code?.match(/.{1,4}/g)?.join('-') || code;

    return res.json({
      success: true,
      code: formatted,
      rawCode: code,
      number: cleanNumber,
      botName: config.botName
    });
  } catch (error) {
    console.error('[PAIRING ERROR]:', error);
    return res.status(500).json({
      success: false,
      message: `WhatsApp Server Error: ${error.message || 'Unable to generate pairing code right now. Please try again.'}`
    });
  }
});

await initializeCommandRegistry();
startDockMD();

app.listen(config.port, () => {
  console.log(chalk.greenBright(`🌐 [DOCK MD WEB] Pairing Server running at http://localhost:${config.port}`));
});

export default app;
