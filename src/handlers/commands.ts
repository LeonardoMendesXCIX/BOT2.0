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