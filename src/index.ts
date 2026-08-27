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
import { callAI } from './services/ai';
import { getUserInfo, extractRawNumber } from './utils/user';
import { checkMatch } from './config/rbac';

process.env.TZ = 'America/Sao_Paulo';

// Suprime dumps repetitivos de criptografia do libsignal no terminal
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

// Cron 1: Mensagens Automáticas Programadas (!ma) a cada hora
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
            const sentKey = `${dateStr}-${currentHour}`;

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
}, { timezone: "America/Sao_Paulo" });

// Cron 2: Agendador Diário de Abertura/Fechamento & Divulgações Programadas
cron.schedule('* * * * *', async () => {
    if (!sockInstance) return;
    const now = new Date();
    const currentHHMM = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false });

    // A. Abertura / Fechamento de Grupos
    if (storage.data.groupSchedules) {
        for (const chatId in storage.data.groupSchedules) {
            if (storage.isBotDisabled(chatId) || storage.isGroupClosed(chatId)) continue;
            const sched = storage.data.groupSchedules[chatId];
            if (!sched) continue;

            if (sched.openTime === currentHHMM && !storage.isFeatureDisabled(chatId, 'fechar_abrir')) {
                try {
                    await sockInstance.groupSettingUpdate(chatId, 'not_announcement');
                    storage.setGroupClosed(chatId, false);
                    await sockInstance.sendMessage(chatId, {
                        text: `🔓 *BOM DIA! PROTOCOLO JARVIS DE ABERTURA:*

O chat foi liberado para todos os membros conversarem conforme o horário programado (${sched.openTime}).`
                    });
                    console.log(`[HORÁRIO AUTOMÁTICO] Grupo ${chatId} aberto às ${currentHHMM}`);
                } catch (e: any) {
                    console.error('[ERRO AUTO ABRIR GRUPO]', e.message);
                }
            }

            if (sched.closeTime === currentHHMM && !storage.isFeatureDisabled(chatId, 'fechar_abrir')) {
                try {
                    await sockInstance.groupSettingUpdate(chatId, 'announcement');
                    storage.setGroupClosed(chatId, true);
                    await sockInstance.sendMessage(chatId, {
                        text: `🔒 *BOA NOITE! PROTOCOLO JARVIS DE FECHAMENTO:*

O chat foi fechado para descanso/manutenção conforme o horário programado (${sched.closeTime}). Apenas administradores podem enviar mensagens neste momento.`
                    });
                    console.log(`[HORÁRIO AUTOMÁTICO] Grupo ${chatId} fechado às ${currentHHMM}`);
                } catch (e: any) {
                    console.error('[ERRO AUTO FECHAR GRUPO]', e.message);
                }
            }
        }
    }

    // B. Divulgações Programadas (!divulga)
    if (storage.data.promoSchedule) {
        for (const chatId in storage.data.promoSchedule) {
            if (storage.isBotDisabled(chatId) || storage.isFeatureDisabled(chatId, 'divulga')) continue;
            const promo = storage.data.promoSchedule[chatId];
            if (!promo || !promo.active) continue;

            // Início do Horário de Divulgação
            if (promo.startTime === currentHHMM) {
                try {
                    await sockInstance.sendMessage(chatId, {
                        text: `📢 *HORÁRIO DE DIVULGAÇÕES ABERTO!* (${promo.startTime} às ${promo.endTime})\n\n${promo.content}\n\n🛡️ *Atenção:* O envio de links está liberado para todos os membros durante este período sem risco de remoção!`
                    });
                } catch (e: any) {}
            }

            // Fim do Horário de Divulgação
            if (promo.endTime === currentHHMM) {
                try {
                    await sockInstance.sendMessage(chatId, {
                        text: `🔒 *HORÁRIO DE DIVULGAÇÕES ENCERRADO!*\n\n_O Anti-Link voltou a operar normalmente com expulsão automática para quem enviar links._`
                    });
                } catch (e: any) {}
            }
        }
    }
}, { timezone: "America/Sao_Paulo" });

// Cron 3: Limpeza e Purga Contínua dos Clusters de Memória (> 30 Minutos)
cron.schedule('*/5 * * * *', () => {
    storage.purgeExpiredClusters();
});

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./sessions');
    const { version } = await fetchLatestBaileysVersion();

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

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrcode.generate(qr, { small: true });
            console.log('\n[SISTEMA] Escaneie o QR Code acima com seu WhatsApp.');
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error as any)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('[SISTEMA] Conexão fechada. Reconectando em 3 segundos...', shouldReconnect);
            if (shouldReconnect) {
                setTimeout(() => startBot(), 3000);
            }
        } else if (connection === 'open') {
            console.log('[SISTEMA] JARVIS BOT2.0 conectado com sucesso!');
        }
    });

    // Listener Anti-Delete (Detecção de Mensagens Apagadas no Grupo)
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update?.messageStubType === 1 || (update.update as any)?.message === null) {
                const chatId = update.key.remoteJid || '';
                const msgId = update.key.id || '';

                if (chatId.endsWith('@g.us') && !storage.isBotDisabled(chatId) && !storage.isFeatureDisabled(chatId, 'antidelete') && storage.data.antidelete?.[chatId] !== false) {
                    const buffered = storage.data.messageBuffer?.[chatId]?.[msgId];
                    if (buffered && (Date.now() - buffered.timestamp < 15 * 60 * 1000)) {
                        const authorInfo = getUserInfo(buffered.sender);
                        const deletedMsg = `🗑️ *ANTI-DELETE (MENSAGEM APAGADA DETECTADA)* 🗑️\n\n` +
                                          `👤 *Autor:* ${authorInfo.nameAndNumber}\n` +
                                          `💬 *Conteúdo Apagado:*\n"${buffered.text}"`;

                        await sock.sendMessage(chatId, { text: deletedMsg, mentions: [authorInfo.jid] });
                        delete storage.data.messageBuffer[chatId][msgId];
                        storage.flagSave();
                    }
                }
            }
        }
    });

    setupGroupEvents(sock, storage);

    // =====================================================================
    // CORREÇÃO APLICADA AQUI (Filtro Anti-Loop Infinito)
    // =====================================================================
    sock.ev.on('messages.upsert', async (m) => {
        for (const msg of m.messages) {
            // Ignora mensagens enviadas pelo próprio bot (fromMe) para evitar o loop infinito
            // e ignora mensagens vazias (notificações de sistema/status).
            if (msg.key.fromMe || !msg.message) continue;

            try {
                await handleCommand(sock, msg, storage);
            } catch (err: any) {
                console.error('[ERRO PROCESSANDO MENSAGEM]', err.message);
            }
        }
    });

    // Verificador 1: Sistema Anti-Ghost (10 minutos para apresentação)
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
                                text: `👻 *JARVIS SECURITY (ANTI-GHOST):*\n\n` +
                                      `👤 *Membro:* @${item.memberNum} (*${item.memberName}*)\n` +
                                      `⏰ *Motivo:* Não enviou mensagem de apresentação no prazo de 10 minutos após entrar no grupo.\n\n` +
                                      `_O grupo mantém apenas integrantes participativos._`,
                                mentions: [item.memberId]
                            });
                            console.log(`[ANTI-GHOST] Membro @${item.memberNum} removido.`);
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

    // Verificador 2: Lembrete de Boas-Vindas (!bv - 15 minutos com Verificação de Permanência)
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
                            console.log(`[LEMBRETE BV CANCELADO] O membro +${rawMemberNum} não está mais no grupo ${chatId}.`);
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
                            userText = `👋 ${memberInfo.nameAndNumber}\n\n${userText}`;
                        }

                        const fullText = `📢 @todos @all\n\n${userText}`;
                        const allMentions = Array.from(new Set([memberInfo.jid, reminder.newMemberId])).filter(Boolean);

                        await sockInstance?.sendMessage(chatId, { text: fullText, mentions: allMentions });
                        console.log(`[LEMBRETE BV ENVIADO] Lembrete disparado para ${memberInfo.nameAndNumber} no grupo ${chatId}`);
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

    // Verificador 3: Inatividade de 20 Minutos com Intervenção Contextual Jarvis
    setInterval(async () => {
        if (!storage.data.autoAnim) return;

        const now = Date.now();
        const INACTIVITY_LIMIT = 20 * 60 * 1000;

        for (const chatId in storage.data.autoAnim) {
            if (storage.isBotDisabled(chatId) || storage.isGroupClosed(chatId)) continue;
            if (storage.data.autoAnim[chatId] === true && !storage.isFeatureDisabled(chatId, 'auto')) {
                const lastActive = storage.data.lastGroupActivity[chatId] || 0;
                const alreadySent = storage.data.autoAnimSent[chatId] || false;

                if (lastActive > 0 && (now - lastActive >= INACTIVITY_LIMIT) && !alreadySent) {
                    try {
                        storage.data.autoAnimSent[chatId] = true;
                        storage.flagSave();

                        const cluster = storage.data.memoryCluster?.[chatId] || [];
                        const clusterStrings = cluster.map(m => `${m.authorName} (+${m.authorNum}): ${m.text}`);

                        const promptAnim = 
                            `O grupo ficou completamente em silêncio por mais de 20 minutos.\n` +
                            `Como Jarvis, faça uma intervenção curta, perspicaz, elegante ou descontraída para reativar as conversas no grupo.\n` +
                            `Regra: Máximo 2 a 3 linhas com emojis.`;

                        const aiAnim = await callAI(promptAnim, clusterStrings);
                        await sock.sendMessage(chatId, { text: `📢 @todos @all\n\n🤖 *Jarvis:* ${aiAnim}` });
                    } catch (e: any) {
                        console.error('[ERRO AUTO ANIM]', e.message);
                    }
                }
            }
        }
    }, 60000);
}

startBot();