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
import { fetchMemeImage } from './services/meme';
import { getUserInfo } from './utils/user';
import { checkMatch } from './config/rbac';

process.env.TZ = 'America/Sao_Paulo';

process.on('unhandledRejection', (reason) => {
    console.log('[SISTEMA] Rejeição assíncrona interceptada:', reason);
});
process.on('uncaughtException', (error) => {
    console.log('[ERRO CRÍTICO] Exceção não tratada:', error);
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
                        text: `🔓 *BOM DIA! PROTOCOLO JARVIS DE ABERTURA:*\n\nO chat foi liberado para todos os membros conversarem conforme o horário programado (${sched.openTime}).`
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
                        text: `🔒 *BOA NOITE! PROTOCOLO JARVIS DE FECHAMENTO:*\n\nO chat foi fechado para descanso/manutenção conforme o horário programado (${sched.closeTime}). Apenas administradores podem enviar mensagens neste momento.`
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

// Cron 3: Memes Automáticos a cada 2 Horas (Disparo em grupos ativos)
cron.schedule('0 */2 * * *', async () => {
    if (!sockInstance) return;
    try {
        const meme = await fetchMemeImage();
        if (!meme || !meme.buffer) return;

        for (const chatId in storage.data.groupStats) {
            if (!chatId.endsWith('@g.us') || storage.isBotDisabled(chatId) || storage.isGroupClosed(chatId)) continue;
            const isMemeDisabled = storage.isFeatureDisabled(chatId, 'meme') || storage.data.autoMemes?.[chatId] === false;
            if (isMemeDisabled) continue;

            try {
                await sockInstance.sendMessage(chatId, {
                    image: meme.buffer,
                    caption: `😂 *MEME AUTOMÁTICO DAS 2 HORAS (JARVIS ENTERTAINMENT)*\n_${meme.title}_`
                });
            } catch (e) {}
        }
    } catch (err: any) {
        console.error('[ERRO CRON MEMES]', err.message);
    }
}, { timezone: "America/Sao_Paulo" });

// Cron 4: Limpeza e Purga Contínua dos Clusters de Memória (> 30 Minutos)
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
        browser: ['JARVIS AUTONOMOUS', 'Chrome', '2.5.0']
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
            console.log('[SISTEMA] Conexão fechada. Reconectando...', shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('[SISTEMA] JARVIS BOT2.0 (Versão 2.5.0 com Anti-Link Ban Imediato & Divulgações) conectado com sucesso!');
        }
    });

    setupGroupEvents(sock, storage);

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        for (const msg of m.messages) {
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
                                text: `🚫 *JARVIS SECURITY (ANTI-GHOST):*\n\n` +
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

    // Verificador 2: Timeout da Função Troll (2 minutos sem resposta)
    setInterval(async () => {
        if (!storage.data.activeTrolls || Object.keys(storage.data.activeTrolls).length === 0) return;
        const now = Date.now();

        for (const chatId in storage.data.activeTrolls) {
            if (storage.isBotDisabled(chatId) || storage.isGroupClosed(chatId)) continue;
            const troll = storage.data.activeTrolls[chatId];
            if (troll && now >= troll.deadline) {
                try {
                    delete storage.data.activeTrolls[chatId];
                    storage.flagSave();

                    await sock.sendMessage(chatId, {
                        text: `😅 Não está afim de brincar, desculpe!`
                    });
                } catch (e: any) {
                    console.error('[ERRO TIMEOUT TROLL]', e.message);
                }
            }
        }
    }, 15000);

    // Verificador 3: Lembrete de Boas-Vindas (!bv - 15 minutos)
    setInterval(async () => {
        if (!storage.data.pendingBvReminders || storage.data.pendingBvReminders.length === 0) return;
        const now = Date.now();
        const remaining = [];

        for (const reminder of storage.data.pendingBvReminders) {
            if (now >= reminder.runAt) {
                try {
                    const chatId = reminder.chatId;
                    if (storage.isBotDisabled(chatId) || storage.isFeatureDisabled(chatId, 'bv')) continue;

                    const bvConfig = storage.data.welcomeReminders ? storage.data.welcomeReminders[chatId] : null;
                    if (bvConfig && bvConfig.text) {
                        const memberInfo = getUserInfo(reminder.newMemberId);
                        let userText = bvConfig.text.trim();

                        if (userText.includes('{membro}')) {
                            userText = userText.replace(/\{membro\}/gi, `${memberInfo.mentionTag} (${memberInfo.pushName})`);
                        } else if (userText.includes('{nome}')) {
                            userText = userText.replace(/\{nome\}/gi, memberInfo.pushName);
                        } else if (userText.includes('{numero}')) {
                            userText = userText.replace(/\{numero\}/gi, memberInfo.formattedNum);
                        } else {
                            userText = `👋 ${memberInfo.mentionTag} (*${memberInfo.pushName}*)\n\n${userText}`;
                        }

                        const fullText = `📢 @todos @all\n\n${userText}`;
                        await sock.sendMessage(chatId, { text: fullText, mentions: [memberInfo.jid] });
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
    }, 60000);

    // Verificador 4: Inatividade de 20 Minutos com Intervenção Contextual Jarvis
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
