import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import cron from 'node-cron';
import { StorageManager } from './database/storage';
import { handleCommand } from './handlers/commands';
import { setupGroupEvents } from './handlers/events';
import { getUserInfo, extractRawNumber } from './utils/user';
import { checkMatch } from './config/rbac';
import { startWebServer } from './services/webServer';
import { getFunnyMessage } from './services/funnyMessages';
import { getHHMM, isWithinWindow } from './utils/time';

process.env.TZ = 'America/Sao_Paulo';
const TIMEZONE = 'America/Sao_Paulo';
const CREATOR_JID = '5511927018683@s.whatsapp.net';

const originalConsoleError = console.error;
console.error = (...args: any[]) => {
    const msg = args.map(a => a?.message || a?.toString() || '').join(' ');
    if (msg.includes('MessageCounterError') || msg.includes('Failed to decrypt') || msg.includes('Bad MAC')) {
        return;
    }
    originalConsoleError(...args);
};

process.on('unhandledRejection', (reason: any) => {
    const errStr = reason?.message || reason?.toString() || '';
    if (errStr.includes('Bad MAC') || errStr.includes('MessageCounterError') || errStr.includes('Failed to decrypt')) {
        return;
    }
    console.log('[SISTEMA] Rejeição assíncrona interceptada:', reason?.message || reason);
});

process.on('uncaughtException', (error: any) => {
    const errStr = error?.message || error?.toString() || '';
    if (errStr.includes('Bad MAC') || errStr.includes('MessageCounterError') || errStr.includes('Failed to decrypt')) {
        return;
    }
    console.log('[ERRO CRÍTICO] Exceção não tratada:', error?.message || error);
});

const storage = new StorageManager();
let sockInstance: any = null;
let reconnectDelay = 3000;
let lastDisconnectAt = 0;
let downStartStr = '';
let watchdogNotified = false;

startWebServer(() => sockInstance, storage, parseInt(process.env.WEB_PORT || '3000', 10));

process.on('SIGINT', () => {
    console.log('\n[SISTEMA] Encerrando... salvando dados.');
    storage.shutdown();
    process.exit(0);
});
process.on('SIGTERM', () => {
    storage.shutdown();
    process.exit(0);
});

cron.schedule('0 3 * * *', () => {
    storage.pruneStorage();
}, { timezone: TIMEZONE });

cron.schedule('0 * * * *', async () => {
    if (!storage.data.scheduledMsgs || storage.data.scheduledMsgs.length === 0) return;
    const now = new Date();
    const currentHour = now.getHours();
    const dateStr = now.toLocaleDateString('pt-BR');

    let modified = false;
    for (let i = 0; i < storage.data.scheduledMsgs.length; i++) {
        const sched = storage.data.scheduledMsgs[i];
        if (storage.isBotDisabled(sched.chatId) || storage.isFeatureDisabled(sched.chatId, 'ma')) continue;

        if (sched.hours.includes(currentHour)) {
            if (!sched.lastSent) sched.lastSent = {};
            const sentKey = dateStr + '-' + currentHour;

            if (!sched.lastSent[sentKey]) {
                try {
                    await sockInstance?.sendMessage(sched.chatId, { text: sched.text });
                    sched.lastSent[sentKey] = true;
                    modified = true;
                } catch (e: any) {
                    console.error('[ERRO AUTO MSG CRON]', e.message);
                }
            }
        }
    }
    if (modified) storage.flagSave();
}, { timezone: TIMEZONE });

cron.schedule('* * * * *', async () => {
    if (!sockInstance) return;
    const currentHHMM = getHHMM();

    if (storage.data.groupSchedules) {
        for (const chatId in storage.data.groupSchedules) {
            if (storage.isBotDisabled(chatId)) continue;
            const sched = storage.data.groupSchedules[chatId];
            if (!sched) continue;
            if (storage.isFeatureDisabled(chatId, 'fechar_abrir')) continue;

            if (sched.openTime === currentHHMM) {
                try {
                    await sockInstance.groupSettingUpdate(chatId, 'not_announcement');
                    storage.setGroupClosed(chatId, false);
                    await sockInstance.sendMessage(chatId, {
                        text: '🔓 *BOM DIA! PROTOCOLO BOT DROPHTTP DE ABERTURA:*\n\nO chat foi liberado para todos os membros conversarem conforme o horário programado (' + sched.openTime + ').'
                    });
                    console.log('[AGENDA] Grupo ' + chatId + ' aberto às ' + currentHHMM);
                } catch (e: any) {
                    console.error('[ERRO AUTO ABRIR GRUPO]', e.message);
                }
            }

            if (sched.closeTime === currentHHMM) {
                try {
                    await sockInstance.groupSettingUpdate(chatId, 'announcement');
                    storage.setGroupClosed(chatId, true);
                    await sockInstance.sendMessage(chatId, {
                        text: '🔒 *BOA NOITE! PROTOCOLO BOT DROPHTTP DE FECHAMENTO:*\n\nO chat foi fechado para descanso/manutenção conforme o horário programado (' + sched.closeTime + '). Apenas administradores podem enviar mensagens neste momento.'
                    });
                    console.log('[AGENDA] Grupo ' + chatId + ' fechado às ' + currentHHMM);
                } catch (e: any) {
                    console.error('[ERRO AUTO FECHAR GRUPO]', e.message);
                }
            }
        }
    }

    if (storage.data.promoSchedule) {
        for (const chatId in storage.data.promoSchedule) {
            if (storage.isBotDisabled(chatId) || storage.isFeatureDisabled(chatId, 'divulga')) continue;
            const promo = storage.data.promoSchedule[chatId];
            if (!promo || !promo.active) continue;

            if (promo.startTime === currentHHMM) {
                try {
                    await sockInstance.sendMessage(chatId, {
                        text: '📢 *HORÁRIO DE DIVULGAÇÕES ABERTO!* (' + promo.startTime + ' às ' + promo.endTime + ')\n\n' + promo.content + '\n\n🛡️ *Atenção:* O envio de links está liberado para todos os membros durante este período sem risco de remoção!'
                    });
                } catch (e: any) { }
            }

            if (promo.endTime === currentHHMM) {
                try {
                    await sockInstance.sendMessage(chatId, {
                        text: '🔒 *HORÁRIO DE DIVULGAÇÕES ENCERRADO!*\n\n_O Anti-Link voltou a operar normalmente com expulsão automática para quem enviar links._'
                    });
                } catch (e: any) { }
            }
        }
    }
}, { timezone: TIMEZONE });

cron.schedule('*/5 * * * *', () => {
    storage.purgeExpiredClusters();
});

// NOVO: ANTIFAKE AUTOMÁTICO — varredura a cada 2 MINUTOS em todos os grupos que o bot é admin
setInterval(async () => {
    if (!sockInstance) return;
    const groupSet = new Set<string>([
        ...Object.keys(storage.data.groupStats || {}),
        ...Object.keys(storage.data.antifake || {}),
        ...Object.keys(storage.data.antilink || {})
    ]);
    for (const chatId of groupSet) {
        try {
            if (storage.isBotDisabled(chatId)) continue;
            const antifakeOn = storage.data.antifake?.[chatId] === true || (!storage.isFeatureDisabled(chatId, 'antifake') && storage.data.antifake?.[chatId] !== false);
            if (!antifakeOn) continue;

            const meta = await sockInstance.groupMetadata(chatId).catch(() => null);
            if (!meta) continue;

            const botJid = sockInstance.user?.id || '';
            const me = meta.participants.find(p => p.id === botJid);
            if (!me || !(me.admin === 'admin' || me.admin === 'superadmin')) continue;

            for (const p of meta.participants) {
                if (p.admin === 'admin' || p.admin === 'superadmin') continue;
                const num = extractRawNumber(p.id);
                const isBr = num.startsWith('55') && (num.length === 12 || num.length === 13);
                if (!isBr && num.length <= 15 && num.length >= 8) {
                    await sockInstance.groupParticipantsUpdate(chatId, [p.id], 'remove').catch(() => { });
                    console.log('[ANTIFAKE AUTO] Removido +' + num + ' do grupo ' + chatId);
                }
            }
        } catch (e) { }
    }
}, 2 * 60 * 1000);

setInterval(() => {
    if (lastDisconnectAt > 0) {
        const downMs = Date.now() - lastDisconnectAt;
        if (downMs >= 5 * 60 * 1000 && !watchdogNotified) {
            watchdogNotified = true;
            console.log('[WATCHDOG] ⚠️ Bot fora do ar há mais de 5 minutos (desde ' + downStartStr + '). O criador será notificado no privado assim que reconectar.');
        }
    }
}, 60000);

async function syncSchedulesOnBoot(sock: any) {
    try {
        if (!storage.data.groupSchedules) return;
        const currentHHMM = getHHMM();
        for (const chatId in storage.data.groupSchedules) {
            const sched = storage.data.groupSchedules[chatId];
            if (!sched || storage.isBotDisabled(chatId) || storage.isFeatureDisabled(chatId, 'fechar_abrir')) continue;
            const shouldOpen = isWithinWindow(sched.openTime, sched.closeTime, currentHHMM);
            const meta = await sock.groupMetadata(chatId).catch(() => null);
            if (!meta) continue;
            const isAnnouncement = meta.announce === true;
            if (shouldOpen && isAnnouncement) {
                await sock.groupSettingUpdate(chatId, 'not_announcement');
                storage.setGroupClosed(chatId, false);
                console.log('[AGENDA BOOT] Grupo ' + chatId + ' deveria estar ABERTO → aberto.');
            } else if (!shouldOpen && !isAnnouncement && sched.closeTime) {
                await sock.groupSettingUpdate(chatId, 'announcement');
                storage.setGroupClosed(chatId, true);
                console.log('[AGENDA BOOT] Grupo ' + chatId + ' deveria estar FECHADO → fechado.');
            }
        }
    } catch (e: any) {
        console.error('[ERRO AGENDA BOOT]', e.message);
    }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./sessions');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        syncFullHistory: false,
        browser: ['BOT DROPHTTP', 'Chrome', '2.5.0'],
        getMessage: async (key) => {
            const msgId = key.id;
            const chatId = key.remoteJid;
            if (chatId && msgId && storage.data.messageBuffer?.[chatId]?.[msgId]) {
                return { conversation: storage.data.messageBuffer[chatId][msgId].text };
            }
            return undefined;
        }
    });

    sockInstance = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrcode.generate(qr, { small: true });
            console.log('\n[SISTEMA] Escaneie o QR Code acima com seu WhatsApp.');
        }

        if (connection === 'close') {
            if (!lastDisconnectAt) {
                lastDisconnectAt = Date.now();
                downStartStr = getHHMM();
            }
            const shouldReconnect = (lastDisconnect?.error as any)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('[SISTEMA] Conexão fechada. Reconectando em ' + (reconnectDelay / 1000) + 's...', shouldReconnect);
            if (shouldReconnect) {
                setTimeout(() => startBot(), reconnectDelay);
                reconnectDelay = Math.min(reconnectDelay * 2, 60000);
            } else {
                console.log('[SISTEMA] ⚠️ Desconectado permanentemente. Apague a pasta ./sessions e reinicie para escanear o QR novamente.');
            }
        } else if (connection === 'open') {
            reconnectDelay = 3000;
            console.log('[SISTEMA] 🎉 BOT DROPHTTP conectado com sucesso!');
            if (storage.data.maintenance) {
                console.log('[SISTEMA] ⚠️ Bot em MODO MANUTENÇÃO. Use !botmanutencao off para voltar.');
            }

            if (lastDisconnectAt > 0) {
                const downMs = Date.now() - lastDisconnectAt;
                lastDisconnectAt = 0;
                if (downMs >= 5 * 60 * 1000 || watchdogNotified) {
                    const downMin = Math.max(1, Math.round(downMs / 60000));
                    try {
                        sock.sendMessage(CREATOR_JID, {
                            text: '🟢 *BOT DROPHTTP VOLTOU ONLINE*\n\n' +
                                '⚠️ Fiquei fora do ar por cerca de *' + downMin + ' min*.\n' +
                                '🕒 Queda às ' + downStartStr + ' → retorno às ' + getHHMM() + '.\n\n' +
                                '_Se isso se repetir, verifique se o PC/servidor está ligado e com internet._'
                        });
                    } catch (e) { }
                }
                watchdogNotified = false;
            }

            syncSchedulesOnBoot(sock);
        }
    });

    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update?.messageStubType === 1 || (update.update as any)?.message === null) {
                const chatId = update.key.remoteJid || '';
                const msgId = update.key.id || '';

                if (chatId.endsWith('@g.us') && !storage.isBotDisabled(chatId) && !storage.isFeatureDisabled(chatId, 'antidelete') && storage.data.antidelete?.[chatId] !== false) {
                    const buffered = storage.data.messageBuffer?.[chatId]?.[msgId];
                    if (buffered && (Date.now() - buffered.timestamp < 15 * 60 * 1000)) {
                        const authorInfo = getUserInfo(buffered.sender);
                        const deletedMsg = '🗑️ *ANTI-DELETE (MENSAGEM APAGADA DETECTADA)* 🗑️\n\n' +
                            '👤 *Autor:* ' + authorInfo.nameAndNumber + '\n' +
                            '💬 *Conteúdo Apagado:*\n"' + buffered.text + '"';

                        await sock.sendMessage(chatId, { text: deletedMsg, mentions: [authorInfo.jid] });
                        delete storage.data.messageBuffer[chatId][msgId];
                        storage.flagSave();
                    }
                }
            }
        }
    });

    setupGroupEvents(sock, storage);

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
            if (!msg.message || msg.key.fromMe || !msg.key.remoteJid) continue;

            const rawTs: any = (msg as any).messageTimestamp;
            const tsSec = typeof rawTs === 'number' ? rawTs : (rawTs?.low ?? rawTs?.toNumber?.() ?? 0);
            const msgTime = Number(tsSec) * 1000;
            if (msgTime && Date.now() - msgTime > 10 * 60 * 1000) continue;

            try {
                await handleCommand(sock, msg, storage);
            } catch (err: any) {
                console.error('[ERRO PROCESSANDO MENSAGEM]', err.message);
            }
        }
    });

    setInterval(async () => {
        if (!storage.data.pendingBvReminders || storage.data.pendingBvReminders.length === 0) return;

        const now = Date.now();
        const remaining: Array<{ id: string; chatId: string; newMemberId: string; runAt: number }> = [];

        for (const reminder of storage.data.pendingBvReminders) {
            if (now >= reminder.runAt) {
                try {
                    const chatId = reminder.chatId;
                    if (storage.isBotDisabled(chatId) || storage.isFeatureDisabled(chatId, 'bv')) continue;

                    const bvConfig = storage.data.welcomeReminders ? storage.data.welcomeReminders[chatId] : null;

                    if (bvConfig && bvConfig.text) {
                        const groupMeta = await sockInstance?.groupMetadata(chatId).catch(() => null);
                        if (!groupMeta || !groupMeta.participants) {
                            remaining.push(reminder);
                            continue;
                        }

                        const rawMemberNum = extractRawNumber(reminder.newMemberId);
                        const isStillInGroup = groupMeta.participants.some((p: any) =>
                            p.id === reminder.newMemberId ||
                            p.lid === reminder.newMemberId ||
                            (p.id && checkMatch(p.id.split('@')[0], rawMemberNum)) ||
                            (p.lid && checkMatch(p.lid.split('@')[0], rawMemberNum))
                        );

                        if (!isStillInGroup) {
                            console.log('[LEMBRETE BV CANCELADO] O membro +' + rawMemberNum + ' não está mais no grupo ' + chatId + '.');
                            continue;
                        }

                        const memberInfo = getUserInfo(reminder.newMemberId);
                        let userText = bvConfig.text.trim();

                        if (userText.includes('{membro}')) {
                            userText = userText.replace(/\{membro\}/gi, memberInfo.nameAndNumber);
                        } else if (userText.includes('{nome}')) {
                            userText = userText.replace(/\{nome\}/gi, memberInfo.pushName || memberInfo.formattedNum);
                        } else if (userText.includes('{numero}')) {
                            userText = userText.replace(/\{numero\}/gi, memberInfo.formattedNum);
                        } else {
                            userText = '👋 ' + memberInfo.nameAndNumber + '\n\n' + userText;
                        }

                        const fullText = '📢 @todos @all\n\n' + userText;
                        const allMentions = Array.from(new Set([memberInfo.jid, reminder.newMemberId])).filter(Boolean);

                        await sockInstance?.sendMessage(chatId, { text: fullText, mentions: allMentions });
                        console.log('[LEMBRETE BV ENVIADO] Lembrete disparado para ' + memberInfo.nameAndNumber + ' no grupo ' + chatId);
                    }
                } catch (e: any) {
                    console.error('[ERRO LEMBRETE BV]', e.message);
                }
            } else {
                remaining.push(reminder);
            }
        }

        if (remaining.length !== storage.data.pendingBvReminders.length) {
            storage.data.pendingBvReminders = remaining;
            storage.flagSave();
        }
    }, 30000);

    setInterval(async () => {
        if (!storage.data.autoAnim) return;

        const now = Date.now();
        const INACTIVITY_LIMIT = 30 * 60 * 1000;

        for (const chatId in storage.data.autoAnim) {
            if (storage.isBotDisabled(chatId) || storage.isGroupClosed(chatId)) continue;
            if (storage.data.autoAnim[chatId] === true && !storage.isFeatureDisabled(chatId, 'auto')) {
                const lastActive = storage.data.lastGroupActivity[chatId] || 0;
                const alreadySent = storage.data.autoAnimSent[chatId] || false;

                if (lastActive > 0 && (now - lastActive >= INACTIVITY_LIMIT) && !alreadySent) {
                    try {
                        storage.data.autoAnimSent[chatId] = true;
                        storage.flagSave();

                        const funny = getFunnyMessage(storage);
                        await sock.sendMessage(chatId, { text: '📢 @todos @all\n\n🤖 *BOT DROPHTTP:* ' + funny });
                    } catch (e: any) {
                        console.error('[ERRO AUTO ANIM]', e.message);
                    }
                }
            }
        }
    }, 60000);
}

startBot();