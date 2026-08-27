import { WASocket, proto, downloadMediaMessage } from '@whiskeysockets/baileys';
import { StorageManager } from '../database/storage';
import { RBAC, getUserRole, hasPermission, isSuperAdmin, checkMatch } from '../config/rbac';
import { SIGNS, FOOTBALL_CHAMPIONSHIPS, NEWS_TOPICS, QUIZ_DATABASE, FEATURE_MAP, FEATURE_NAMES, SETTINGS } from '../config/settings';
import { callAI, evaluateAutonomousIntervention } from '../services/ai';
import { checkImageNSFW } from '../services/nsfw';
import { transcribeAudio } from '../services/transcription';
import { generateAIImage } from '../services/imageGen';
import { generateTTS } from '../services/tts';
import { fetchHoroscope } from '../services/horoscope';
import { fetchNews } from '../services/news';
import { fetchFootballData } from '../services/football';
import { fetchCurrency } from '../services/currency';
import { fetchWikipedia } from '../services/wikipedia';
import { imageToStickerBuffer, stickerToImageBuffer } from '../utils/sticker';
// CORREÇÃO: adicionado contactCache para resolver nomes no !inativos
import { getUserInfo, updateLidMapping, extractRawNumber, UserDisplayInfo, lidMap, contactCache } from '../utils/user';
import axios from 'axios';

const userMessageHistory: Record<string, number[]> = {};
const aiCooldowns: Record<string, Record<string, number>> = {};
const lastAdminResponse = new Map<string, number>();

function levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j] + 1
                );
            }
        }
    }
    return matrix[b.length][a.length];
}

function findSuggestedCommand(inputCmd: string): string | null {
    const validCmds = Object.keys(FEATURE_MAP);
    let bestMatch: string | null = null;
    let minDistance = 3;
    for (const cmd of validCmds) {
        const d = levenshteinDistance(inputCmd.toLowerCase(), cmd.toLowerCase());
        if (d < minDistance && d > 0) {
            minDistance = d;
            bestMatch = cmd;
        }
    }
    return bestMatch;
}

export function getMessageText(msg: proto.IWebMessageInfo): string {
    const m = msg.message;
    if (!m) return '';
    if (m.conversation) return m.conversation;
    if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
    if (m.imageMessage?.caption) return m.imageMessage.caption;
    if (m.videoMessage?.caption) return m.videoMessage.caption;
    if (m.ephemeralMessage?.message) return getMessageText({ ...msg, message: m.ephemeralMessage.message });
    if (m.viewOnceMessage?.message) return getMessageText({ ...msg, message: m.viewOnceMessage.message });
    if (m.viewOnceMessageV2?.message) return getMessageText({ ...msg, message: m.viewOnceMessageV2.message });
    return '';
}

export async function handleCommand(
    sock: WASocket,
    msg: proto.IWebMessageInfo,
    storage: StorageManager
): Promise<void> {
    const key = msg.key;
    const chatId = key.remoteJid || '';
    const isGroup = chatId.endsWith('@g.us');
    const sender = key.participant || key.remoteJid || '';
    const userId = sender.split('@')[0].split(':')[0];
    const state = storage.data.states[userId];

    const pushNameRaw = msg.pushName || '';
    const userInfo = getUserInfo(sender, pushNameRaw);

    const messageText = getMessageText(msg);
    const text = messageText.trim();
    const textLower = text.toLowerCase();
    const firstWord = text.split(/[\s+]+/)[0].toLowerCase();

    // =====================================================================
    // CORREÇÃO: HANDLER DA CONFIRMAÇÃO SIM/NÃO/1/2 DA LIMPEZA DE INATIVOS
    // =====================================================================
    if (state && state.mode === 'inativos_confirm_removal') {
        const answer = textLower.trim();
        const isYes = ['sim', '1', 's', 'yes', 'si'].includes(answer);
        const isNo = ['nao', 'não', 'naõ', '2', 'n', 'no'].includes(answer);

        if (!isYes && !isNo) {
            await sock.sendMessage(chatId, {
                text: `⚠️ Responda *SIM* (ou 1) para confirmar a remoção, ou *NÃO* (ou 2) para cancelar.`
            }, { quoted: msg });
            return;
        }

        const targetChat = state.targetChat || chatId;
        const inactiveList: any[] = state.inactiveList || [];
        delete storage.data.states[userId];
        storage.flagSave();

        if (isNo) {
            await sock.sendMessage(chatId, {
                text: '🛑 *Limpeza de inativos cancelada.* Nenhum integrante foi removido.'
            }, { quoted: msg });
            return;
        }

        await sock.sendMessage(chatId, {
            text: `🧹 *Jarvis:* Iniciando remoção de ${inactiveList.length} integrante(s) inativo(s)...`
        }, { quoted: msg });

        let removedCount = 0;
        const removedNames: string[] = [];
        for (const u of inactiveList) {
            const removeJid = u.removeJid || u.jid;
            try {
                await sock.groupParticipantsUpdate(targetChat, [removeJid], 'remove');
                removedCount++;
                removedNames.push(`• ${u.nameAndNumber}`);
                await new Promise(r => setTimeout(r, 600));
            } catch (e: any) {
                console.error('[ERRO REMOVER INATIVO]', e.message);
            }
        }

        const report = `🧹 *LIMPEZA DE INATIVOS CONCLUÍDA!*\n\n📊 *Removidos:* ${removedCount} de ${inactiveList.length}\n\n${removedNames.join('\n') || '_Nenhum integrante removido._'}`;
        await sock.sendMessage(chatId, { text: report });

        const afterMsg = storage.data.inativosMsgs?.[targetChat]?.text;
        if (afterMsg) await sock.sendMessage(targetChat, { text: afterMsg });
        return;
    }

    // Silenciamento de comandos multimídia do bot-musica-cloud
    const IGNORED_MULTIMEDIA_PREFIXES = [
        '!p', '!pp', '!v', '!play', '!video', '!playlist', '!musica', '!song', '!msc', '!tocar', '!ytmp3'
    ];
    if (
        IGNORED_MULTIMEDIA_PREFIXES.includes(firstWord) ||
        IGNORED_MULTIMEDIA_PREFIXES.some(prefix => textLower.startsWith(prefix + ' ') || textLower.startsWith(prefix + '+'))
    ) {
        return;
    }

    // !bot on/off
    if (firstWord === '!bot') {
        const parts = text.trim().split(/\s+/);
        const action = parts[1]?.toLowerCase();

        if (action === 'on' || action === 'off') {
            if (!isGroup) {
                await sock.sendMessage(chatId, { text: '❌ O comando !bot é exclusivo para grupos.' }, { quoted: msg });
                return;
            }
            const userRole = parseInt(getUserRole(userId, storage.data.users));
            if (userRole < 2) {
                await sock.sendMessage(chatId, { text: `❌ ${userInfo.pushName}, apenas administradores podem ligar/desligar o bot.` }, { quoted: msg });
                return;
            }

            const shouldDisable = action === 'off';
            storage.setBotDisabled(chatId, shouldDisable);

            if (shouldDisable) {
                await sock.sendMessage(chatId, {
                    text: `🔴 *JARVIS BOT DESATIVADO NESTE GRUPO*\n\nO bot foi colocado em modo de espera exclusivo para este grupo. Todas as automações e comandos estão pausados.\n_Para reativar, qualquer administrador pode enviar:_ \`!bot on\``,
                    mentions: [userInfo.jid]
                });
            } else {
                await sock.sendMessage(chatId, {
                    text: `🟢 *JARVIS BOT REATIVADO COM SUCESSO!*\n\nO bot está 100% online e operando normalmente neste grupo.`,
                    mentions: [userInfo.jid]
                });
            }
            return;
        }
    }

    if (isGroup && storage.isBotDisabled(chatId)) {
        if (text.startsWith('!')) {
            console.log(`[AVISO] Bot em modo '!bot off' no grupo ${chatId}. Envie '!bot on' no grupo para reativar.`);
        }
        return;
    }

    // !cancelar
    if (['!cancelar', 'cancelar', 'sair', '!sair'].includes(textLower)) {
        if (state && state.mode) {
            delete storage.data.states[userId];
            storage.flagSave();
            await sock.sendMessage(chatId, {
                text: `🛑 *Operação cancelada com sucesso.* Você pode enviar novos comandos quando quiser.`
            }, { quoted: msg });
            return;
        }
    }

    // Atualização passiva
    if (isGroup) {
        storage.data.lastGroupActivity[chatId] = Date.now();
        storage.data.autoAnimSent[chatId] = false;

        // CORREÇÃO: mapeia LID -> número real quando o WhatsApp revela o senderPn
        const senderPn = (msg.key as any).senderPn;
        if (senderPn && sender.includes('@lid')) {
            lidMap[sender.split('@')[0].split(':')[0].replace(/\D/g, '')] = String(senderPn).split('@')[0].split(':')[0].replace(/\D/g, '');
        }

        // CORREÇÃO: persiste nomes conhecidos para consultas futuras (!inativos)
        if (userInfo.pushName && userInfo.number && userInfo.number.length <= 13) {
            if (!storage.data.cache) storage.data.cache = {};
            if (!storage.data.cache.names) storage.data.cache.names = {};
            if (storage.data.cache.names[userInfo.number] !== userInfo.pushName) {
                storage.data.cache.names[userInfo.number] = userInfo.pushName;
                storage.flagSave();
            }
        }

        if (storage.data.pendingPresentations && storage.data.pendingPresentations.length > 0) {
            const rawSenderNum = userInfo.number;
            const beforeLen = storage.data.pendingPresentations.length;
            storage.data.pendingPresentations = storage.data.pendingPresentations.filter(
                p => !(p.chatId === chatId && checkMatch(p.memberNum, rawSenderNum))
            );
            if (storage.data.pendingPresentations.length !== beforeLen) {
                storage.flagSave();
                console.log(`[ANTI-GHOST] Apresentação confirmada para ${userInfo.pushName} (${userInfo.formattedNum})`);
            }
        }

        if (text && !key.fromMe) {
            storage.addMessageToCluster(chatId, userInfo.number, userInfo.pushName, text);
        }
    }
        // Interceptador de divulgação (!divulga)
    if (state && state.mode && state.mode.startsWith('divulga_')) {
        const inputClean = text.trim();

        if (state.mode === 'divulga_waiting_time') {
            const timeMatch = inputClean.match(/(\d{1,2}:\d{2})\s*(?:às|as|a|-|ate|até)\s*(\d{1,2}:\d{2})/i);
            if (!timeMatch) {
                await sock.sendMessage(chatId, {
                    text: `⚠️ *Formato de horário inválido.*\n\nEnvie no formato: \`das 20:00 às 21:00\` ou \`20:00 as 21:00\` ou \`20:00 - 21:00\`:`
                });
                return;
            }
            const startTime = timeMatch[1].padStart(5, '0');
            const endTime = timeMatch[2].padStart(5, '0');
            state.startTime = startTime;
            state.endTime = endTime;
            state.mode = 'divulga_waiting_content';
            storage.flagSave();
            await sock.sendMessage(chatId, {
                text: `📢 *O que deseja divulgar?*\n\nEnvie o texto completo e o link da divulgação oficial do grupo (Ex: _Acesse nosso canal facebook.com/..._):`
            });
            return;
        }

        if (state.mode === 'divulga_waiting_content') {
            if (!inputClean) return;
            if (!storage.data.promoSchedule) storage.data.promoSchedule = {};
            storage.data.promoSchedule[chatId] = {
                startTime: state.startTime,
                endTime: state.endTime,
                content: inputClean,
                setBy: userId,
                active: true
            };
            delete storage.data.states[userId];
            storage.flagSave();
            await sock.sendMessage(chatId, {
                text: `✅ *HORÁRIO DE DIVULGAÇÃO PROGRAMADO COM SUCESSO!*\n\n` +
                    `⏰ *Período Liberado:* das *${state.startTime}* às *${state.endTime}* (todos os dias)\n` +
                    `📢 *Divulgação Oficial:*\n${inputClean}\n\n` +
                    `🛡️ *Regra Especial do Anti-Link:*\n` +
                    `_Durante o horário estabelecido, o Anti-Link será temporariamente pausado, permitindo que todos os integrantes enviem seus links livremente sem sofrerem remoção._`
            });
            return;
        }
    }

    // Interceptor !ma
    if (state && state.mode && state.mode.startsWith('ma_')) {
        const inputClean = text.trim();

        if (state.mode === 'ma_menu_main') {
            if (inputClean === '1') {
                const existingMsg = storage.data.scheduledMsgs.find(m => m.chatId === chatId);
                if (existingMsg) {
                    const hoursStr = existingMsg.hours.map(h => `${String(h).padStart(2, '0')}:00`).join(', ');
                    let infoStr = `📋 *JARVIS: MENSAGEM PROGRAMADA ATUAL*\n\n` +
                        `📝 *Texto:* _${existingMsg.text}_\n` +
                        `⏰ *Horários de Envio:* ${hoursStr}\n` +
                        `🔄 *Tipo:* ${existingMsg.isReps ? 'Por Repetições' : 'Por Horários Fixos'}\n\n` +
                        `*Deseja manter ou alterar esta mensagem?*\n` +
                        `1 - Manter mensagem\n` +
                        `2 - Alterar mensagem`;
                    state.mode = 'ma_opt1_confirm';
                    storage.flagSave();
                    await sock.sendMessage(chatId, { text: infoStr });
                    return;
                } else {
                    await sock.sendMessage(chatId, { text: 'ℹ️ Nenhuma mensagem programada encontrada neste grupo. Escolha:\n2 - Alterar/Criar mensagem programada' });
                    return;
                }
            } else if (inputClean === '2') {
                state.mode = 'ma_opt2_text';
                storage.flagSave();
                await sock.sendMessage(chatId, { text: `📝 *Qual a nova mensagem programada?*` });
                return;
            } else if (inputClean === '3') {
                state.mode = 'ma_opt3_hours';
                storage.flagSave();
                const currentHour = new Date().getHours();
                const firstHour = (currentHour + 1) % 24;
                await sock.sendMessage(chatId, { text: `⏰ *ALTERAR HORÁRIOS DE ENVIO*\n\nPrimeira mensagem às ${String(firstHour).padStart(2, '0')}:00 e as seguintes de 2 em 2 horas.\n\nQuantas mensagens deseja programar por dia? (1 a 10):` });
                return;
            } else if (inputClean === '4') {
                state.mode = 'ma_opt4_reps';
                storage.flagSave();
                await sock.sendMessage(chatId, { text: `🔄 Quantas mensagens deseja programar por dia? (1 a 10):` });
                return;
            }
        }

        if (state.mode === 'ma_opt1_confirm') {
            if (inputClean === '1') {
                delete storage.data.states[userId];
                storage.flagSave();
                await sock.sendMessage(chatId, { text: '✅ *Mensagem programada mantida sem alterações.*' });
                return;
            } else if (inputClean === '2') {
                state.mode = 'ma_opt2_text';
                storage.flagSave();
                await sock.sendMessage(chatId, { text: `📝 *Qual a nova mensagem programada?*` });
                return;
            }
        }

        if (state.mode === 'ma_opt2_text') {
            if (!inputClean) return;
            state.newText = inputClean;
            state.mode = 'ma_opt2_type';
            storage.flagSave();
            await sock.sendMessage(chatId, { text: `⏱️ *COMO DESEJA DEFINIR OS HORÁRIOS?*\n\n1 - Escolher horários fixos (Ex: 08:00, 14:00, 20:00)\n2 - Programar por repetições (1ª em 1h e restantes a cada 2h)` });
            return;
        }

        if (state.mode === 'ma_opt2_type') {
            if (inputClean === '1') {
                state.mode = 'ma_waiting_time';
                storage.flagSave();
                await sock.sendMessage(chatId, { text: `⏰ Envie os horários desejados separados por vírgula (Ex: 09:00, 15:00, 21:00):` });
                return;
            } else if (inputClean === '2') {
                state.mode = 'ma_opt4_reps';
                storage.flagSave();
                await sock.sendMessage(chatId, { text: `🔄 Quantas mensagens deseja programar por dia? (1 a 10):` });
                return;
            }
        }

        if (state.mode === 'ma_waiting_time') {
            const rawTimes = inputClean.split(/[,;\s]+/);
            const hoursList: number[] = [];
            for (const t of rawTimes) {
                const hourPart = parseInt(t.trim().split(':')[0]);
                if (!isNaN(hourPart) && hourPart >= 0 && hourPart <= 23) {
                    if (!hoursList.includes(hourPart)) hoursList.push(hourPart);
                }
            }
            if (hoursList.length === 0) {
                await sock.sendMessage(chatId, { text: '⚠️ Nenhum horário válido. Envie no formato: `08:00, 14:00, 20:00`' });
                return;
            }
            hoursList.sort((a, b) => a - b);
            const msgTextToSave = state.newText || 'Mensagem Automática';
            const existingIndex = storage.data.scheduledMsgs.findIndex(m => m.chatId === chatId);
            const item = { id: `${Date.now()}`, chatId, authorId: userId, authorNum: userInfo.number, text: msgTextToSave, hours: hoursList, isReps: false, lastSent: {} };
            if (existingIndex !== -1) storage.data.scheduledMsgs[existingIndex] = item;
            else storage.data.scheduledMsgs.push(item);
            delete storage.data.states[userId];
            storage.flagSave();
            await sock.sendMessage(chatId, { text: `⏰ *MENSAGEM AUTOMÁTICA PROGRAMADA!*\n\n📝 *Texto:* _${msgTextToSave}_\n🕒 *Horários:* ${hoursList.map(h => `${String(h).padStart(2, '0')}:00`).join(', ')}` });
            return;
        }

        if (state.mode === 'ma_opt3_hours' || state.mode === 'ma_opt4_reps') {
            const countChoice = parseInt(inputClean);
            if (isNaN(countChoice) || countChoice < 1 || countChoice > 10) {
                await sock.sendMessage(chatId, { text: '⚠️ Escolha um número de 1 a 10.' });
                return;
            }
            const currentHour = new Date().getHours();
            const calculatedHours: number[] = [];
            for (let i = 0; i < countChoice; i++) {
                const hour = (currentHour + 1 + (i * 2)) % 24;
                if (!calculatedHours.includes(hour)) calculatedHours.push(hour);
            }
            calculatedHours.sort((a, b) => a - b);
            const msgTextToSave = state.newText || 'Mensagem Automática';
            const existingIndex = storage.data.scheduledMsgs.findIndex(m => m.chatId === chatId);
            const item = { id: `${Date.now()}`, chatId, authorId: userId, authorNum: userInfo.number, text: msgTextToSave, hours: calculatedHours, isReps: true, lastSent: {} };
            if (existingIndex !== -1) storage.data.scheduledMsgs[existingIndex] = item;
            else storage.data.scheduledMsgs.push(item);
            delete storage.data.states[userId];
            storage.flagSave();
            await sock.sendMessage(chatId, { text: `⏰ *MENSAGEM AUTOMÁTICA PROGRAMADA!*\n\n📝 *Texto:* _${msgTextToSave}_\n📊 *Total:* ${countChoice} disparo(s)\n🕒 *Horários:* ${calculatedHours.map(h => `${String(h).padStart(2, '0')}:00`).join(', ')}` });
            return;
        }
    }

    // Quiz
    if (isGroup && storage.data.activeQuiz && storage.data.activeQuiz[chatId] && !storage.isFeatureDisabled(chatId, 'quiz')) {
        const currentQuiz = storage.data.activeQuiz[chatId];
        if (text.toLowerCase().trim() === currentQuiz.answer) {
            delete storage.data.activeQuiz[chatId];
            storage.flagSave();
            await sock.sendMessage(chatId, {
                text: `🎉 *PARABÉNS ${userInfo.mentionTag} (${userInfo.pushName})!* VOCÊ ACERTOU!\n\n📱 *Número:* ${userInfo.formattedNum}\n✅ *Resposta:* ${currentQuiz.answer.toUpperCase()}\n🏆 *Você venceu o Desafio do Grupo!*`,
                mentions: [userInfo.jid]
            });
        }
    }

    // Detector de ADMINS (com cooldown anti-loop)
    const isAdminQuery = /(quem\s+(é|eh|sao|são)\s+(os|o)?\s*(admin|admins|administrador|administradores|adm|adms)|quem\s+manda|admins\s+do\s+grupo|administradores\s+do\s+grupo|marcar\s+adms|chama\s+os\s+adms)/i.test(textLower) || ['!admins', '!adms'].includes(firstWord);

    if (isGroup && isAdminQuery && !storage.isFeatureDisabled(chatId, 'admins')) {
        const lastTime = lastAdminResponse.get(chatId) || 0;
        const now = Date.now();
        if (now - lastTime < 10000) return;

        try {
            const groupMeta = await sock.groupMetadata(chatId);
            const botIdClean = sock.user?.id ? sock.user.id.split(':')[0].replace(/\D/g, '') : '';
            const botLidClean = (sock.user as any)?.lid ? (sock.user as any).lid.split(':')[0].replace(/\D/g, '') : '';

            const admins = groupMeta.participants.filter(p => {
                const isAdm = p.admin === 'admin' || p.admin === 'superadmin';
                if (!isAdm) return false;
                const pNum = p.id ? p.id.split('@')[0].split(':')[0].replace(/\D/g, '') : '';
                const pLid = p.lid ? p.lid.split('@')[0].split(':')[0].replace(/\D/g, '') : '';
                if (botIdClean && (checkMatch(botIdClean, pNum) || checkMatch(botIdClean, pLid))) return false;
                if (botLidClean && (checkMatch(botLidClean, pNum) || checkMatch(botLidClean, pLid))) return false;
                return true;
            });

            if (!admins || admins.length === 0) {
                await sock.sendMessage(chatId, { text: 'ℹ️ Nenhum administrador humano localizado neste grupo.' }, { quoted: msg });
                return;
            }

            let adminReport = `🛡️ *ADMINISTRADORES DO GRUPO* 🛡️\n\n`;
            const mentionsArr: string[] = [];
            admins.forEach((adm, idx) => {
                const admInfo = getUserInfo(adm.id, adm.name || (adm as any).notify || '');
                const isCreator = checkMatch('5511927018683', admInfo.number) || checkMatch(RBAC.superAdmin, admInfo.number);
                const badge = isCreator || adm.admin === 'superadmin' ? '👑 Criador/SuperAdmin' : '⭐ Administrador';
                adminReport += `${idx + 1}º 👉 ${admInfo.nameAndNumber} — ${badge}\n`;
                if (admInfo.jid) mentionsArr.push(admInfo.jid);
                if (adm.id) mentionsArr.push(adm.id);
            });
            adminReport += `\n_Total: ${admins.length} administrador(es) ativos._`;
            lastAdminResponse.set(chatId, now);
            await sock.sendMessage(chatId, { text: adminReport, mentions: Array.from(new Set(mentionsArr)) }, { quoted: msg });
            return;
        } catch (e: any) {
            console.error('[ERRO BUSCAR ADMINS]', e.message);
        }
    }

    // Moderação autônoma
    if (isGroup && !key.fromMe) {
        const userRole = getUserRole(userId, storage.data.users);
        const isUserAdmin = parseInt(userRole) >= 2;

        if (!isUserAdmin) {
            const userKey = `${chatId}_${userId}`;
            const nowTime = Date.now();
            const isAntiFloodActive = !storage.isFeatureDisabled(chatId, 'antiflood') && storage.data.antiflood[chatId] !== false;
            if (isAntiFloodActive) {
                if (!userMessageHistory[userKey]) userMessageHistory[userKey] = [];
                userMessageHistory[userKey].push(nowTime);
                userMessageHistory[userKey] = userMessageHistory[userKey].filter(t => nowTime - t < 3000);
                if (userMessageHistory[userKey].length > 5) {
                    try { await sock.sendMessage(chatId, { delete: key }); } catch (e) { }
                    userMessageHistory[userKey] = [];
                    await storage.applyWarning(sock, chatId, sender, 'Envio excessivo de mensagens em curto intervalo (Flood/Spam)', 2);
                    return;
                }
            }

            const isAntiLinkActive = !storage.isFeatureDisabled(chatId, 'antilink') && storage.data.antilink[chatId] !== false;
            const isPromoActive = storage.isPromoWindowActive(chatId);
            if (isAntiLinkActive && !isPromoActive) {
                const hasLink = /(chat\.whatsapp\.com\/|wa\.me\/|https?:\/\/[^\s]+|www\.[^\s]+)/i.test(text);
                if (hasLink) {
                    try { await sock.sendMessage(chatId, { delete: key }); } catch (e) { }
                    try {
                        await sock.groupParticipantsUpdate(chatId, [sender], 'remove');
                        await sock.sendMessage(chatId, {
                            text: `🚫 *ANTI-LINK (EXPULSÃO AUTOMÁTICA)* 🚫\n\n` +
                                `👤 *Infrator:* ${userInfo.mentionTag} (*${userInfo.pushName}*)\n` +
                                `📱 *Número:* ${userInfo.formattedNum}\n` +
                                `📝 *Motivo:* Envio de link não autorizado no grupo.\n\n` +
                                `_Divulgação de links é proibida neste grupo fora dos horários permitidos._`,
                            mentions: [userInfo.jid]
                        });
                        console.log(`[ANTI-LINK BAN] Integrante ${userInfo.number} removido por enviar link.`);
                        return;
                    } catch (errKick: any) {
                        console.error('[ERRO KICK ANTI-LINK]', errKick.message);
                    }
                }
            }

            const isAlertActive = !storage.isFeatureDisabled(chatId, 'alerta') && storage.data.bannedWords[chatId]?.length > 0;
            if (isAlertActive) {
                const containsBanned = storage.data.bannedWords[chatId].some(w => text.toLowerCase().includes(w.toLowerCase()));
                if (containsBanned) {
                    try { await sock.sendMessage(chatId, { delete: key }); } catch (e) { }
                    await storage.applyWarning(sock, chatId, sender, 'Uso de palavra/termo censurado pela moderação', 2);
                    return;
                }
            }
        }

        const isAutoTranscribe = !storage.isFeatureDisabled(chatId, 'audio_transcribe') && storage.data.autoTranscribe?.[chatId] === true;
        if (isAutoTranscribe && msg.message?.audioMessage && !key.fromMe && !storage.isGroupClosed(chatId)) {
            try {
                const audioBuffer = await downloadMediaMessage(msg as any, 'buffer', {});
                if (audioBuffer) {
                    const transcript = await transcribeAudio(audioBuffer);
                    if (transcript && transcript.length > 3) {
                        await sock.sendMessage(chatId, {
                            text: `🎙️ *TRANSCRIÇÃO DE ÁUDIO AUTOMÁTICA*\n👤 *De:* *${userInfo.pushName}* (${userInfo.mentionTag})\n\n📝 *Texto:*\n"${transcript}"`,
                            mentions: [userInfo.jid]
                        }, { quoted: msg });
                    }
                }
            } catch (e) { }
        }

        if (msg.key.id && text) {
            if (!storage.data.messageBuffer) storage.data.messageBuffer = {};
            if (!storage.data.messageBuffer[chatId]) storage.data.messageBuffer[chatId] = {};
            storage.data.messageBuffer[chatId][msg.key.id] = {
                sender: sender,
                text: text,
                pushName: userInfo.pushName,
                timestamp: Date.now()
            };
        }

        const zeroWidthCount = (text.match(/[\u200B-\u200D\uFEFF\u202A-\u202E]/g) || []).length;
        if (zeroWidthCount > 35) {
            try { await sock.sendMessage(chatId, { delete: key }); } catch (e) { }
            await storage.applyWarning(sock, chatId, sender, 'Envio de mensagem com caracteres invisíveis/trava-zap', 2);
            return;
        }

        if (!storage.data.groupStats[chatId]) storage.data.groupStats[chatId] = {};
        if (!storage.data.groupStats[chatId][userInfo.number]) {
            storage.data.groupStats[chatId][userInfo.number] = { text: 0, media: 0, total: 0 };
        }
        storage.data.groupStats[chatId][userInfo.number].total++;
        const hasMedia = !!(msg.message?.imageMessage || msg.message?.videoMessage || msg.message?.audioMessage || msg.message?.stickerMessage);
        if (hasMedia) storage.data.groupStats[chatId][userInfo.number].media++;
        else storage.data.groupStats[chatId][userInfo.number].text++;

        if (!storage.data.chatHistory[chatId]) storage.data.chatHistory[chatId] = {};
        const dateStrLog = new Date().toLocaleDateString('pt-BR');
        if (!storage.data.chatHistory[chatId][dateStrLog]) storage.data.chatHistory[chatId][dateStrLog] = [];
        if (text) {
            storage.data.chatHistory[chatId][dateStrLog].push(`${userInfo.pushName} (${userInfo.formattedNum}): ${text.substring(0, 200)}`);
            if (storage.data.chatHistory[chatId][dateStrLog].length > 500) storage.data.chatHistory[chatId][dateStrLog].shift();
        }
        storage.flagSave();
    }

    if (!text) return;
    if (key.fromMe && !text.startsWith('!')) return;

    // Motor Jarvis
    const isJarvisDisabled = storage.isFeatureDisabled(chatId, 'jarvis') || storage.data.jarvisMode?.[chatId] === false;
    if (isGroup && !isJarvisDisabled && !storage.isGroupClosed(chatId) && !text.startsWith('!')) {
        const cluster = storage.data.memoryCluster?.[chatId] || [];
        const clusterStrings = cluster.map(m => `${m.authorName} (+${m.authorNum}): ${m.text}`);
        const now = Date.now();
        const lastIntervention = storage.data.lastJarvisIntervention?.[chatId] || 0;
        const msgCountSince = storage.data.messageCountSinceLastJarvis?.[chatId] || 0;
        const isExplicitCall = textLower.includes('jarvis') ||
            (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.some(j => j.includes(sock.user?.id?.split(':')[0] || ''))) ||
            (msg.message?.extendedTextMessage?.contextInfo?.participant?.includes(sock.user?.id?.split(':')[0] || ''));

        if (isExplicitCall) {
            try {
                const cleanQuery = text.replace(/jarvis/gi, '').replace(/@\d+/g, '').trim() || text;
                const prompt = `O integrante ${userInfo.pushName} (+${userInfo.number}) disse para você: "${cleanQuery}". Responda de forma perspicaz, elegante, inteligente e prestativa como Jarvis.`;
                const aiResponse = await callAI(prompt, clusterStrings);
                storage.data.lastJarvisIntervention[chatId] = now;
                storage.data.messageCountSinceLastJarvis[chatId] = 0;
                storage.flagSave();
                await sock.sendMessage(chatId, {
                    text: `🤖 *Jarvis:* ${aiResponse}`,
                    mentions: [userInfo.jid]
                }, { quoted: msg });
                return;
            } catch (e: any) {
                console.error('[ERRO JARVIS EXPLÍCITO]', e.message);
            }
        }

        const isCooldownElapsed = (now - lastIntervention) >= (45 * 1000);
        const hasEnoughTraffic = msgCountSince >= 4;
        if (isCooldownElapsed && hasEnoughTraffic && clusterStrings.length >= 3) {
            try {
                const autoIntervention = await evaluateAutonomousIntervention(clusterStrings);
                if (autoIntervention) {
                    storage.data.lastJarvisIntervention[chatId] = now;
                    storage.data.messageCountSinceLastJarvis[chatId] = 0;
                    storage.flagSave();
                    await sock.sendMessage(chatId, { text: `🤖 *Jarvis:* ${autoIntervention}` });
                    return;
                }
            } catch (errAuto: any) {
                console.error('[ERRO INTERVENÇÃO AUTÔNOMA]', errAuto.message);
            }
        }
    }

    const isNavigatingMenu = state && [
        'cadastro_waiting_id', 'cadastro_waiting_role', 'remover_waiting_id',
        'bv_waiting_text', 'divulga_waiting_time', 'divulga_waiting_content', 'inativos_confirm_removal', 'inativos_select_keep',
        'ma_menu_main', 'ma_opt1_confirm', 'ma_opt2_text', 'ma_opt2_type', 'ma_opt3_hours', 'ma_opt4_reps',
        'news_menu', 'news_city', 'news_topics_menu', 'horoscope_menu', 'horoscope_sign', 'weather_menu', 'weather_city', 'football_menu', 'football_query'
    ].includes(state.mode);

    // Liga/Desliga
    const parts = text.trim().split(/\s+/);
    const cmdCandidate = parts[0].toLowerCase();
    const actionCandidate = parts[1]?.toLowerCase();
    if (cmdCandidate.startsWith('!') && (actionCandidate === 'on' || actionCandidate === 'off')) {
        const featKey = FEATURE_MAP[cmdCandidate];
        if (featKey && featKey !== 'bot_master') {
            if (!isGroup) {
                await sock.sendMessage(chatId, { text: '❌ O controle de funções é exclusivo para grupos.' }, { quoted: msg });
                return;
            }
            const userRole = parseInt(getUserRole(userId, storage.data.users));
            if (userRole < 2) {
                await sock.sendMessage(chatId, { text: `❌ ${userInfo.pushName}, apenas administradores podem alterar o status dos recursos.` }, { quoted: msg });
                return;
            }
            const enable = actionCandidate === 'on';
            storage.setFeatureStatus(chatId, featKey, enable);
            const statusWord = enable ? '*LIGADO*' : '*DESLIGADO*';
            const featName = FEATURE_NAMES[featKey] || cmdCandidate;
            let extraJarvisMsg = '';
            if (featKey === 'jarvis') {
                extraJarvisMsg = enable ?
                    `\n\n🧠 *Cluster de Memória:* Ativo (analisando conversas em tempo real com expiração a cada 30 minutos).\n🤖 *Intervenção:* Autônoma e espontânea ativada.` :
                    `\n\n🛑 *Análise em tempo real pausada:* Não participarei das conversas automaticamente.`;
            }
            await sock.sendMessage(chatId, {
                text: `${enable ? '🟢' : '🔴'} *CONTROLE DE RECURSOS (JARVIS)*\n\n⚙️ *Recurso:* ${featName}\n📊 *Status:* ${statusWord} com sucesso!\n👤 *Alterado por:* ${userInfo.pushName} (${userInfo.formattedNum})${extraJarvisMsg}`,
                mentions: [userInfo.jid]
            });
            return;
        }
    }

    if (isGroup && firstWord.startsWith('!') && !isNavigatingMenu) {
        const featKey = FEATURE_MAP[firstWord];
        if (featKey && featKey !== 'bot_master' && storage.isFeatureDisabled(chatId, featKey)) {
            const featName = FEATURE_NAMES[featKey] || firstWord;
            await sock.sendMessage(chatId, {
                text: `⚠️ *PROTOCOLO DESATIVADO NESTE GRUPO*\n\nO módulo *${featName}* está desligado neste grupo.\n_Administradores podem reativá-lo com:_ \`${firstWord} on\``,
                mentions: [userInfo.jid]
            });
            return;
        }
    }
        // !voz / !falar
    if (['!voz', '!falar'].includes(firstWord)) {
        const queryVoz = text.slice(firstWord.length).trim();
        if (!queryVoz) {
            await sock.sendMessage(chatId, {
                text: `🗣️ *COMO USAR A VOZ DO JARVIS:*\n\nEnvie: \`!voz Digite aqui o texto que você quer que o Jarvis fale em áudio\`\n\n_O Jarvis gerará uma mensagem de voz em áudio no WhatsApp!_`
            }, { quoted: msg });
            return;
        }
        await sock.sendMessage(chatId, { text: `🗣️ *Jarvis:* Sintetizando áudio de voz...` }, { quoted: msg });
        try {
            const audioBuffer = await generateTTS(queryVoz);
            if (audioBuffer) {
                await sock.sendMessage(chatId, {
                    audio: audioBuffer,
                    mimetype: 'audio/mp4',
                    ptt: true
                }, { quoted: msg });
            } else {
                await sock.sendMessage(chatId, { text: '❌ Não foi possível sintetizar a voz no momento.' });
            }
        } catch (e: any) {
            await sock.sendMessage(chatId, { text: '❌ Erro no motor de voz.' });
        }
        return;
    }

    // !desenhe
    if (['!desenhe', '!criarimg', '!gerarimg'].includes(firstWord)) {
        const promptText = text.slice(firstWord.length).trim();
        if (!promptText) {
            await sock.sendMessage(chatId, {
                text: `🎨 *COMO USAR O GERADOR DE IMAGENS:*\n\nEnvie: \`!desenhe Um astronauta surfando em marte em estilo cyberpunk\`\n\n_A IA gerará uma imagem exclusiva em alta resolução!_`
            }, { quoted: msg });
            return;
        }
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) {
            const lastUse = aiCooldowns[userId]?.['image_gen'] || 0;
            const elapsed = Date.now() - lastUse;
            if (elapsed < 15000) {
                const waitSec = Math.ceil((15000 - elapsed) / 1000);
                await sock.sendMessage(chatId, { text: `⏳ *Jarvis:* Por favor, aguarde *${waitSec} segundos* antes de gerar outra imagem.` }, { quoted: msg });
                return;
            }
            if (!aiCooldowns[userId]) aiCooldowns[userId] = {};
            aiCooldowns[userId]['image_gen'] = Date.now();
        }
        await sock.sendMessage(chatId, { text: `🎨 *Jarvis:* Gerando imagem em alta resolução com IA... Aguarde alguns instantes.` }, { quoted: msg });
        try {
            const imgBuffer = await generateAIImage(promptText);
            if (imgBuffer) {
                await sock.sendMessage(chatId, {
                    image: imgBuffer,
                    caption: `🎨 *IMAGEM GERADA POR IA (JARVIS)*\n\n📝 *Prompt:* _${promptText}_\n👤 *Solicitado por:* *${userInfo.pushName}* (${userInfo.mentionTag})`,
                    mentions: [userInfo.jid]
                }, { quoted: msg });
            } else {
                await sock.sendMessage(chatId, { text: '❌ Não foi possível gerar a imagem no momento. Tente novamente com outro prompt.' }, { quoted: msg });
            }
        } catch (e: any) {
            await sock.sendMessage(chatId, { text: '❌ Erro no motor de geração de imagens.' }, { quoted: msg });
        }
        return;
    }

    // !transcrever
    if (['!transcrever', '!ouvir', '!audio'].includes(firstWord)) {
        const targetMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage ? {
            key: {
                remoteJid: chatId,
                id: msg.message.extendedTextMessage.contextInfo.stanzaId,
                participant: msg.message.extendedTextMessage.contextInfo.participant
            },
            message: msg.message.extendedTextMessage.contextInfo.quotedMessage
        } : msg;
        const isAudio = targetMsg.message?.audioMessage;
        if (!isAudio) {
            await sock.sendMessage(chatId, {
                text: `🎙️ *COMO TRANSCREVER ÁUDIO:*\n\nResponda a qualquer mensagem de voz ou áudio no grupo digitando: \`!transcrever\`\n\n_O Jarvis converterá o áudio em texto em menos de 1 segundo!_`
            }, { quoted: msg });
            return;
        }
        await sock.sendMessage(chatId, { text: `🎙️ *Jarvis:* Processando áudio via Whisper Neural...` }, { quoted: msg });
        try {
            const audioBuffer = await downloadMediaMessage(targetMsg as any, 'buffer', {});
            if (audioBuffer) {
                const transcript = await transcribeAudio(audioBuffer);
                if (transcript) {
                    const audioAuthor = targetMsg.key.participant || sender;
                    const authorInfo = getUserInfo(audioAuthor);
                    await sock.sendMessage(chatId, {
                        text: `🎙️ *TRANSCRIÇÃO DE ÁUDIO (JARVIS WHISPER)* 🎙️\n\n👤 *De:* *${authorInfo.pushName}* (${authorInfo.mentionTag})\n\n📝 *Texto Transcrito:*\n"${transcript}"`,
                        mentions: [authorInfo.jid]
                    }, { quoted: msg });
                } else {
                    await sock.sendMessage(chatId, { text: '❌ Não foi possível transcrever este áudio (áudio inaudível ou ruído excessivo).' }, { quoted: msg });
                }
            }
        } catch (e: any) {
            await sock.sendMessage(chatId, { text: '❌ Erro ao baixar ou processar áudio.' }, { quoted: msg });
        }
        return;
    }

    // !enquete
    if (['!enquete', '!votacao'].includes(firstWord)) {
        if (!isGroup) {
            await sock.sendMessage(chatId, { text: '❌ Enquetes só podem ser criadas dentro de grupos.' }, { quoted: msg });
            return;
        }
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 1) {
            await sock.sendMessage(chatId, { text: `❌ ${userInfo.pushName}, apenas membros autorizados podem criar enquetes.` }, { quoted: msg });
            return;
        }
        const rawContent = text.slice(firstWord.length).trim();
        if (!rawContent || !rawContent.includes('|')) {
            await sock.sendMessage(chatId, {
                text: `📊 *COMO CRIAR UMA ENQUETE INTELIGENTE:*\n\nEnvie:\n\`!enquete Pergunta da Enquete | Opção 1 | Opção 2 | Opção 3\`\n\n_Exemplo:_\n\`!enquete Qual o melhor dia para o churrasco? | Sexta | Sábado | Domingo\``
            }, { quoted: msg });
            return;
        }
        const partsEnquete = rawContent.split('|').map(s => s.trim()).filter(Boolean);
        if (partsEnquete.length < 3) {
            await sock.sendMessage(chatId, { text: '⚠️ Uma enquete precisa de pelo menos 1 pergunta e 2 opções separadas por barra (`|`).' }, { quoted: msg });
            return;
        }
        const pollQuestion = partsEnquete[0];
        const pollOptions = partsEnquete.slice(1, 12);
        try {
            await sock.sendMessage(chatId, {
                poll: { name: `📊 ${pollQuestion}`, values: pollOptions, selectableCount: 1 }
            });
            console.log(`[ENQUETE] Enquete criada no grupo ${chatId}: "${pollQuestion}"`);
        } catch (e: any) {
            console.error('[ERRO CRIAR ENQUETE]', e.message);
            await sock.sendMessage(chatId, { text: '❌ Erro ao criar enquete no WhatsApp.' });
        }
        return;
    }

    // !divulga
    if (['!divulga', '!divulgar'].includes(firstWord)) {
        if (!isGroup) {
            await sock.sendMessage(chatId, { text: '❌ Este comando só pode ser usado em grupos.' }, { quoted: msg });
            return;
        }
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) {
            await sock.sendMessage(chatId, { text: `❌ ${userInfo.pushName}, apenas administradores podem configurar divulgações.` }, { quoted: msg });
            return;
        }
        const subArg = text.slice(firstWord.length).trim().toLowerCase();
        if (subArg === 'off' || subArg === 'cancelar') {
            if (storage.data.promoSchedule && storage.data.promoSchedule[chatId]) {
                delete storage.data.promoSchedule[chatId];
                storage.flagSave();
                await sock.sendMessage(chatId, { text: '🛑 *Divulgação programada cancelada com sucesso neste grupo.*' });
                return;
            }
            await sock.sendMessage(chatId, { text: 'ℹ️ Não há divulgação programada ativa neste grupo.' });
            return;
        }
        storage.data.states[userId] = { mode: 'divulga_waiting_time', targetGroup: chatId };
        storage.flagSave();
        await sock.sendMessage(chatId, {
            text: `⏰ *Qual horário deseja a divulgação?*\n\n_Exemplo: "das 20:00 às 21:00" ou "20:00 as 21:00" ou "20:00 - 21:00"_`
        });
        return;
    }

    // !ia / !jarvis
    if (['!ia', '!jarvis'].includes(firstWord)) {
        const q = text.slice(firstWord.length).trim();
        if (!q) {
            await sock.sendMessage(chatId, { text: `🤖 *Jarvis:* Às suas ordens, ${userInfo.pushName}. Em que posso ajudá-lo(a) hoje? Envie sua pergunta após o comando.` }, { quoted: msg });
            return;
        }
        await sock.sendMessage(chatId, { text: `🤖 *Jarvis:* Consultando matriz neural e cluster recente...` }, { quoted: msg });
        const cluster = storage.data.memoryCluster?.[chatId] || [];
        const clusterStrings = cluster.map(m => `${m.authorName} (+${m.authorNum}): ${m.text}`);
        const aiRes = await callAI(q, clusterStrings);
        await sock.sendMessage(chatId, { text: `🤖 *JARVIS:*\n\n${aiRes}`, mentions: [userInfo.jid] });
        return;
    }

    // !antifake
    if (['!antifake', '!ddi', '!limparfakes'].includes(firstWord)) {
        const subCmd = text.slice(firstWord.length).trim().toLowerCase();
        if (subCmd === 'varrer' || subCmd === 'limpar' || firstWord === '!limparfakes') {
            if (!isGroup) {
                await sock.sendMessage(chatId, { text: '❌ Este comando só pode ser usado em grupos.' }, { quoted: msg });
                return;
            }
            const userRole = parseInt(getUserRole(userId, storage.data.users));
            if (userRole < 2) {
                await sock.sendMessage(chatId, { text: `❌ ${userInfo.pushName}, apenas administradores podem executar a varredura Anti-Fake.` }, { quoted: msg });
                return;
            }
            await sock.sendMessage(chatId, { text: `🔍 *Jarvis Security:* Iniciando varredura completa de números estrangeiros no grupo...` }, { quoted: msg });
            try {
                const groupMeta = await sock.groupMetadata(chatId);
                const participantsList = groupMeta.participants || [];
                const foreignList: any[] = [];
                for (const p of participantsList) {
                    const isAdmin = p.admin === 'admin' || p.admin === 'superadmin';
                    if (isAdmin) continue;
                    let raw = extractRawNumber(p.id);
                    const isBr = raw.startsWith('55') && (raw.length === 12 || raw.length === 13);
                    if (!isBr) foreignList.push(p);
                }
                if (foreignList.length === 0) {
                    await sock.sendMessage(chatId, {
                        text: `✅ *VARREDURA CONCLUÍDA:* Nenhum número estrangeiro ou fake foi localizado no grupo. Todos os membros ativos possuem DDI do Brasil (+55).`
                    });
                    return;
                }
                let removedCount = 0;
                const removedNames: string[] = [];
                for (const target of foreignList) {
                    try {
                        await sock.groupParticipantsUpdate(chatId, [target.id], 'remove');
                        removedCount++;
                        const info = getUserInfo(target.id, target.name || (target as any).notify);
                        removedNames.push(`• ${info.fullDisplay}`);
                        await new Promise(r => setTimeout(r, 600));
                    } catch (errRemove: any) {
                        console.error('[ERRO REMOVER FAKE NA VARREDURA]', errRemove.message);
                    }
                }
                const summaryReport = `🛡️ *RELATÓRIO DE VARREDURA ANTI-FAKE* 🛡️\n\n` +
                    `📊 *Total de Estrangeiros Removidos:* ${removedCount}\n\n` +
                    `📋 *Integrantes Expulsos:*\n${removedNames.slice(0, 20).join('\n')}\n\n` +
                    `_O grupo foi limpo e está protegido com tolerância zero para DDIs estrangeiros._`;
                await sock.sendMessage(chatId, { text: summaryReport });
            } catch (errSweep: any) {
                console.error('[ERRO VARREDURA ANTI-FAKE]', errSweep.message);
                await sock.sendMessage(chatId, { text: '❌ Erro ao executar a varredura. Verifique se o bot é Administrador do grupo.' });
            }
            return;
        }
    }

    // !fixar / !desfixar
    if (['!fixar', '!desfixar', '!pin', '!unpin'].includes(firstWord)) {
        if (!isGroup) {
            await sock.sendMessage(chatId, { text: '❌ Este comando só pode ser usado em grupos.' }, { quoted: msg });
            return;
        }
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) {
            await sock.sendMessage(chatId, { text: `❌ ${userInfo.pushName}, apenas administradores podem fixar/desfixar mensagens.` }, { quoted: msg });
            return;
        }
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        if (!contextInfo?.stanzaId) {
            await sock.sendMessage(chatId, {
                text: `📌 *COMO FIXAR MENSAGENS:*\n\nResponda à mensagem que deseja fixar no topo do grupo e envie: \`!fixar\`\n\n_Para remover a mensagem fixada, responda com:_ \`!desfixar\``
            }, { quoted: msg });
            return;
        }
        const targetKey = {
            remoteJid: chatId,
            id: contextInfo.stanzaId,
            participant: contextInfo.participant
        };
        const isUnpin = firstWord === '!desfixar' || firstWord === '!unpin';
        try {
            let durationSeconds = 604800;
            const subArg = text.slice(firstWord.length).trim().toLowerCase();
            if (subArg === '24h' || subArg === '1d') durationSeconds = 86400;
            if (subArg === '30d' || subArg === '1m') durationSeconds = 2592000;
            await sock.sendMessage(chatId, {
                pin: targetKey as any,
                type: isUnpin ? 2 : 1,
                time: isUnpin ? undefined : durationSeconds
            } as any);
            await sock.sendMessage(chatId, {
                text: isUnpin ? `📌 *Mensagem desfixada com sucesso do topo do grupo.*` : `📌 *MENSAGEM FIXADA COM SUCESSO NO TOPO DO GRUPO!*`
            }, { quoted: msg });
            console.log(`[FIXAR] Mensagem ${targetKey.id} ${isUnpin ? 'desfixada' : 'fixada'} no grupo ${chatId}`);
        } catch (e: any) {
            console.error('[ERRO FIXAR MENSAGEM]', e.message);
            await sock.sendMessage(chatId, {
                text: '❌ Erro ao fixar mensagem. Verifique se o bot é Administrador do grupo.'
            }, { quoted: msg });
        }
        return;
    }

    // !remove / !apagar / !del
    if (['!remove', '!apagar', '!deletar', '!del'].includes(firstWord)) {
        if (!isGroup) {
            await sock.sendMessage(chatId, { text: '❌ Este comando só pode ser usado em grupos.' }, { quoted: msg });
            return;
        }
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) {
            await sock.sendMessage(chatId, { text: `❌ ${userInfo.pushName}, apenas administradores podem apagar mensagens do grupo.` }, { quoted: msg });
            return;
        }
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        if (!contextInfo?.stanzaId) {
            await sock.sendMessage(chatId, {
                text: `🗑️ *COMO APAGAR MENSAGENS:*\n\nResponda à mensagem que deseja apagar no grupo digitando: \`!remove\` (ou \`!apagar\` / \`!del\`)`
            }, { quoted: msg });
            return;
        }
        const targetKey = {
            remoteJid: chatId,
            id: contextInfo.stanzaId,
            participant: contextInfo.participant
        };
        try {
            await sock.sendMessage(chatId, { delete: targetKey });
            try { await sock.sendMessage(chatId, { delete: key }); } catch (e) { }
            console.log(`[REMOVE] Mensagem ${targetKey.id} apagada com sucesso por ${userInfo.pushName}`);
        } catch (e: any) {
            console.error('[ERRO REMOVER MENSAGEM]', e.message);
            await sock.sendMessage(chatId, {
                text: '❌ Não foi possível apagar a mensagem. Verifique se o bot é Administrador do grupo.'
            }, { quoted: msg });
        }
        return;
    }

    // !todos / !all
    if (['!todos', '!all', '!marcartodos'].includes(firstWord)) {
        if (!isGroup) {
            await sock.sendMessage(chatId, { text: '❌ Este comando só pode ser usado em grupos.' }, { quoted: msg });
            return;
        }
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) {
            await sock.sendMessage(chatId, { text: `❌ ${userInfo.pushName}, apenas administradores podem marcar todos os integrantes.` }, { quoted: msg });
            return;
        }
        const customMsg = text.slice(firstWord.length).trim();
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        const isQuotingMessage = !!(contextInfo && contextInfo.quotedMessage);
        try {
            const groupMeta = await sock.groupMetadata(chatId);
            const participants = groupMeta.participants || [];
            const participantsJids = participants.map(p => p.id);
            const quoteTarget = isQuotingMessage ? {
                key: {
                    remoteJid: chatId,
                    id: contextInfo.stanzaId,
                    participant: contextInfo.participant
                },
                message: contextInfo.quotedMessage
            } : msg;
            if (isQuotingMessage && !customMsg) {
                await sock.sendMessage(chatId, { text: `📢 @todos @all`, mentions: participantsJids }, { quoted: quoteTarget as any });
            } else if (isQuotingMessage && customMsg) {
                await sock.sendMessage(chatId, { text: `*${customMsg}*\n\n📢 @todos @all`, mentions: participantsJids }, { quoted: quoteTarget as any });
            } else if (customMsg) {
                let alertText = `📢 *CHAMADA GERAL DO GRUPO* 📢\n\n` +
                    `📝 *Mensagem:*\n${customMsg}\n\n` +
                    `👤 *Chamado por:* ${userInfo.fullDisplay}\n` +
                    `📢 @todos @all`;
                await sock.sendMessage(chatId, { text: alertText, mentions: participantsJids });
            } else {
                await sock.sendMessage(chatId, {
                    text: `📢 @todos @all\n\n👤 *Chamado por:* ${userInfo.fullDisplay}`,
                    mentions: participantsJids
                });
            }
            console.log(`[!TODOS] ${participantsJids.length} membros marcados no grupo ${chatId} por ${userInfo.pushName}`);
        } catch (e: any) {
            console.error('[ERRO MARCAR TODOS]', e.message);
            await sock.sendMessage(chatId, { text: '❌ Erro ao marcar todos os integrantes.' }, { quoted: msg });
        }
        return;
    }

    // !megafone
    if (firstWord === '!megafone') {
        if (!isGroup) {
            await sock.sendMessage(chatId, { text: '❌ Este comando só pode ser usado em grupos.' }, { quoted: msg });
            return;
        }
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) {
            await sock.sendMessage(chatId, { text: `❌ ${userInfo.pushName}, apenas administradores podem usar o megafone.` }, { quoted: msg });
            return;
        }
        let announcementText = '';
        if (text.includes('+')) announcementText = text.slice(text.indexOf('+') + 1).trim();
        else announcementText = text.slice(firstWord.length).trim();
        if (!announcementText) {
            await sock.sendMessage(chatId, { text: `⚠️ *FORMATO INCORRETO!*\n\nEnvie:\n\`!megafone + Digite aqui o comunicado importante\`` }, { quoted: msg });
            return;
        }
        try {
            await sock.groupSettingUpdate(chatId, 'announcement');
            const megaUpperText = announcementText.toUpperCase();
            const groupMeta = await sock.groupMetadata(chatId).catch(() => null);
            const participantsJids = groupMeta?.participants?.map(p => p.id) || [];
            const megaMsg = `📢 *MEGAFONE ADMINISTRATIVO* 📢\n\n` +
                `*${megaUpperText}*\n\n` +
                `👤 *Anunciado por:* ${userInfo.pushName} (${userInfo.formattedNum})\n` +
                `📢 @todos @all`;
            await sock.sendMessage(chatId, { text: megaMsg, mentions: participantsJids });
            setTimeout(async () => {
                try {
                    await sock.groupSettingUpdate(chatId, 'not_announcement');
                    await sock.sendMessage(chatId, { text: '🔓 *Grupo reaberto para mensagens de todos os integrantes.*' });
                } catch (e) { }
            }, 3000);
        } catch (err: any) {
            console.error('[ERRO MEGAFONE]', err.message);
            await sock.sendMessage(chatId, { text: '❌ Erro ao disparar o megafone.' });
        }
        return;
    }

    // !abrir / !fechar
    if (firstWord === '!abrir' || firstWord === '!fechar') {
        if (!isGroup) {
            await sock.sendMessage(chatId, { text: '❌ Este comando só pode ser usado em grupos.' }, { quoted: msg });
            return;
        }
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) {
            await sock.sendMessage(chatId, { text: `❌ ${userInfo.pushName}, apenas administradores podem abrir/fechar o grupo.` }, { quoted: msg });
            return;
        }
        let arg = '';
        if (text.includes('+')) arg = text.slice(text.indexOf('+') + 1).trim().toLowerCase();
        else arg = text.slice(firstWord.length).trim().toLowerCase();
        if (arg === 'off') {
            if (!storage.data.groupSchedules) storage.data.groupSchedules = {};
            if (!storage.data.groupSchedules[chatId]) storage.data.groupSchedules[chatId] = { openTime: '', closeTime: '' };
            if (firstWord === '!abrir') {
                delete storage.data.groupSchedules[chatId].openTime;
                storage.flagSave();
                await sock.sendMessage(chatId, { text: '🛑 *Horário de abertura automática diária desativado.*' });
            } else {
                delete storage.data.groupSchedules[chatId].closeTime;
                storage.flagSave();
                await sock.sendMessage(chatId, { text: '🛑 *Horário de fechamento automático diário desativado.*' });
            }
            return;
        }
        const timeMatch = arg.match(/^([01]?[0-9]|2[0-3]):([0-5][0-9])$/);
        if (timeMatch) {
            const formattedTime = `${String(parseInt(timeMatch[1])).padStart(2, '0')}:${timeMatch[2]}`;
            if (!storage.data.groupSchedules) storage.data.groupSchedules = {};
            if (!storage.data.groupSchedules[chatId]) storage.data.groupSchedules[chatId] = { openTime: '', closeTime: '' };
            if (firstWord === '!abrir') {
                storage.data.groupSchedules[chatId].openTime = formattedTime;
                storage.flagSave();
                await sock.sendMessage(chatId, { text: `⏰ *ABERTURA AUTOMÁTICA DIÁRIA:* Todos os dias às *${formattedTime}*.` });
            } else {
                storage.data.groupSchedules[chatId].closeTime = formattedTime;
                storage.flagSave();
                await sock.sendMessage(chatId, { text: `⏰ *FECHAMENTO AUTOMÁTICO DIÁRIO:* Todos os dias às *${formattedTime}*.` });
            }
            return;
        }
        try {
            const isLock = firstWord === '!fechar';
            await sock.groupSettingUpdate(chatId, isLock ? 'announcement' : 'not_announcement');
            storage.setGroupClosed(chatId, isLock);
            await sock.sendMessage(chatId, {
                text: isLock ? `🔒 *GRUPO FECHADO (SOMENTE ADMINISTRADORES FALAM)*\n\n_O bot entrará em silêncio e não enviará memes, mensagens de inatividade ou intervenções automáticas enquanto o grupo estiver fechado._` : `🔓 *GRUPO ABERTO PARA TODOS OS MEMBROS!*`
            });
        } catch (e) {
            await sock.sendMessage(chatId, { text: '❌ Falha ao alterar permissão do grupo.' });
        }
        return;
    }

    // !status / !painel
    if (['!status', '!painel'].includes(firstWord)) {
        if (!isGroup) {
            await sock.sendMessage(chatId, { text: '❌ Este comando só pode ser usado em grupos.' }, { quoted: msg });
            return;
        }
        let panelMsg = `📊 *PAINEL DE CONTROLE JARVIS - BOT2.0*\n\n`;
        const uniqueKeys = Array.from(new Set(Object.values(FEATURE_MAP)));
        uniqueKeys.forEach(k => {
            const disabled = storage.isFeatureDisabled(chatId, k);
            panelMsg += `${disabled ? '🔴 [DESLIGADO]' : '🟢 [LIGADO]'} ${FEATURE_NAMES[k] || k}\n`;
        });
        const sched = storage.data.groupSchedules?.[chatId];
        if (sched && (sched.openTime || sched.closeTime)) {
            panelMsg += `\n⏰ *Horários Diários de Abertura/Fechamento:*\n`;
            if (sched.openTime) panelMsg += `• Abertura: ${sched.openTime}\n`;
            if (sched.closeTime) panelMsg += `• Fechamento: ${sched.closeTime}\n`;
        }
        const promo = storage.data.promoSchedule?.[chatId];
        if (promo && promo.active) {
            panelMsg += `\n📢 *Divulgação Programada:* das ${promo.startTime} às ${promo.endTime}\n`;
        }
        const clusterCount = storage.data.memoryCluster?.[chatId]?.length || 0;
        panelMsg += `\n🧠 *Memória Ativa (30min):* ${clusterCount} mensagens no cluster.\n`;
        panelMsg += `💡 *Como alterar?*\nEnvie \`!comando off\` ou \`!comando on\`.`;
        await sock.sendMessage(chatId, { text: panelMsg, mentions: [userInfo.jid] });
        return;
    }

    // !id
    if (text.toLowerCase() === '!id') {
        const role = getUserRole(userId, storage.data.users);
        const roleNames: Record<string, string> = {
            '5': 'Super Administrador 👑', '4': 'Administrador Gestor 🛡️', '3': 'Administrador Parceiro 🤝',
            '2': 'Administrador de Grupo ⭐', '1': 'Acesso Especial 🎵', '0': 'Usuário Comum 👤'
        };
        const replyMsg = `👤 *IDENTIFICAÇÃO DE USUÁRIO*\n\n📱 *Número:* ${userInfo.formattedNum}\n🏷️ *Nome no Perfil:* ${userInfo.pushName}\n👑 *Patente / Nível:* Nível ${role} (${roleNames[role] || 'Desconhecido'})`;
        await sock.sendMessage(chatId, { text: replyMsg, mentions: [userInfo.jid] });
        return;
    }

    // !cadastro
    if (text.toLowerCase().startsWith('!cadastro')) {
        if (!isSuperAdmin(userId, storage.data.users)) return;
        if (text.includes('+')) {
            const partes = text.split('+');
            if (partes.length === 3) {
                const targetId = partes[1].trim().replace(/\D/g, '');
                const targetRole = partes[2].trim();
                if (!['0', '1', '2', '3', '4', '5'].includes(targetRole)) {
                    await sock.sendMessage(chatId, { text: '❌ Nível inválido (0 a 5).' }, { quoted: msg });
                    return;
                }
                storage.data.users[targetId] = targetRole;
                storage.flagSave();
                const targetInfo = getUserInfo(`${targetId}@s.whatsapp.net`);
                await sock.sendMessage(chatId, {
                    text: `✅ *Privilégio Concedido!*\n\n👤 *Usuário:* ${targetInfo.pushName}\n📱 *Número:* ${targetInfo.formattedNum}\n👑 *Nova Patente:* Nível ${targetRole}`,
                    mentions: [targetInfo.jid]
                });
                return;
            }
        }
        storage.data.states[userId] = { mode: 'cadastro_waiting_id' };
        storage.flagSave();
        await sock.sendMessage(chatId, { text: 'Qual o número de telefone do usuário que deseja cadastrar? (Ex: 5511999998888)' });
        return;
    }

    if (state && state.mode === 'cadastro_waiting_id') {
        const targetId = text.replace(/\D/g, '');
        if (!targetId) {
            await sock.sendMessage(chatId, { text: '❌ Número inválido.' });
            return;
        }
        state.mode = 'cadastro_waiting_role';
        state.targetId = targetId;
        storage.flagSave();
        await sock.sendMessage(chatId, { text: 'Qual nível de permissão? (1 a 5)' });
        return;
    }

    if (state && state.mode === 'cadastro_waiting_role') {
        const targetRole = text.trim();
        if (!['1', '2', '3', '4', '5'].includes(targetRole)) {
            await sock.sendMessage(chatId, { text: '❌ Nível inválido. Escolha de 1 a 5.' });
            return;
        }
        storage.data.users[state.targetId] = targetRole;
        delete storage.data.states[userId];
        storage.flagSave();
        const targetInfo = getUserInfo(`${state.targetId}@s.whatsapp.net`);
        await sock.sendMessage(chatId, {
            text: `✅ *Privilégio Concedido!*\n\n👤 *Usuário:* ${targetInfo.pushName}\n📱 *Número:* ${targetInfo.formattedNum}\n👑 *Nova Patente:* Nível ${targetRole}`,
            mentions: [targetInfo.jid]
        });
        return;
    }

    // !remover
    if (text.toLowerCase() === '!remover') {
        if (!isSuperAdmin(userId, storage.data.users)) return;
        storage.data.states[userId] = { mode: 'remover_waiting_id' };
        storage.flagSave();
        await sock.sendMessage(chatId, { text: 'Qual o número de telefone do usuário que deseja remover?' });
        return;
    }

    if (state && state.mode === 'remover_waiting_id') {
        const targetId = text.replace(/\D/g, '');
        let foundKey: string | null = null;
        for (const dbNum of Object.keys(storage.data.users)) {
            if (checkMatch(dbNum, targetId)) { foundKey = dbNum; break; }
        }
        const targetInfo = getUserInfo(`${targetId}@s.whatsapp.net`);
        if (foundKey) delete storage.data.users[foundKey];
        delete storage.data.states[userId];
        storage.flagSave();
        await sock.sendMessage(chatId, {
            text: `✅ *Usuário Removido:* ${targetInfo.pushName} (${targetInfo.formattedNum}) voltou ao Nível 0.`,
            mentions: [targetInfo.jid]
        });
        return;
    }

    // !warn / !warns / !unwarn
    if (['!warn', '!advertir', '!warns', '!advertencias', '!unwarn'].includes(firstWord)) {
        if (!isGroup) {
            await sock.sendMessage(chatId, { text: '❌ Este comando só pode ser usado em grupos.' }, { quoted: msg });
            return;
        }
        if (!storage.data.warnings[chatId]) storage.data.warnings[chatId] = {};
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        const targetJid = contextInfo?.participant || (text.match(/@(\d+)/)?.[1] ? text.match(/@(\d+)/)![1] + '@s.whatsapp.net' : '');
        const targetNum = targetJid ? targetJid.split('@')[0] : userInfo.number;
        const targetInfo = getUserInfo(targetJid || sender);

        if (firstWord === '!warns' || firstWord === '!advertencias') {
            const warns = storage.data.warnings[chatId][targetNum] || 0;
            const limit = storage.data.maxWarnings[chatId] || 2;
            await sock.sendMessage(chatId, {
                text: `⚠️ *STATUS DE ADVERTÊNCIAS*\n\n👤 *Membro:* ${targetInfo.mentionTag} (*${targetInfo.pushName}*)\n📱 *Número:* ${targetInfo.formattedNum}\n📊 *Advertências:* ${warns}/${limit}`,
                mentions: [targetInfo.jid]
            });
            return;
        }

        if (firstWord === '!unwarn') {
            if (!targetJid) {
                await sock.sendMessage(chatId, { text: '❌ Responda à mensagem do membro ou marque-o para remover a advertência.' }, { quoted: msg });
                return;
            }
            if (storage.data.warnings[chatId][targetNum] && storage.data.warnings[chatId][targetNum] > 0) {
                storage.data.warnings[chatId][targetNum]--;
                storage.flagSave();
                const limit = storage.data.maxWarnings[chatId] || 2;
                await sock.sendMessage(chatId, {
                    text: `✅ *Advertência removida de ${targetInfo.mentionTag} (${targetInfo.pushName})!*\n📊 *Status atual:* ${storage.data.warnings[chatId][targetNum]}/${limit}`,
                    mentions: [targetInfo.jid]
                });
                return;
            }
            await sock.sendMessage(chatId, { text: `ℹ️ O membro *${targetInfo.pushName}* (${targetInfo.formattedNum}) não possui advertências.` });
            return;
        }

        if (firstWord === '!warn' || firstWord === '!advertir') {
            if (!targetJid) {
                await sock.sendMessage(chatId, { text: '❌ Responda à mensagem do membro ou marque-o com *@número* para advertir.' }, { quoted: msg });
                return;
            }
            const reason = text.replace(firstWord, '').replace(/@\d+/, '').trim() || 'Violação das regras do grupo';
            await storage.applyWarning(sock, chatId, targetJid, reason, 2);
            return;
        }
    }

    // !ban / !kick
    if (firstWord === '!ban' || firstWord === '!kick') {
        if (!isGroup) return;
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) {
            await sock.sendMessage(chatId, { text: `❌ ${userInfo.pushName}, apenas administradores podem remover membros.` }, { quoted: msg });
            return;
        }
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        const targetJid = contextInfo?.participant || (text.match(/@(\d+)/)?.[1] ? text.match(/@(\d+)/)![1] + '@s.whatsapp.net' : '');
        if (!targetJid) {
            await sock.sendMessage(chatId, { text: '❌ Responda à mensagem ou mencione o membro com *@número* para remover.' }, { quoted: msg });
            return;
        }
        try {
            const groupMeta = await sock.groupMetadata(chatId);
            const targetParticipant = groupMeta.participants.find(p => p.id === targetJid || checkMatch(p.id.split('@')[0], targetJid.split('@')[0]));
            if (!targetParticipant) {
                await sock.sendMessage(chatId, { text: '⚠️ O membro não foi localizado na lista de participantes deste grupo.' });
                return;
            }
            if (targetParticipant.admin === 'admin' || targetParticipant.admin === 'superadmin') {
                await sock.sendMessage(chatId, { text: '⚠️ O WhatsApp não permite que o bot remova outro Administrador do grupo.' });
                return;
            }
            const targetInfo = getUserInfo(targetParticipant.id);
            await sock.groupParticipantsUpdate(chatId, [targetParticipant.id], 'remove');
            await sock.sendMessage(chatId, {
                text: `Xiii, acho que o integrante ${targetInfo.mentionTag} (*${targetInfo.pushName}* - ${targetInfo.formattedNum}) fez algo de errado, pois foi removido!`,
                mentions: [targetInfo.jid]
            });
        } catch (e: any) {
            console.error('[ERRO BAN/KICK]', e.message);
            await sock.sendMessage(chatId, { text: '❌ Não foi possível remover o participante.' });
        }
        return;
    }

    // !rank / !top
    if (['!rank', '!top'].includes(firstWord)) {
        if (!isGroup) {
            await sock.sendMessage(chatId, { text: '❌ Este comando só pode ser usado em grupos.' }, { quoted: msg });
            return;
        }
        const stats = storage.data.groupStats[chatId];
        if (!stats || Object.keys(stats).length === 0) {
            await sock.sendMessage(chatId, { text: 'ℹ️ Ainda não há dados de engajamento registrados.' }, { quoted: msg });
            return;
        }
        const sorted = Object.keys(stats).sort((a, b) => stats[b].total - stats[a].total).slice(0, 10);
        const medals = ['🥇', '🥈', '🥉', '4º', '5º', '6º', '7º', '8º', '9º', '10º'];
        let rankMsg = `🏆 *RANKING DE ENGAJAMENTO DO GRUPO*\n\n`;
        sorted.forEach((num, i) => {
            const uInfo = getUserInfo(`${num}@s.whatsapp.net`);
            rankMsg += `${medals[i]} *${uInfo.pushName}* (${uInfo.formattedNum}) — ${stats[num].total} msgs (${stats[num].text} textos | ${stats[num].media} mídias)\n`;
        });
        await sock.sendMessage(chatId, { text: rankMsg });
        return;
    }

    // !m
    if (text.toLowerCase() === '!m') {
        if (!isGroup) {
            await sock.sendMessage(chatId, { text: '❌ Este comando só pode ser usado em grupos.' }, { quoted: msg });
            return;
        }
        const stats = storage.data.groupStats[chatId];
        if (!stats || Object.keys(stats).length === 0) {
            await sock.sendMessage(chatId, { text: 'ℹ️ Ainda não há tráfego de mensagens registrado neste grupo.' }, { quoted: msg });
            return;
        }
        const sorted = Object.keys(stats).sort((a, b) => stats[b].total - stats[a].total).slice(0, 30);
        let report = `📊 *MÉTRICAS DE TRÁFEGO ACUMULADAS*\n\n`;
        sorted.forEach((authorNum, index) => {
            const s = stats[authorNum];
            const uInfo = getUserInfo(`${authorNum}@s.whatsapp.net`);
            report += `${index + 1}º 👉 *@${authorNum}* — *${uInfo.pushName}* (${uInfo.formattedNum})\n💬 Texto: ${s.text} | 🖼️ Mídia: ${s.media} | 📈 Total: ${s.total}\n\n`;
        });
        const mentionsArr = sorted.map(num => `${num}@s.whatsapp.net`);
        await sock.sendMessage(chatId, { text: report, mentions: mentionsArr });
        return;
    }

    // !sorteio
    if (firstWord === '!sorteio') {
        if (!isGroup) {
            await sock.sendMessage(chatId, { text: '❌ Este comando só pode ser usado em grupos.' }, { quoted: msg });
            return;
        }
        try {
            const groupMeta = await sock.groupMetadata(chatId);
            const participants = groupMeta.participants;
            if (!participants || participants.length === 0) {
                await sock.sendMessage(chatId, { text: '❌ Não foi possível carregar os participantes.' }, { quoted: msg });
                return;
            }
            const winner = participants[Math.floor(Math.random() * participants.length)];
            const winnerInfo = getUserInfo(winner.id);
            await sock.sendMessage(chatId, {
                text: `🎲 *SORTEIO REALIZADO COM SUCESSO!*\n\n🏆 *Ganhador(a):* ${winnerInfo.mentionTag} (*${winnerInfo.pushName}*)\n📱 *Número:* ${winnerInfo.formattedNum}\n\n_Parabéns!_`,
                mentions: [winnerInfo.jid]
            });
        } catch (e) {
            await sock.sendMessage(chatId, { text: '❌ Erro ao realizar sorteio.' });
        }
        return;
    }

    // !inativosmsg
    if (['!inativosmsg', '!msginativos'].includes(firstWord)) {
        if (!isGroup) {
            await sock.sendMessage(chatId, { text: '❌ Este comando só pode ser usado em grupos.' }, { quoted: msg });
            return;
        }
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) {
            await sock.sendMessage(chatId, { text: `❌ ${userInfo.pushName}, apenas administradores podem configurar a mensagem de inativos.` }, { quoted: msg });
            return;
        }
        let customText = '';
        if (text.includes('+')) customText = text.slice(text.indexOf('+') + 1).trim();
        else customText = text.slice(firstWord.length).trim();
        if (!customText) {
            const currentMsg = storage.data.inativosMsgs?.[chatId]?.text;
            let info = `🧹 *MENSAGEM PÓS-LIMPEZA DE INATIVOS*\n\n`;
            if (currentMsg) info += `📝 *Mensagem Atual Cadastrada:*\n"${currentMsg}"\n\n`;
            else info += `ℹ️ Nenhuma mensagem personalizada cadastrada para este grupo (usando mensagem padrão).\n\n`;
            info += `*Como definir uma nova mensagem:*\n` +
                `\`!inativosmsg + [Sua mensagem personalizada aqui]\`\n\n` +
                `_Exemplo:_\n\`!inativosmsg + Pessoal, acabamos de fazer uma limpeza de inativos! Quem não interagir será removido nas próximas limpezas.\``;
            await sock.sendMessage(chatId, { text: info }, { quoted: msg });
            return;
        }
        if (!storage.data.inativosMsgs) storage.data.inativosMsgs = {};
        storage.data.inativosMsgs[chatId] = {
            text: customText,
            setBy: userId,
            date: new Date().toISOString()
        };
        storage.flagSave();
        await sock.sendMessage(chatId, {
            text: `✅ *MENSAGEM DE PÓS-LIMPEZA DEFINIDA COM SUCESSO!*\n\n` +
                `Sempre que o comando \`!inativos\` for acionado, os membros inativos serão removidos e o bot disparará:\n\n` +
                `"${customText}"`
        }, { quoted: msg });
        return;
    }

    // =====================================================================
    // !inativos / !fantasmas (CORRIGIDO: resolve nome/número + persiste mapas)
    // =====================================================================
    if (['!inativos', '!fantasmas'].includes(firstWord)) {
        if (!isGroup) {
            await sock.sendMessage(chatId, { text: '❌ Este comando só pode ser usado em grupos.' }, { quoted: msg });
            return;
        }
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) {
            await sock.sendMessage(chatId, { text: `❌ ${userInfo.pushName}, apenas administradores podem executar a limpeza de inativos.` }, { quoted: msg });
            return;
        }

        try {
            // CORREÇÃO: restaura mapas persistidos (sobrevive a reinícios)
            const persisted = storage.data.cache?.contacts;
            if (persisted) {
                if (persisted.lidMap) Object.assign(lidMap, persisted.lidMap);
                if (persisted.contactCache) Object.assign(contactCache, persisted.contactCache);
            }

            const groupMeta = await sock.groupMetadata(chatId);
            const participants = groupMeta.participants || [];
            const stats = storage.data.groupStats[chatId] || {};

            // CORREÇÃO: atualiza mapas LID->número e nomes
            updateLidMapping(participants);

            const botId = sock.user?.id || '';
            const rawBotNum = botId.split('@')[0].split(':')[0].replace(/\D/g, '');

            const inactiveList: any[] = [];

            for (const p of participants) {
                const isAdm = p.admin === 'admin' || p.admin === 'superadmin';
                if (isAdm) continue;

                const pIdRaw = p.id || '';
                const pLidRaw = (p as any).lid || '';
                const pIdClean = pIdRaw.split('@')[0].split(':')[0].replace(/\D/g, '');
                const pLidClean = pLidRaw.split('@')[0].split(':')[0].replace(/\D/g, '');

                if (
                    (rawBotNum && (checkMatch(rawBotNum, pIdClean) || checkMatch(rawBotNum, pLidClean))) ||
                    (botId && pIdRaw && pIdRaw.startsWith(botId.split(':')[0]))
                ) {
                    continue;
                }

                const realPhoneNum = pIdRaw.endsWith('@s.whatsapp.net')
                    ? pIdClean
                    : (lidMap[pIdClean] || lidMap[pLidClean] || '');

                const pNum = realPhoneNum || pIdClean;

                if (checkMatch('5511927018683', pNum) || checkMatch(RBAC.superAdmin, pNum)) {
                    continue;
                }

                const hasActivity = (stats[pNum] && stats[pNum].total > 0) || (realPhoneNum && stats[realPhoneNum] && stats[realPhoneNum].total > 0);
                if (!hasActivity) {
                    // CORREÇÃO: resolve nome por múltiplas fontes
                    const pName =
                        (p as any).name || (p as any).notify || (p as any).verifiedName ||
                        contactCache[pNum]?.name || contactCache[pIdClean]?.name || contactCache[pLidClean]?.name ||
                        storage.data.cache?.names?.[pNum] || storage.data.cache?.names?.[pIdClean] || '';

                    const queryJid = realPhoneNum ? `${realPhoneNum}@s.whatsapp.net` : pIdRaw;
                    const uInfo = getUserInfo(queryJid, pName);
                    inactiveList.push({ ...uInfo, removeJid: pIdRaw });
                }
            }

            // CORREÇÃO: persiste mapas atuais para próximas consultas
            if (!storage.data.cache) storage.data.cache = {};
            storage.data.cache.contacts = { lidMap: { ...lidMap }, contactCache: { ...contactCache } };
            storage.flagSave();

            if (inactiveList.length === 0) {
                await sock.sendMessage(chatId, {
                    text: `👏 *Excelente!* Nenhum integrante inativo encontrado neste grupo. Todos os membros participaram das conversas!`
                }, { quoted: msg });
                return;
            }

            storage.data.states[userId] = {
                mode: 'inativos_confirm_removal',
                targetChat: chatId,
                inactiveList: inactiveList,
                date: Date.now()
            };
            storage.flagSave();

            let listReport = `👻 *MEMBROS INATIVOS / FANTASMAS (${inactiveList.length})* 👻\n` +
                `🏢 *Grupo:* ${groupMeta.subject}\n\n`;

            inactiveList.forEach((u, idx) => {
                listReport += `${idx + 1} - ${u.nameAndNumber}\n`;
            });

            listReport += `\n⚠️ *Deseja remover todos os ${inactiveList.length} integrantes listados?*\n` +
                `👉 Responda: *SIM* (ou 1) / *NÃO* (ou 2)\n` +
                `_(Para cancelar, envie: !cancelar)_`;

            await sock.sendMessage(chatId, { text: listReport }, { quoted: msg });
        } catch (e: any) {
            console.error('[ERRO VARREDURA INATIVOS]', e.message);
            await sock.sendMessage(chatId, { text: '❌ Erro ao analisar inatividade do grupo.' });
        }
        return;
    }

    // !s / !sticker / !figurinha
    if (['!s', '!sticker', '!figurinha'].includes(firstWord)) {
        try {
            const targetMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage ? {
                key: {
                    remoteJid: chatId,
                    id: msg.message.extendedTextMessage.contextInfo.stanzaId,
                    participant: msg.message.extendedTextMessage.contextInfo.participant
                },
                message: msg.message.extendedTextMessage.contextInfo.quotedMessage
            } : msg;
            const isMedia = targetMsg.message?.imageMessage || targetMsg.message?.videoMessage;
            if (!isMedia) {
                await sock.sendMessage(chatId, { text: `❌ ${userInfo.pushName}, envie ou responda a uma imagem/vídeo com *!s* para criar uma figurinha!` }, { quoted: msg });
                return;
            }
            await sock.sendMessage(chatId, { text: `🎨 ${userInfo.pushName}, criando figurinha...` }, { quoted: msg });
            const mediaBuffer = await downloadMediaMessage(targetMsg as any, 'buffer', {});
            if (!mediaBuffer) {
                await sock.sendMessage(chatId, { text: '❌ Não foi possível baixar a mídia.' }, { quoted: msg });
                return;
            }
            const stickerBuffer = await imageToStickerBuffer(mediaBuffer);
            await sock.sendMessage(chatId, { sticker: stickerBuffer }, { quoted: msg });
        } catch (err: any) {
            await sock.sendMessage(chatId, { text: '❌ Erro ao converter mídia em figurinha.' }, { quoted: msg });
        }
        return;
    }

    // !s2img
    if (['!s2img', '!baixarfig', '!fig'].includes(firstWord)) {
        try {
            const targetMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage ? {
                key: {
                    remoteJid: chatId,
                    id: msg.message.extendedTextMessage.contextInfo.stanzaId,
                    participant: msg.message.extendedTextMessage.contextInfo.participant
                },
                message: msg.message.extendedTextMessage.contextInfo.quotedMessage
            } : msg;
            const isSticker = targetMsg.message?.stickerMessage;
            if (!isSticker) {
                await sock.sendMessage(chatId, { text: `❌ ${userInfo.pushName}, responda a uma figurinha com *!s2img* para extrair a imagem!` }, { quoted: msg });
                return;
            }
            await sock.sendMessage(chatId, { text: `🖼️ ${userInfo.pushName}, extraindo imagem da figurinha...` }, { quoted: msg });
            const stickerMediaBuffer = await downloadMediaMessage(targetMsg as any, 'buffer', {});
            if (!stickerMediaBuffer) {
                await sock.sendMessage(chatId, { text: '❌ Não foi possível extrair a imagem.' }, { quoted: msg });
                return;
            }
            const imageBuffer = await stickerToImageBuffer(stickerMediaBuffer);
            await sock.sendMessage(chatId, { image: imageBuffer, caption: '🖼️ Imagem extraída com sucesso!' }, { quoted: msg });
        } catch (err: any) {
            await sock.sendMessage(chatId, { text: '❌ Erro ao extrair figurinha.' }, { quoted: msg });
        }
        return;
    }

    // !n
    if (text.toLowerCase() === '!n') {
        storage.data.states[userId] = { mode: 'news_menu' };
        storage.flagSave();
        const menuN = `📰 *MENU DE NOTÍCIAS* 📰\n\n1 - Notícias Globais\n2 - Notícias Regionais\n3 - Notícias por Tópicos\n\n👉 ${userInfo.pushName}, responda com o número (1 a 3).`;
        await sock.sendMessage(chatId, { text: menuN, mentions: [userInfo.jid] });
        return;
    }
    if (state && state.mode === 'news_menu') {
        if (text === '1') {
            delete storage.data.states[userId];
            storage.flagSave();
            const newsData = await fetchNews('Mundo OR Internacional', 6);
            await sock.sendMessage(chatId, { text: `🌍 *Principais Notícias Globais de Hoje*\n\n${newsData}` });
            return;
        } else if (text === '2') {
            state.mode = 'news_city';
            storage.flagSave();
            await sock.sendMessage(chatId, { text: `🏙️ ${userInfo.pushName}, qual é a sua *Cidade & Estado*? (Ex: Rio de Janeiro, RJ)` });
            return;
        } else if (text === '3') {
            state.mode = 'news_topics_menu';
            storage.flagSave();
            let topicsMenu = `📋 *ESCOLHA O TÓPICO DE NOTÍCIAS*\n\n`;
            for (const [key, value] of Object.entries(NEWS_TOPICS)) topicsMenu += `${key} - ${value.name}\n`;
            await sock.sendMessage(chatId, { text: topicsMenu });
            return;
        }
    }
    if (state && state.mode === 'news_city') {
        const region = text;
        delete storage.data.states[userId];
        storage.flagSave();
        const newsData = await fetchNews(region, 5);
        await sock.sendMessage(chatId, { text: `📍 *Notícias Locais: ${region.toUpperCase()}*\n\n${newsData}` });
        return;
    }
    if (state && state.mode === 'news_topics_menu') {
        const topicObj = NEWS_TOPICS[text];
        if (!topicObj) return;
        delete storage.data.states[userId];
        storage.flagSave();
        const newsData = await fetchNews(topicObj.query, 5);
        await sock.sendMessage(chatId, { text: `📌 *Notícias: ${topicObj.name.toUpperCase()}*\n\n${newsData}` });
        return;
    }

    // !h
    if (text.toLowerCase() === '!h') {
        storage.data.states[userId] = { mode: 'horoscope_menu' };
        storage.flagSave();
        const menuH = `✨ *MENU DE HORÓSCOPO* ✨\n\n1 - Todos os signos hoje\n2 - Seu signo hoje\n\n👉 ${userInfo.pushName}, responda com *1* ou *2*.`;
        await sock.sendMessage(chatId, { text: menuH, mentions: [userInfo.jid] });
        return;
    }
    if (state && state.mode === 'horoscope_menu') {
        const currentDate = new Date().toLocaleDateString('pt-BR');
        if (text === '1') {
            delete storage.data.states[userId];
            storage.flagSave();
            let report = `✨ *HORÓSCOPO GERAL - ${currentDate}* ✨\n\n`;
            const promises = SIGNS.map(async (s) => {
                const data = await fetchHoroscope(s.name, false);
                return `${s.emoji} *${s.name}* (${s.dates}):\n_${data}_\n\n`;
            });
            const results = await Promise.all(promises);
            report += results.join('');
            await sock.sendMessage(chatId, { text: report });
            return;
        } else if (text === '2') {
            state.mode = 'horoscope_sign';
            storage.flagSave();
            let signMenu = `🔮 *ESCOLHA O SEU SIGNO* 🔮\n\n`;
            SIGNS.forEach(s => { signMenu += `${s.id} - ${s.emoji} ${s.name} _(${s.dates})_\n`; });
            await sock.sendMessage(chatId, { text: signMenu });
            return;
        }
    }
    if (state && state.mode === 'horoscope_sign') {
        const currentDate = new Date().toLocaleDateString('pt-BR');
        const signId = parseInt(text, 10);
        const selectedSign = SIGNS.find(s => s.id === signId);
        if (!selectedSign) return;
        delete storage.data.states[userId];
        storage.flagSave();
        const webData = await fetchHoroscope(selectedSign.name, true);
        const reply = `✨ *Horóscopo de ${selectedSign.emoji} ${selectedSign.name}* (${selectedSign.dates}):\n\n${webData}\n\n📅 *(Previsões de ${currentDate})*`;
        await sock.sendMessage(chatId, { text: reply });
        return;
    }

    // !t
    if (text.toLowerCase() === '!t') {
        storage.data.states[userId] = { mode: 'weather_menu' };
        storage.flagSave();
        const menuT = `🌤️ *MENU DE CLIMA TEMPO* 🌤️\n\n1 - Previsão para hoje?\n2 - Previsão para os próximos dias?\n\n👉 ${userInfo.pushName}, responda com *1* ou *2*.`;
        await sock.sendMessage(chatId, { text: menuT, mentions: [userInfo.jid] });
        return;
    }
    if (state && state.mode === 'weather_menu') {
        if (text === '1' || text === '2') {
            state.mode = 'weather_city';
            state.weatherType = text === '1' ? 'hoje' : 'semana';
            storage.flagSave();
            await sock.sendMessage(chatId, { text: `🏙️ ${userInfo.pushName}, *qual cidade & estado?* (Ex: São Paulo, SP)` });
            return;
        }
    }
    if (state && state.mode === 'weather_city') {
        const city = text;
        const weatherType = state.weatherType;
        delete storage.data.states[userId];
        storage.flagSave();
        try {
            const res = await axios.get(`https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=pt`);
            const data = res.data;
            if (weatherType === 'hoje') {
                const current = data.current_condition[0];
                const today = data.weather[0];
                const desc = current.lang_pt ? current.lang_pt[0].value : current.weatherDesc[0].value;
                const reply = `🌤️ *Clima Agora: ${city.toUpperCase()}*\n\n*Condição:* ${desc}\n*Temperatura:* ${current.temp_C}°C (Sensação: ${current.FeelsLikeC}°C)\n*Mín/Máx:* ${today.mintempC}°C / ${today.maxtempC}°C\n*Umidade:* ${current.humidity}%`;
                await sock.sendMessage(chatId, { text: reply });
            } else {
                let reply = `📅 *Previsão (Próximos Dias): ${city.toUpperCase()}*\n\n`;
                data.weather.forEach((day: any) => {
                    const dateParts = day.date.split('-');
                    const desc = day.hourly[4].lang_pt ? day.hourly[4].lang_pt[0].value : day.hourly[4].weatherDesc[0].value;
                    reply += `*${dateParts[2]}/${dateParts[1]}:* ${day.mintempC}°C a ${day.maxtempC}°C | ${desc}\n`;
                });
                await sock.sendMessage(chatId, { text: reply });
            }
        } catch (e) {
            await sock.sendMessage(chatId, { text: `❌ Não foi possível localizar dados para "${city}".` });
        }
        return;
    }

    // !f
    if (text.toLowerCase() === '!f') {
        storage.data.states[userId] = { mode: 'football_menu' };
        storage.flagSave();
        const menuF = `⚽ *MENU DE FUTEBOL* ⚽\n\n1 - Brasileirão Série A\n2 - Copa do Brasil\n3 - Libertadores\n4 - Paulistão\n5 - Champions League\n\n👉 ${userInfo.pushName}, escolha (1-5):`;
        await sock.sendMessage(chatId, { text: menuF, mentions: [userInfo.jid] });
        return;
    }
    if (state && state.mode === 'football_menu') {
        const champObj = FOOTBALL_CHAMPIONSHIPS[text];
        if (!champObj) return;
        state.mode = 'football_query';
        state.leagueId = champObj.id;
        state.leagueName = champObj.name;
        storage.flagSave();
        await sock.sendMessage(chatId, { text: `📝 *${champObj.name}*\n\n1 - Tabela\n2 - Próximos Jogos\n3 - Artilheiros` });
        return;
    }
    if (state && state.mode === 'football_query') {
        let queryType = text === '1' ? 'standings' : text === '2' ? 'fixtures' : text === '3' ? 'topscorers' : null;
        if (!queryType) return;
        const { leagueId } = state;
        delete storage.data.states[userId];
        storage.flagSave();
        const apiResponseText = await fetchFootballData(leagueId, queryType, storage.data.cache);
        await sock.sendMessage(chatId, { text: apiResponseText });
        return;
    }

    // !r
    if (firstWord === '!r') {
        if (!isGroup) {
            await sock.sendMessage(chatId, { text: '❌ Este comando só pode ser usado em grupos.' }, { quoted: msg });
            return;
        }
        await sock.sendMessage(chatId, { text: `⏳ *Jarvis:* Analisando o fluxo de dados recente do grupo...` }, { quoted: msg });
        try {
            const cluster = storage.data.memoryCluster?.[chatId] || [];
            const clusterStrings = cluster.map(m => `${m.authorName} (+${m.authorNum}): ${m.text}`);
            const dateStrLog = new Date().toLocaleDateString('pt-BR');
            if (clusterStrings.length === 0) {
                await sock.sendMessage(chatId, { text: 'ℹ️ Nenhuma mensagem recente encontrada no cluster de memória.' });
                return;
            }
            const promptMeta =
                `Atue como assistente executivo Jarvis em um grupo do WhatsApp.\n` +
                `Regra: Comece DIRETO no cabeçalho formatado abaixo sem introduções.\n\n` +
                `Estrutura obrigatória:\n` +
                `📌 *RELATÓRIO SITUACIONAL JARVIS (30 MINUTOS)*\n` +
                `📅 *Data:* ${dateStrLog}\n\n` +
                `🗣️ *Tópicos em Discussão:* (Resumo dos temas)\n` +
                `👥 *Membros em Destaque:* (Interações principais)\n` +
                `🌟 *Clima Geral do Grupo:* (Dinâmica das conversas)`;
            const summaryText = await callAI(promptMeta, clusterStrings);
            await sock.sendMessage(chatId, { text: summaryText });
        } catch (e) {
            await sock.sendMessage(chatId, { text: '❌ Erro ao gerar resumo.' });
        }
        return;
    }

    // !moeda / !cotacao
    if (['!moeda', '!cotacao'].includes(firstWord)) {
        await sock.sendMessage(chatId, { text: await fetchCurrency() }, { quoted: msg });
        return;
    }
    // !wiki
    if (['!wiki', '!wikipedia'].includes(firstWord)) {
        const q = text.replace(firstWord, '').trim();
        if (!q) {
            await sock.sendMessage(chatId, { text: '⚠️ Digite o termo! Ex: `!wiki Inteligência Artificial`' }, { quoted: msg });
            return;
        }
        await sock.sendMessage(chatId, { text: await fetchWikipedia(q) }, { quoted: msg });
        return;
    }
    // !qrcode
    if (firstWord === '!qrcode') {
        const q = text.replace(firstWord, '').trim();
        if (!q) {
            await sock.sendMessage(chatId, { text: '⚠️ Digite o texto ou link para o QR Code!' }, { quoted: msg });
            return;
        }
        try {
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(q)}`;
            const res = await axios.get(qrUrl, { responseType: 'arraybuffer' });
            await sock.sendMessage(chatId, { image: Buffer.from(res.data), caption: '📱 *QR Code Gerado pelo Jarvis!*' }, { quoted: msg });
        } catch (e) {
            await sock.sendMessage(chatId, { text: '❌ Erro ao gerar QR Code.' }, { quoted: msg });
        }
        return;
    }
    // !quiz
    if (['!quiz', '!charada'].includes(firstWord)) {
        if (!isGroup) {
            await sock.sendMessage(chatId, { text: '❌ Este comando só pode ser usado em grupos.' }, { quoted: msg });
            return;
        }
        const q = QUIZ_DATABASE[Math.floor(Math.random() * QUIZ_DATABASE.length)];
        storage.data.activeQuiz[chatId] = { question: q.question, answer: q.answer.toLowerCase().trim(), startedBy: userId, date: Date.now() };
        storage.flagSave();
        await sock.sendMessage(chatId, { text: `🧩 *DESAFIO / QUIZ DO GRUPO*\n\n❓ *Pergunta:* ${q.question}\n\n👉 _Responda no chat para vencer!_` });
        return;
    }

    // !regras
    if (firstWord === '!regras') {
        if (!isGroup) return;
        if (text.toLowerCase().startsWith('!regras definir ')) {
            const userRole = parseInt(getUserRole(userId, storage.data.users));
            if (userRole < 2) {
                await sock.sendMessage(chatId, { text: '❌ Apenas administradores podem definir as regras.' });
                return;
            }
            storage.data.groupRules[chatId] = text.slice('!regras definir '.length).trim();
            storage.flagSave();
            await sock.sendMessage(chatId, { text: '📋 *DIRETRIZES DO GRUPO ATUALIZADAS PELO JARVIS!*' });
            return;
        }
        const rules = storage.data.groupRules[chatId];
        await sock.sendMessage(chatId, { text: rules ? `📋 *DIRETRIZES DO GRUPO*\n\n${rules}` : '📋 *DIRETRIZES DO GRUPO*\n\n_Nenhuma diretriz cadastrada ainda._' });
        return;
    }

    // !sa / !boasvindas
    if (['!sa', '!boasvindas'].includes(firstWord)) {
        if (!isGroup) {
            await sock.sendMessage(chatId, { text: '❌ Este comando só pode ser usado em grupos.' }, { quoted: msg });
            return;
        }
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) {
            await sock.sendMessage(chatId, { text: `❌ ${userInfo.pushName}, apenas administradores podem configurar a saudação de novos membros.` }, { quoted: msg });
            return;
        }
        let customText = '';
        if (text.includes('+')) customText = text.slice(text.indexOf('+') + 1).trim();
        else customText = text.slice(firstWord.length).trim();
        if (customText.toLowerCase() === 'off') {
            if (storage.data.welcomeMsgs && storage.data.welcomeMsgs[chatId]) {
                delete storage.data.welcomeMsgs[chatId];
                storage.flagSave();
                await sock.sendMessage(chatId, { text: '🛑 *Saudação personalizada desativada.* (Usando padrão do sistema).' }, { quoted: msg });
                return;
            }
            await sock.sendMessage(chatId, { text: 'ℹ️ Nenhuma saudação personalizada ativa neste grupo.' }, { quoted: msg });
            return;
        }
        if (!customText) {
            const current = storage.data.welcomeMsgs?.[chatId]?.text;
            let infoMsg = `👋 *CONFIGURAÇÃO DE SAUDAÇÃO (!sa)*\n\n`;
            if (current) infoMsg += `📝 *Mensagem Atual:*\n_${current}_\n\n`;
            else infoMsg += `📝 *Mensagem Atual:* _Padrão do Sistema_\n\n`;
            infoMsg += `💡 *Como alterar?*\nEnvie: \`!sa Digite aqui a nova mensagem de boas-vindas\`\n\n_Para desativar a personalizada:_ \`!sa off\``;
            await sock.sendMessage(chatId, { text: infoMsg }, { quoted: msg });
            return;
        }
        if (!storage.data.welcomeMsgs) storage.data.welcomeMsgs = {};
        storage.data.welcomeMsgs[chatId] = {
            text: customText,
            setBy: userId,
            date: new Date().toISOString()
        };
        storage.flagSave();
        await sock.sendMessage(chatId, {
            text: `✅ *SAUDAÇÃO DE BOAS-VINDAS CONFIGURADA COM SUCESSO!*\n\n` +
                `📝 *Nova Mensagem:*\n${customText}\n\n` +
                `_Esta saudação será enviada automaticamente no momento em que novos membros entrarem no grupo._`
        }, { quoted: msg });
        return;
    }

    // !bv
    if (firstWord === '!bv') {
        if (!isGroup) {
            await sock.sendMessage(chatId, { text: '❌ Este comando só pode ser usado em grupos.' }, { quoted: msg });
            return;
        }
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) {
            await sock.sendMessage(chatId, { text: `❌ ${userInfo.pushName}, apenas administradores podem configurar o lembrete de boas-vindas.` }, { quoted: msg });
            return;
        }
        let customText = '';
        if (text.includes('+')) customText = text.slice(text.indexOf('+') + 1).trim();
        else customText = text.slice(firstWord.length).trim();
        if (customText.toLowerCase() === 'off') {
            if (storage.data.welcomeReminders && storage.data.welcomeReminders[chatId]) {
                delete storage.data.welcomeReminders[chatId];
                storage.flagSave();
                await sock.sendMessage(chatId, { text: '🛑 *Lembrete de 15 minutos (!bv) desativado neste grupo.*' }, { quoted: msg });
                return;
            }
            await sock.sendMessage(chatId, { text: 'ℹ️ Nenhum lembrete de 15 minutos ativo neste grupo.' }, { quoted: msg });
            return;
        }
        if (!customText) {
            const current = storage.data.welcomeReminders?.[chatId]?.text;
            let infoMsg = `🔔 *LEMBRETE DE BOAS-VINDAS 15 MIN (!bv)*\n\n`;
            if (current) infoMsg += `📝 *Mensagem Atual (15min após entrada):*\n_${current}_\n\n`;
            else infoMsg += `📝 *Status:* Nenhum lembrete configurado.\n\n`;
            infoMsg += `💡 *Como configurar?*\nEnvie: \`!bv Digite aqui o lembrete que será enviado 15 minutos após a entrada do membro\`\n\n_Para desativar:_ \`!bv off\``;
            await sock.sendMessage(chatId, { text: infoMsg }, { quoted: msg });
            return;
        }
        if (!storage.data.welcomeReminders) storage.data.welcomeReminders = {};
        storage.data.welcomeReminders[chatId] = {
            text: customText,
            setBy: userId,
            date: new Date().toISOString()
        };
        storage.flagSave();
        await sock.sendMessage(chatId, {
            text: `✅ *LEMBRETE DE 15 MINUTOS (!bv) CONFIGURADO!*\n\n` +
                `📝 *Mensagem:*\n${customText}\n\n` +
                `_Será enviada marcando @todos 15 minutos após a entrada de novos participantes._`
        }, { quoted: msg });
        return;
    }

    // !exit / !saida
    if (['!exit', '!saida'].includes(firstWord)) {
        if (!isGroup) {
            await sock.sendMessage(chatId, { text: '❌ Este comando só pode ser usado em grupos.' }, { quoted: msg });
            return;
        }
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) {
            await sock.sendMessage(chatId, { text: `❌ ${userInfo.pushName}, apenas administradores podem configurar mensagem de despedida.` }, { quoted: msg });
            return;
        }
        let customText = '';
        if (text.includes('+')) customText = text.slice(text.indexOf('+') + 1).trim();
        else customText = text.slice(firstWord.length).trim();
        if (customText.toLowerCase() === 'off') {
            if (storage.data.exitMsgs && storage.data.exitMsgs[chatId]) {
                delete storage.data.exitMsgs[chatId];
                storage.flagSave();
                await sock.sendMessage(chatId, { text: '🛑 *Mensagem de despedida desativada neste grupo.*' }, { quoted: msg });
                return;
            }
            await sock.sendMessage(chatId, { text: 'ℹ️ Nenhuma mensagem de despedida ativa neste grupo.' }, { quoted: msg });
            return;
        }
        if (!customText) {
            const current = storage.data.exitMsgs?.[chatId]?.text;
            let infoMsg = `👋 *MENSAGEM DE DESPEDIDA (!exit)*\n\n`;
            if (current) infoMsg += `📝 *Mensagem Atual:*\n_${current}_\n\n`;
            else infoMsg += `📝 *Status:* Nenhuma mensagem de despedida ativa.\n\n`;
            infoMsg += `💡 *Como configurar?*\nEnvie: \`!exit Digite aqui a mensagem de despedida\`\n\n_Para desativar:_ \`!exit off\``;
            await sock.sendMessage(chatId, { text: infoMsg }, { quoted: msg });
            return;
        }
        if (!storage.data.exitMsgs) storage.data.exitMsgs = {};
        storage.data.exitMsgs[chatId] = {
            text: customText,
            setBy: userId,
            date: new Date().toISOString()
        };
        storage.flagSave();
        await sock.sendMessage(chatId, {
            text: `✅ *MENSAGEM DE DESPEDIDA (!exit) CONFIGURADA!*\n\n` +
                `📝 *Mensagem:*\n${customText}\n\n` +
                `_Será enviada sempre que um integrante sair voluntariamente do grupo._`
        }, { quoted: msg });
        return;
    }

    // !ajuda
    if (text.toLowerCase() === '!ajuda') {
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        const isAdmin = userRole >= 2;
        let menu = `🤖 *CENTRAL DE COMANDOS - JARVIS BOT2.0* 🤖\n\n` +
            `*🔌 CONTROLE MESTRE & MODERAÇÃO POR GRUPO*\n` +
            `🔌 \`!bot on / !bot off\` - Ligar/Desligar o bot neste grupo\n` +
            `📢 \`!divulga\` - Programar horário e link de divulgação (Links liberados no período)\n` +
            `🛑 \`!divulga off\` - Cancelar divulgação programada\n` +
            `🛡️ \`!admins\` ou pergunte *"quem são os admins"* - Marcar e listar administradores\n\n` +
            `*🧠 CONSCIÊNCIA AUTÔNOMA & MEMÓRIA 30MIN*\n` +
            `🟢 \`!jarvis on\` - Ativa análise contínua em tempo real e intervenção autônoma\n` +
            `🔴 \`!jarvis off\` - Desativa análise em tempo real\n` +
            `🤖 \`!ia [pergunta]\` ou \`!jarvis [pergunta]\` - Consulta direta à IA\n` +
            `📊 \`!status\` ou \`!painel\` - Painel de controle do grupo\n` +
            `⏰ Agendamento diário: \`!abrir 07:00\` | \`!fechar 22:00\`\n\n` +
            `*MEMES, TROLLAGEM & DIVERSÃO*\n` +
            `🎨 \`!s\` - Imagem/Vídeo para figurinha\n` +
            `🖼️ \`!s2img\` - Extrair imagem de figurinha\n` +
            `🧩 \`!quiz\` - Desafio Quiz | 📱 \`!qrcode\` - Criar QR Code\n` +
            `💵 \`!moeda\` - Cotação Dólar/Euro/BTC | 📚 \`!wiki\` - Wikipédia\n` +
            `🏆 \`!rank\` - Ranking de membros | 🎲 \`!sorteio\` - Sorteio no grupo\n\n` +
            `*UTILITÁRIOS & TEMPO REAL*\n` +
            `📰 \`!n\` - Notícias | ✨ \`!h\` - Horóscopo | 🌤️ \`!t\` - Clima\n` +
            `⚽ \`!f\` - Futebol ao Vivo | 📋 \`!regras\` - Regras | 👤 \`!id\` - Seu Perfil`;
        if (isAdmin) {
            menu += `\n\n*🛡️ MODERAÇÃO AUTÔNOMA E ADMINISTRAÇÃO*\n` +
                `📢 \`!megafone + [msg]\` - Fecha o grupo, envia comunicado em MAIÚSCULO e reabre\n` +
                `🛡️ \`!antilink on/off\` - Anti-link autônomo (Deleção + Ban Imediato)\n` +
                `🇧🇷 \`!antifake on/off\` - Filtro DDI +55 (Remove números estrangeiros)\n` +
                `👻 \`!antighost on/off\` - Remove quem não se apresentar em 10 minutos\n` +
                `⚡ \`!antiflood on/off\` - Proteção contra spam/flood\n` +
                `🚨 \`!alerta\` - Gerenciar palavras censuradas\n` +
                `⚠️ \`!warn @membro\` - Advertência manual (Auto-ban no limite de 2)\n` +
                `📊 \`!warns @membro\` - Consultar saldo de advertências\n` +
                `🔒 \`!fechar [horário/off]\` - Trancar grupo agora ou agendar\n` +
                `🔓 \`!abrir [horário/off]\` - Abrir grupo agora ou agendar\n` +
                `👋 \`!sa + [msg]\` - Saudação para novos membros\n` +
                `🔔 \`!bv\` - Lembrete Boas-Vindas (15min com @todos @all)\n` +
                `👋 \`!exit + [msg]\` - Mensagem de despedida\n` +
                `✨ \`!auto on/off\` - Animação de inatividade (20min com IA)\n` +
                `🚫 \`!ban @membro\` | 👻 \`!inativos\` | 📊 \`!m\` | 📝 \`!r\` | ⏰ \`!ma\``;
        }
        if (userRole === 5) {
            menu += `\n\n*👑 SUPER ADMINISTRADOR (NÍVEL 5)*\n` +
                `👑 \`!cadastro+[NÚMERO]+[NÍVEL]\` - Cadastrar novo administrador\n` +
                `👑 \`!remover\` - Remover administrador`;
        }
        await sock.sendMessage(chatId, { text: menu, mentions: [userInfo.jid] });
        return;
    }

    // Fallback
    if (firstWord.startsWith('!') && !isNavigatingMenu) {
        const suggestion = findSuggestedCommand(firstWord);
        if (suggestion) {
            await sock.sendMessage(chatId, {
                text: `💡 *Jarvis Sugestão:* Não encontrei o comando \`${firstWord}\`.\nVocê quis dizer \`${suggestion}\`?`
            }, { quoted: msg });
            return;
        }
        await sock.sendMessage(chatId, {
            text: `🤖 *Jarvis:* Desculpe, não consegui entender esse comando. Vou pedir instruções ao meu criador Leandro (@+5511927018683).`,
            mentions: [SETTINGS.CREATOR_JID]
        }, { quoted: msg });
        return;
    }
}