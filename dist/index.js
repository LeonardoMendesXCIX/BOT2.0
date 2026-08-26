"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const baileys_1 = __importStar(require("@whiskeysockets/baileys"));
const pino_1 = __importDefault(require("pino"));
const qrcode_terminal_1 = __importDefault(require("qrcode-terminal"));
const node_cron_1 = __importDefault(require("node-cron"));
const storage_1 = require("./database/storage");
const commands_1 = require("./handlers/commands");
const events_1 = require("./handlers/events");
const ai_1 = require("./services/ai");
const user_1 = require("./utils/user");
const rbac_1 = require("./config/rbac");
process.env.TZ = 'America/Sao_Paulo';
// Suprime dumps repetitivos de criptografia do libsignal no terminal
const originalConsoleError = console.error;
console.error = (...args) => {
    const msg = args.map(a => a?.message || a?.toString() || '').join(' ');
    if (msg.includes('MessageCounterError') || msg.includes('Failed to decrypt') || msg.includes('Bad MAC')) {
        return;
    }
    originalConsoleError(...args);
};
process.on('unhandledRejection', (reason) => {
    const errStr = reason?.message || reason?.toString() || '';
    if (errStr.includes('Bad MAC') || errStr.includes('MessageCounterError') || errStr.includes('Failed to decrypt')) {
        return;
    }
    console.log('[SISTEMA] Rejeição assíncrona interceptada:', reason?.message || reason);
});
process.on('uncaughtException', (error) => {
    const errStr = error?.message || error?.toString() || '';
    if (errStr.includes('Bad MAC') || errStr.includes('MessageCounterError') || errStr.includes('Failed to decrypt')) {
        return;
    }
    console.log('[ERRO CRÍTICO] Exceção não tratada:', error?.message || error);
});
const storage = new storage_1.StorageManager();
let sockInstance = null;
// Cron 1: Mensagens Automáticas Programadas (!ma) a cada hora
node_cron_1.default.schedule('0 * * * *', async () => {
    if (!storage.data.scheduledMsgs || storage.data.scheduledMsgs.length === 0)
        return;
    const now = new Date();
    const currentHour = now.getHours();
    const dateStr = now.toLocaleDateString('pt-BR');
    let modified = false;
    for (let i = 0; i < storage.data.scheduledMsgs.length; i++) {
        const sched = storage.data.scheduledMsgs[i];
        if (storage.isBotDisabled(sched.chatId) || storage.isFeatureDisabled(sched.chatId, 'ma'))
            continue;
        if (sched.hours.includes(currentHour)) {
            if (!sched.lastSent)
                sched.lastSent = {};
            const sentKey = `${dateStr}-${currentHour}`;
            if (!sched.lastSent[sentKey]) {
                try {
                    await sockInstance?.sendMessage(sched.chatId, { text: sched.text });
                    sched.lastSent[sentKey] = true;
                    modified = true;
                }
                catch (e) {
                    console.error('[ERRO AUTO MSG CRON]', e.message);
                }
            }
        }
    }
    if (modified)
        storage.flagSave();
}, { timezone: "America/Sao_Paulo" });
// Cron 2: Agendador Diário de Abertura/Fechamento & Divulgações Programadas
node_cron_1.default.schedule('* * * * *', async () => {
    if (!sockInstance)
        return;
    const now = new Date();
    const currentHHMM = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false });
    // A. Abertura / Fechamento de Grupos
    if (storage.data.groupSchedules) {
        for (const chatId in storage.data.groupSchedules) {
            if (storage.isBotDisabled(chatId) || storage.isGroupClosed(chatId))
                continue;
            const sched = storage.data.groupSchedules[chatId];
            if (!sched)
                continue;
            if (sched.openTime === currentHHMM && !storage.isFeatureDisabled(chatId, 'fechar_abrir')) {
                try {
                    await sockInstance.groupSettingUpdate(chatId, 'not_announcement');
                    storage.setGroupClosed(chatId, false);
                    await sockInstance.sendMessage(chatId, {
                        text: `🔓 *BOM DIA! PROTOCOLO JARVIS DE ABERTURA:*

O chat foi liberado para todos os membros conversarem conforme o horário programado (${sched.openTime}).`
                    });
                    console.log(`[HORÁRIO AUTOMÁTICO] Grupo ${chatId} aberto às ${currentHHMM}`);
                }
                catch (e) {
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
                }
                catch (e) {
                    console.error('[ERRO AUTO FECHAR GRUPO]', e.message);
                }
            }
        }
    }
    // B. Divulgações Programadas (!divulga)
    if (storage.data.promoSchedule) {
        for (const chatId in storage.data.promoSchedule) {
            if (storage.isBotDisabled(chatId) || storage.isFeatureDisabled(chatId, 'divulga'))
                continue;
            const promo = storage.data.promoSchedule[chatId];
            if (!promo || !promo.active)
                continue;
            // Início do Horário de Divulgação
            if (promo.startTime === currentHHMM) {
                try {
                    await sockInstance.sendMessage(chatId, {
                        text: `📢 *HORÁRIO DE DIVULGAÇÕES ABERTO!* (${promo.startTime} às ${promo.endTime})\n\n${promo.content}\n\n🛡️ *Atenção:* O envio de links está liberado para todos os membros durante este período sem risco de remoção!`
                    });
                }
                catch (e) { }
            }
            // Fim do Horário de Divulgação
            if (promo.endTime === currentHHMM) {
                try {
                    await sockInstance.sendMessage(chatId, {
                        text: `🔒 *HORÁRIO DE DIVULGAÇÕES ENCERRADO!*\n\n_O Anti-Link voltou a operar normalmente com expulsão automática para quem enviar links._`
                    });
                }
                catch (e) { }
            }
        }
    }
}, { timezone: "America/Sao_Paulo" });
// Cron 3: Limpeza e Purga Contínua dos Clusters de Memória (> 30 Minutos)
node_cron_1.default.schedule('*/5 * * * *', () => {
    storage.purgeExpiredClusters();
});
async function startBot() {
    const { state, saveCreds } = await (0, baileys_1.useMultiFileAuthState)('./sessions');
    const { version } = await (0, baileys_1.fetchLatestBaileysVersion)();
    const sock = (0, baileys_1.default)({
        version,
        logger: (0, pino_1.default)({ level: 'silent' }),
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
            qrcode_terminal_1.default.generate(qr, { small: true });
            console.log('\n[SISTEMA] Escaneie o QR Code acima com seu WhatsApp.');
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== baileys_1.DisconnectReason.loggedOut;
            console.log('[SISTEMA] Conexão fechada. Reconectando em 3 segundos...', shouldReconnect);
            if (shouldReconnect) {
                setTimeout(() => startBot(), 3000);
            }
        }
        else if (connection === 'open') {
            console.log('[SISTEMA] JARVIS BOT2.0 conectado com sucesso!');
        }
    });
    // Listener Anti-Delete (Detecção de Mensagens Apagadas no Grupo)
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update?.messageStubType === 1 || update.update?.message === null) {
                const chatId = update.key.remoteJid || '';
                const msgId = update.key.id || '';
                if (chatId.endsWith('@g.us') && !storage.isBotDisabled(chatId) && !storage.isFeatureDisabled(chatId, 'antidelete') && storage.data.antidelete?.[chatId] !== false) {
                    const buffered = storage.data.messageBuffer?.[chatId]?.[msgId];
                    if (buffered && (Date.now() - buffered.timestamp < 15 * 60 * 1000)) {
                        const authorInfo = (0, user_1.getUserInfo)(buffered.sender);
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
    (0, events_1.setupGroupEvents)(sock, storage);
    sock.ev.on('messages.upsert', async (m) => {
        for (const msg of m.messages) {
            try {
                await (0, commands_1.handleCommand)(sock, msg, storage);
            }
            catch (err) {
                console.error('[ERRO PROCESSANDO MENSAGEM]', err.message);
            }
        }
    });
    // Verificador 1: Sistema Anti-Ghost (10 minutos para apresentação)
    setInterval(async () => {
        if (!storage.data.pendingPresentations || storage.data.pendingPresentations.length === 0)
            return;
        const now = Date.now();
        const remaining = [];
        for (const item of storage.data.pendingPresentations) {
            if (now >= item.deadline) {
                try {
                    const chatId = item.chatId;
                    if (storage.isBotDisabled(chatId) || storage.isGroupClosed(chatId))
                        continue;
                    const isAntiGhostActive = !storage.isFeatureDisabled(chatId, 'antighost') && storage.data.antighost[chatId] !== false;
                    if (isAntiGhostActive) {
                        const groupMeta = await sock.groupMetadata(chatId).catch(() => null);
                        const isStillInGroup = groupMeta?.participants?.some(p => p.id === item.memberId || (0, rbac_1.checkMatch)(p.id.split('@')[0], item.memberNum));
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
                }
                catch (e) {
                    console.error('[ERRO AUTO KICK ANTI-GHOST]', e.message);
                }
            }
            else {
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
        if (!storage.data.pendingBvReminders || storage.data.pendingBvReminders.length === 0)
            return;
        const now = Date.now();
        const remaining = [];
        for (const reminder of storage.data.pendingBvReminders) {
            if (now >= reminder.runAt) {
                try {
                    const chatId = reminder.chatId;
                    if (storage.isBotDisabled(chatId) || storage.isFeatureDisabled(chatId, 'bv'))
                        continue;
                    const bvConfig = storage.data.welcomeReminders ? storage.data.welcomeReminders[chatId] : null;
                    if (bvConfig && bvConfig.text) {
                        const groupMeta = await sockInstance?.groupMetadata(chatId).catch(() => null);
                        if (!groupMeta || !groupMeta.participants) {
                            remaining.push(reminder);
                            continue;
                        }
                        const rawMemberNum = (0, user_1.extractRawNumber)(reminder.newMemberId);
                        const isStillInGroup = groupMeta.participants.some((p) => p.id === reminder.newMemberId ||
                            p.lid === reminder.newMemberId ||
                            (p.id && (0, rbac_1.checkMatch)(p.id.split('@')[0], rawMemberNum)) ||
                            (p.lid && (0, rbac_1.checkMatch)(p.lid.split('@')[0], rawMemberNum)));
                        if (!isStillInGroup) {
                            console.log(`[LEMBRETE BV CANCELADO] O membro +${rawMemberNum} não está mais no grupo ${chatId}.`);
                            continue;
                        }
                        const memberInfo = (0, user_1.getUserInfo)(reminder.newMemberId);
                        let userText = bvConfig.text.trim();
                        if (userText.includes('{membro}')) {
                            userText = userText.replace(/\{membro\}/gi, memberInfo.nameAndNumber);
                        }
                        else if (userText.includes('{nome}')) {
                            userText = userText.replace(/\{nome\}/gi, memberInfo.pushName || memberInfo.formattedNum);
                        }
                        else if (userText.includes('{numero}')) {
                            userText = userText.replace(/\{numero\}/gi, memberInfo.formattedNum);
                        }
                        else {
                            userText = `👋 ${memberInfo.nameAndNumber}\n\n${userText}`;
                        }
                        const fullText = `📢 @todos @all\n\n${userText}`;
                        const allMentions = Array.from(new Set([memberInfo.jid, reminder.newMemberId])).filter(Boolean);
                        await sockInstance?.sendMessage(chatId, { text: fullText, mentions: allMentions });
                        console.log(`[LEMBRETE BV ENVIADO] Lembrete disparado para ${memberInfo.nameAndNumber} no grupo ${chatId}`);
                    }
                }
                catch (e) {
                    console.error('[ERRO LEMBRETE BV]', e.message);
                }
            }
            else {
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
        if (!storage.data.autoAnim)
            return;
        const now = Date.now();
        const INACTIVITY_LIMIT = 20 * 60 * 1000;
        for (const chatId in storage.data.autoAnim) {
            if (storage.isBotDisabled(chatId) || storage.isGroupClosed(chatId))
                continue;
            if (storage.data.autoAnim[chatId] === true && !storage.isFeatureDisabled(chatId, 'auto')) {
                const lastActive = storage.data.lastGroupActivity[chatId] || 0;
                const alreadySent = storage.data.autoAnimSent[chatId] || false;
                if (lastActive > 0 && (now - lastActive >= INACTIVITY_LIMIT) && !alreadySent) {
                    try {
                        storage.data.autoAnimSent[chatId] = true;
                        storage.flagSave();
                        const cluster = storage.data.memoryCluster?.[chatId] || [];
                        const clusterStrings = cluster.map(m => `${m.authorName} (+${m.authorNum}): ${m.text}`);
                        const promptAnim = `O grupo ficou completamente em silêncio por mais de 20 minutos.\n` +
                            `Como Jarvis, faça uma intervenção curta, perspicaz, elegante ou descontraída para reativar as conversas no grupo.\n` +
                            `Regra: Máximo 2 a 3 linhas com emojis.`;
                        const aiAnim = await (0, ai_1.callAI)(promptAnim, clusterStrings);
                        await sock.sendMessage(chatId, { text: `📢 @todos @all\n\n🤖 *Jarvis:* ${aiAnim}` });
                    }
                    catch (e) {
                        console.error('[ERRO AUTO ANIM]', e.message);
                    }
                }
            }
        }
    }, 60000);
}
startBot();
