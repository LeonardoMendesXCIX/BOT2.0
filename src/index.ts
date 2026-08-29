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

process.env.TZ = 'America/Sao_Paulo';
const TIMEZONE = 'America/Sao_Paulo';

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

startWebServer(() => sockInstance, storage, parseInt(process.env.WEB_PORT || '3000', 10));

// NOVO: HH:MM confiável no Windows (não depende do fuso do PC)
function getHHMM(): string {
    try {
        return new Intl.DateTimeFormat('pt-BR', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
    } catch (e) {
        const d = new Date();
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }
}

// NOVO: janela abertura→fechamento (suporta virada de madrugada)
function isWithinWindow(open?: string, close?: string, nowHHMM?: string): boolean {
    const now = nowHHMM || getHHMM();
    if (!open) return false;
    if (!close) return now >= open;
    if (open <= close) return now >= open && now < close;
    return now >= open || now < close;
}

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

// =====================================================================
// CRON ABERTURA/FECHAMENTO — CORRIGIDO
// (antes: grupos fechados eram pulados e NUNCA abriam de novo)
// =====================================================================
cron.schedule('* * * * *', async () => {
    if (!sockInstance) return;
    const currentHHMM = getHHMM();

    if (storage.data.groupSchedules) {
        for (const chatId in storage.data.groupSchedules) {
            // CORRIGIDO: só pula se o bot está desligado no grupo.
            // Grupo FECHADO precisa continuar sendo verificado para poder ABRIR.
            if (storage.isBotDisabled(chatId)) continue;
            const sched = storage.data.groupSchedules[chatId];
            if (!sched) continue;
            if (storage.isFeatureDisabled(chatId, 'fechar_abrir')) continue;

            if (sched.openTime === currentHHMM) {
                try {
                    await sockInstance.groupSettingUpdate(chatId, 'not_announcement');
                    storage.setGroupClosed(chatId, false);
                    await sockInstance.sendMessage(chatId, {
                        text: '🔓 *BOM DIA! PROTOCOLO JARVIS DE ABERTURA:*\n\nO chat foi liberado para todos os membros conversarem conforme o horário programado (' + sched.openTime + ').'
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
                        text: '🔒 *BOA NOITE! PROTOCOLO JARVIS DE FECHAMENTO:*\n\nO chat foi fechado para descanso/manutenção conforme o horário programado (' + sched.closeTime + '). Apenas administradores podem enviar mensagens neste momento.'
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

// NOVO: ao (re)conectar, recupera horários perdidos enquanto o bot esteve offline
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
    const needPairing = !state.creds.registered;

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        syncFullHistory: false,
        browser: ['JARVIS AUTONOMOUS', 'Chrome', '2.5.0'],
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

    // NOVO: conexão por NÚMERO DE TELEFONE (código de pareamento) — mais estável que QR
    if (needPairing) {
        setTimeout(async () => {
            try {
                const phone = (process.env.PHONE_NUMBER || '5511927018683').replace(/\D/g, '');
                let code = await sock.requestPairingCode(phone);
                if (code) {
                    code = (code.match(/.{1,4}/g) || [code]).join('-');
                    console.log('\n[SISTEMA] 🔑 CÓDIGO DE PAREAMENTO: ' + code);
                    console.log('[SISTEMA] No celular: Configurações > Aparelhos conectados > Conectar aparelho > usar código de pareamento');
                }
            } catch (e: any) {
                console.error('[ERRO PAREAMENTO]', e.message);
            }
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr && !needPairing) {
            qrcode.generate(qr, { small: true });
            console.log('\n[SISTEMA] Escaneie o QR Code acima com seu WhatsApp.');
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error as any)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('[SISTEMA] Conexão fechada. Reconectando em ' + (reconnectDelay / 1000) + 's...', shouldReconnect);
            if (shouldReconnect) {
                setTimeout(() => startBot(), reconnectDelay);
                reconnectDelay = Math.min(reconnectDelay * 2, 60000);
            }
        } else if (connection === 'open') {
            reconnectDelay = 3000;
            console.log('[SISTEMA] JARVIS BOT2.0 conectado com sucesso!');
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
        if (!storage.data.pendingPresentations || storage.data.pendingPresentations.length === 0) return;

        const now = Date.now();
        const remaining: any[] = [];

        for (const item of storage.data.pendingPresentations) {
            if (now >= item.deadline) {
                try {
                    const chatId = item.chatId;
                    if (storage.isBotDisabled(chatId) || storage.isGroupClosed(chatId)) continue;

                    const isAntiGhostActive = !storage.isFeatureDisabled(chatId, 'antighost') && storage.data.antighost[chatId] !== false;

                    if (isAntiGhostActive) {
                        const groupMeta = await sock.groupMetadata(chatId).catch(() => null);
                        const isStillInGroup = groupMeta?.participants?.some(p => p.id === item.memberId || checkMatch(p.id.split('@')[0], item.memberNum));

                        if (isStillInGroup) {
                            await sock.groupParticipantsUpdate(chatId, [item.memberId], 'remove');
                            await sock.sendMessage(chatId, {
                                text: '👻 *JARVIS SECURITY (ANTI-GHOST):*\n\n' +
                                    '👤 *Membro:* *' + item.memberName + '* - +' + item.memberNum + '\n' +
                                    '⏰ *Motivo:* Não enviou mensagem de apresentação no prazo de 10 minutos após entrar no grupo.\n\n' +
                                    '_O grupo mantém apenas integrantes participativos._',
                                mentions: [item.memberId]
                            });
                            console.log('[ANTI-GHOST] Membro ' + item.memberName + ' removido.');
                        }
                    }
                } catch (e: any) {
                    console.error('[ERRO AUTO KICK ANTI-GHOST]', e.message);
                }
            } else {
                remaining.push(item);
            }
        }

        if (remaining.length !== storage.data.pendingPresentations.length) {
            storage.data.pendingPresentations = remaining;
            storage.flagSave();
        }
    }, 30000);

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
                        await sock.sendMessage(chatId, { text: '📢 @todos @all\n\n🤖 *Jarvis:* ' + funny });
                    } catch (e: any) {
                        console.error('[ERRO AUTO ANIM]', e.message);
                    }
                }
            }
        }
    }, 60000);
}

startBot();