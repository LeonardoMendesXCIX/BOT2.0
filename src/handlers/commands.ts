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
import { getUserInfo, updateLidMapping, extractRawNumber, UserDisplayInfo, lidMap, contactCache } from '../utils/user';
import { generateNglCard } from '../services/nglCard';
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
            if (b.charAt(i - 1) === a.charAt(j - 1)) matrix[i][j] = matrix[i - 1][j - 1];
            else matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
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
        if (d < minDistance && d > 0) { minDistance = d; bestMatch = cmd; }
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
export async function handleCommand(sock: WASocket, msg: proto.IWebMessageInfo, storage: StorageManager): Promise<void> {
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
    if (state && state.mode === 'inativos_confirm_removal') {
        const answer = textLower.trim();
        const isYes = ['sim', '1', 's', 'yes', 'si'].includes(answer);
        const isNo = ['nao', 'não', 'naõ', '2', 'n', 'no'].includes(answer);
        if (!isYes && !isNo) {
            await sock.sendMessage(chatId, { text: '⚠️ Responda *SIM* (ou 1) para confirmar a remoção, ou *NÃO* (ou 2) para cancelar.' }, { quoted: msg });
            return;
        }
        const targetChat = state.targetChat || chatId;
        const inactiveList: any[] = state.inactiveList || [];
        delete storage.data.states[userId];
        storage.flagSave();
        if (isNo) {
            await sock.sendMessage(chatId, { text: '🛑 *Limpeza de inativos cancelada.* Nenhum integrante foi removido.' }, { quoted: msg });
            return;
        }
        await sock.sendMessage(chatId, { text: '🧹 *Jarvis:* Iniciando remoção de ' + inactiveList.length + ' integrante(s) inativo(s)...' }, { quoted: msg });
        let removedCount = 0;
        const removedNames: string[] = [];
        for (const u of inactiveList) {
            const removeJid = u.removeJid || u.jid;
            try {
                await sock.groupParticipantsUpdate(targetChat, [removeJid], 'remove');
                removedCount++;
                removedNames.push('• ' + u.nameAndNumber);
                await new Promise(r => setTimeout(r, 600));
            } catch (e: any) { console.error('[ERRO REMOVER INATIVO]', e.message); }
        }
        const report = '🧹 *LIMPEZA DE INATIVOS CONCLUÍDA!*\n\n📊 *Removidos:* ' + removedCount + ' de ' + inactiveList.length + '\n\n' + (removedNames.join('\n') || '_Nenhum integrante removido._');
        await sock.sendMessage(chatId, { text: report });
        const afterMsg = storage.data.inativosMsgs?.[targetChat]?.text;
        if (afterMsg) await sock.sendMessage(targetChat, { text: afterMsg });
        return;
    }
    const IGNORED_MULTIMEDIA_PREFIXES = ['!p', '!pp', '!v', '!play', '!video', '!playlist', '!musica', '!song', '!msc', '!tocar', '!ytmp3'];
    if (IGNORED_MULTIMEDIA_PREFIXES.includes(firstWord) || IGNORED_MULTIMEDIA_PREFIXES.some(prefix => textLower.startsWith(prefix + ' ') || textLower.startsWith(prefix + '+'))) return;
    if (firstWord === '!bot') {
        const parts = text.trim().split(/\s+/);
        const action = parts[1]?.toLowerCase();
        if (action === 'on' || action === 'off') {
            if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ O comando !bot é exclusivo para grupos.' }, { quoted: msg }); return; }
            const userRole = parseInt(getUserRole(userId, storage.data.users));
            if (userRole < 2) { await sock.sendMessage(chatId, { text: '❌ ' + userInfo.pushName + ', apenas administradores podem ligar/desligar o bot.' }, { quoted: msg }); return; }
            const shouldDisable = action === 'off';
            storage.setBotDisabled(chatId, shouldDisable);
            if (shouldDisable) {
                await sock.sendMessage(chatId, { text: '🔴 *JARVIS BOT DESATIVADO NESTE GRUPO*\n\nO bot foi colocado em modo de espera exclusivo para este grupo.\n_Para reativar:_ `!bot on`', mentions: [userInfo.jid] });
            } else {
                await sock.sendMessage(chatId, { text: '🟢 *JARVIS BOT REATIVADO COM SUCESSO!*', mentions: [userInfo.jid] });
            }
            return;
        }
    }
    if (isGroup && storage.isBotDisabled(chatId)) {
        if (text.startsWith('!')) console.log('[AVISO] Bot em modo !bot off no grupo ' + chatId);
        return;
    }
    if (['!cancelar', 'cancelar', 'sair', '!sair'].includes(textLower)) {
        if (state && state.mode) {
            delete storage.data.states[userId];
            storage.flagSave();
            await sock.sendMessage(chatId, { text: '🛑 *Operação cancelada com sucesso.*' }, { quoted: msg });
            return;
        }
    }
    if (isGroup) {
        storage.data.lastGroupActivity[chatId] = Date.now();
        storage.data.autoAnimSent[chatId] = false;
        const senderPn = (msg.key as any).senderPn;
        if (senderPn && sender.includes('@lid')) {
            lidMap[sender.split('@')[0].split(':')[0].replace(/\D/g, '')] = String(senderPn).split('@')[0].split(':')[0].replace(/\D/g, '');
        }
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
            storage.data.pendingPresentations = storage.data.pendingPresentations.filter(p => !(p.chatId === chatId && checkMatch(p.memberNum, rawSenderNum)));
            if (storage.data.pendingPresentations.length !== beforeLen) {
                storage.flagSave();
                console.log('[ANTI-GHOST] Apresentação confirmada para ' + userInfo.pushName);
            }
        }
        if (text && !key.fromMe) storage.addMessageToCluster(chatId, userInfo.number, userInfo.pushName, text);
    }
    if (state && state.mode && state.mode.startsWith('divulga_')) {
        const inputClean = text.trim();
        if (state.mode === 'divulga_waiting_time') {
            const timeMatch = inputClean.match(/(\d{1,2}:\d{2})\s*(?:às|as|a|-|ate|até)\s*(\d{1,2}:\d{2})/i);
            if (!timeMatch) { await sock.sendMessage(chatId, { text: '⚠️ *Formato de horário inválido.*\n\nEnvie: `das 20:00 às 21:00`' }); return; }
            state.startTime = timeMatch[1].padStart(5, '0');
            state.endTime = timeMatch[2].padStart(5, '0');
            state.mode = 'divulga_waiting_content';
            storage.flagSave();
            await sock.sendMessage(chatId, { text: '📢 *O que deseja divulgar?*\n\nEnvie o texto completo e o link da divulgação:' });
            return;
        }
        if (state.mode === 'divulga_waiting_content') {
            if (!inputClean) return;
            if (!storage.data.promoSchedule) storage.data.promoSchedule = {};
            storage.data.promoSchedule[chatId] = { startTime: state.startTime, endTime: state.endTime, content: inputClean, setBy: userId, active: true };
            delete storage.data.states[userId];
            storage.flagSave();
            await sock.sendMessage(chatId, { text: '✅ *HORÁRIO DE DIVULGAÇÃO PROGRAMADO!*\n\ndas *' + state.startTime + '* às *' + state.endTime + '*\n\n📢 ' + inputClean });
            return;
        }
    }
    if (state && state.mode && state.mode.startsWith('ma_')) {
        const inputClean = text.trim();
        if (state.mode === 'ma_menu_main') {
            if (inputClean === '1') {
                const existingMsg = storage.data.scheduledMsgs.find(m => m.chatId === chatId);
                if (existingMsg) {
                    const hoursStr = existingMsg.hours.map(h => String(h).padStart(2, '0') + ':00').join(', ');
                    state.mode = 'ma_opt1_confirm';
                    storage.flagSave();
                    await sock.sendMessage(chatId, { text: '📋 *MENSAGEM PROGRAMADA ATUAL*\n\n📝 ' + existingMsg.text + '\n⏰ ' + hoursStr + '\n\n1 - Manter\n2 - Alterar' });
                    return;
                } else { await sock.sendMessage(chatId, { text: 'ℹ️ Nenhuma mensagem programada. Escolha 2.' }); return; }
            } else if (inputClean === '2') { state.mode = 'ma_opt2_text'; storage.flagSave(); await sock.sendMessage(chatId, { text: '📝 *Qual a nova mensagem programada?*' }); return; }
            else if (inputClean === '3') { state.mode = 'ma_opt3_hours'; storage.flagSave(); await sock.sendMessage(chatId, { text: '⏰ Quantas mensagens por dia? (1 a 10):' }); return; }
            else if (inputClean === '4') { state.mode = 'ma_opt4_reps'; storage.flagSave(); await sock.sendMessage(chatId, { text: '🔄 Quantas mensagens por dia? (1 a 10):' }); return; }
        }
        if (state.mode === 'ma_opt1_confirm') {
            if (inputClean === '1') { delete storage.data.states[userId]; storage.flagSave(); await sock.sendMessage(chatId, { text: '✅ *Mensagem mantida.*' }); return; }
            else if (inputClean === '2') { state.mode = 'ma_opt2_text'; storage.flagSave(); await sock.sendMessage(chatId, { text: '📝 *Qual a nova mensagem?*' }); return; }
        }
        if (state.mode === 'ma_opt2_text') {
            if (!inputClean) return;
            state.newText = inputClean;
            state.mode = 'ma_opt2_type';
            storage.flagSave();
            await sock.sendMessage(chatId, { text: '⏱️ *COMO DEFINIR HORÁRIOS?*\n\n1 - Horários fixos\n2 - Repetições' });
            return;
        }
        if (state.mode === 'ma_opt2_type') {
            if (inputClean === '1') { state.mode = 'ma_waiting_time'; storage.flagSave(); await sock.sendMessage(chatId, { text: '⏰ Envie os horários separados por vírgula:' }); return; }
            else if (inputClean === '2') { state.mode = 'ma_opt4_reps'; storage.flagSave(); await sock.sendMessage(chatId, { text: '🔄 Quantas mensagens por dia? (1 a 10):' }); return; }
        }
        if (state.mode === 'ma_waiting_time') {
            const rawTimes = inputClean.split(/[,;\s]+/);
            const hoursList: number[] = [];
            for (const t of rawTimes) {
                const hourPart = parseInt(t.trim().split(':')[0]);
                if (!isNaN(hourPart) && hourPart >= 0 && hourPart <= 23) { if (!hoursList.includes(hourPart)) hoursList.push(hourPart); }
            }
            if (hoursList.length === 0) { await sock.sendMessage(chatId, { text: '⚠️ Nenhum horário válido.' }); return; }
            hoursList.sort((a, b) => a - b);
            const msgTextToSave = state.newText || 'Mensagem Automática';
            const existingIndex = storage.data.scheduledMsgs.findIndex(m => m.chatId === chatId);
            const item = { id: Date.now().toString(), chatId, authorId: userId, authorNum: userInfo.number, text: msgTextToSave, hours: hoursList, isReps: false, lastSent: {} };
            if (existingIndex !== -1) storage.data.scheduledMsgs[existingIndex] = item; else storage.data.scheduledMsgs.push(item);
            delete storage.data.states[userId];
            storage.flagSave();
            await sock.sendMessage(chatId, { text: '⏰ *MENSAGEM PROGRAMADA!*\n\n📝 ' + msgTextToSave + '\n🕒 ' + hoursList.map(h => String(h).padStart(2, '0') + ':00').join(', ') });
            return;
        }
        if (state.mode === 'ma_opt3_hours' || state.mode === 'ma_opt4_reps') {
            const countChoice = parseInt(inputClean);
            if (isNaN(countChoice) || countChoice < 1 || countChoice > 10) { await sock.sendMessage(chatId, { text: '⚠️ Escolha de 1 a 10.' }); return; }
            const currentHour = new Date().getHours();
            const calculatedHours: number[] = [];
            for (let i = 0; i < countChoice; i++) {
                const hour = (currentHour + 1 + (i * 2)) % 24;
                if (!calculatedHours.includes(hour)) calculatedHours.push(hour);
            }
            calculatedHours.sort((a, b) => a - b);
            const msgTextToSave = state.newText || 'Mensagem Automática';
            const existingIndex = storage.data.scheduledMsgs.findIndex(m => m.chatId === chatId);
            const item = { id: Date.now().toString(), chatId, authorId: userId, authorNum: userInfo.number, text: msgTextToSave, hours: calculatedHours, isReps: true, lastSent: {} };
            if (existingIndex !== -1) storage.data.scheduledMsgs[existingIndex] = item; else storage.data.scheduledMsgs.push(item);
            delete storage.data.states[userId];
            storage.flagSave();
            await sock.sendMessage(chatId, { text: '⏰ *MENSAGEM PROGRAMADA!*\n\n📝 ' + msgTextToSave + '\n📊 ' + countChoice + ' disparos\n🕒 ' + calculatedHours.map(h => String(h).padStart(2, '0') + ':00').join(', ') });
            return;
        }
    }
    if (isGroup && storage.data.activeQuiz && storage.data.activeQuiz[chatId] && !storage.isFeatureDisabled(chatId, 'quiz')) {
        const currentQuiz = storage.data.activeQuiz[chatId];
        if (text.toLowerCase().trim() === currentQuiz.answer) {
            delete storage.data.activeQuiz[chatId];
            storage.flagSave();
            await sock.sendMessage(chatId, { text: '🎉 *PARABÉNS ' + userInfo.mentionTag + '!* VOCÊ ACERTOU!\n\n📱 ' + userInfo.formattedNum + '\n✅ Resposta: ' + currentQuiz.answer.toUpperCase(), mentions: [userInfo.jid] });
        }
    }
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
            if (!admins || admins.length === 0) { await sock.sendMessage(chatId, { text: 'ℹ️ Nenhum administrador humano localizado.' }, { quoted: msg }); return; }
            let adminReport = '🛡️ *ADMINISTRADORES DO GRUPO* 🛡️\n\n';
            const mentionsArr: string[] = [];
            admins.forEach((adm, idx) => {
                const admInfo = getUserInfo(adm.id, adm.name || (adm as any).notify || '');
                const isCreator = checkMatch('5511927018683', admInfo.number) || checkMatch(RBAC.superAdmin, admInfo.number);
                const badge = isCreator || adm.admin === 'superadmin' ? '👑 Criador' : '⭐ Admin';
                adminReport += (idx + 1) + 'º 👉 ' + admInfo.nameAndNumber + ' — ' + badge + '\n';
                if (admInfo.jid) mentionsArr.push(admInfo.jid);
                if (adm.id) mentionsArr.push(adm.id);
            });
            adminReport += '\n_Total: ' + admins.length + ' admin(s)._';
            lastAdminResponse.set(chatId, now);
            await sock.sendMessage(chatId, { text: adminReport, mentions: Array.from(new Set(mentionsArr)) }, { quoted: msg });
            return;
        } catch (e: any) { console.error('[ERRO BUSCAR ADMINS]', e.message); }
    }
    if (isGroup && !key.fromMe) {
        const userRole = getUserRole(userId, storage.data.users);
        const isUserAdmin = parseInt(userRole) >= 2;
        if (!isUserAdmin) {
            const userKey = chatId + '_' + userId;
            const nowTime = Date.now();
            const isAntiFloodActive = !storage.isFeatureDisabled(chatId, 'antiflood') && storage.data.antiflood[chatId] !== false;
            if (isAntiFloodActive) {
                if (!userMessageHistory[userKey]) userMessageHistory[userKey] = [];
                userMessageHistory[userKey].push(nowTime);
                userMessageHistory[userKey] = userMessageHistory[userKey].filter(t => nowTime - t < 3000);
                if (userMessageHistory[userKey].length > 5) {
                    try { await sock.sendMessage(chatId, { delete: key }); } catch (e) { }
                    userMessageHistory[userKey] = [];
                    await storage.applyWarning(sock, chatId, sender, 'Flood/Spam', 2);
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
                        await sock.sendMessage(chatId, { text: '🚫 *ANTI-LINK (EXPULSÃO AUTOMÁTICA)* 🚫\n\n👤 *' + userInfo.nameAndNumber + '*\n📝 Envio de link não autorizado.', mentions: [userInfo.jid] });
                        return;
                    } catch (errKick: any) { console.error('[ERRO KICK ANTI-LINK]', errKick.message); }
                }
            }
            const isAlertActive = !storage.isFeatureDisabled(chatId, 'alerta') && storage.data.bannedWords[chatId]?.length > 0;
            if (isAlertActive) {
                const containsBanned = storage.data.bannedWords[chatId].some(w => text.toLowerCase().includes(w.toLowerCase()));
                if (containsBanned) {
                    try { await sock.sendMessage(chatId, { delete: key }); } catch (e) { }
                    await storage.applyWarning(sock, chatId, sender, 'Palavra censurada', 2);
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
                        await sock.sendMessage(chatId, { text: '🎙️ *TRANSCRIÇÃO AUTOMÁTICA*\n👤 *' + userInfo.nameAndNumber + '*\n\n📝 "' + transcript + '"', mentions: [userInfo.jid] }, { quoted: msg });
                    }
                }
            } catch (e) { }
        }
        if (msg.key.id && text) {
            if (!storage.data.messageBuffer) storage.data.messageBuffer = {};
            if (!storage.data.messageBuffer[chatId]) storage.data.messageBuffer[chatId] = {};
            storage.data.messageBuffer[chatId][msg.key.id] = { sender: sender, text: text, pushName: userInfo.pushName, timestamp: Date.now() };
        }
        const zeroWidthCount = (text.match(/[\u200B-\u200D\uFEFF\u202A-\u202E]/g) || []).length;
        if (zeroWidthCount > 35) {
            try { await sock.sendMessage(chatId, { delete: key }); } catch (e) { }
            await storage.applyWarning(sock, chatId, sender, 'Caracteres invisíveis', 2);
            return;
        }
        if (!storage.data.groupStats[chatId]) storage.data.groupStats[chatId] = {};
        if (!storage.data.groupStats[chatId][userInfo.number]) storage.data.groupStats[chatId][userInfo.number] = { text: 0, media: 0, total: 0 };
        storage.data.groupStats[chatId][userInfo.number].total++;
        const hasMedia = !!(msg.message?.imageMessage || msg.message?.videoMessage || msg.message?.audioMessage || msg.message?.stickerMessage);
        if (hasMedia) storage.data.groupStats[chatId][userInfo.number].media++; else storage.data.groupStats[chatId][userInfo.number].text++;
        if (!storage.data.chatHistory[chatId]) storage.data.chatHistory[chatId] = {};
        const dateStrLog = new Date().toLocaleDateString('pt-BR');
        if (!storage.data.chatHistory[chatId][dateStrLog]) storage.data.chatHistory[chatId][dateStrLog] = [];
        if (text) {
            storage.data.chatHistory[chatId][dateStrLog].push(userInfo.pushName + ': ' + text.substring(0, 200));
            if (storage.data.chatHistory[chatId][dateStrLog].length > 500) storage.data.chatHistory[chatId][dateStrLog].shift();
        }
        storage.flagSave();
    }
    if (!text) return;
    if (key.fromMe && !text.startsWith('!')) return;
    const isJarvisDisabled = storage.isFeatureDisabled(chatId, 'jarvis') || storage.data.jarvisMode?.[chatId] === false;
    if (isGroup && !isJarvisDisabled && !storage.isGroupClosed(chatId) && !text.startsWith('!')) {
        const cluster = storage.data.memoryCluster?.[chatId] || [];
        const clusterStrings = cluster.map(m => m.authorName + ' (+' + m.authorNum + '): ' + m.text);
        const now = Date.now();
        const lastIntervention = storage.data.lastJarvisIntervention?.[chatId] || 0;
        const msgCountSince = storage.data.messageCountSinceLastJarvis?.[chatId] || 0;
        const isExplicitCall = textLower.includes('jarvis') ||
            (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.some(j => j.includes(sock.user?.id?.split(':')[0] || ''))) ||
            (msg.message?.extendedTextMessage?.contextInfo?.participant?.includes(sock.user?.id?.split(':')[0] || ''));
        if (isExplicitCall) {
            try {
                const cleanQuery = text.replace(/jarvis/gi, '').replace(/@\d+/g, '').trim() || text;
                const prompt = 'O integrante ' + userInfo.pushName + ' disse: "' + cleanQuery + '". Responda como Jarvis.';
                const aiResponse = await callAI(prompt, clusterStrings);
                storage.data.lastJarvisIntervention[chatId] = now;
                storage.data.messageCountSinceLastJarvis[chatId] = 0;
                storage.flagSave();
                await sock.sendMessage(chatId, { text: '🤖 *Jarvis:* ' + aiResponse, mentions: [userInfo.jid] }, { quoted: msg });
                return;
            } catch (e: any) { console.error('[ERRO JARVIS EXPLÍCITO]', e.message); }
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
                    await sock.sendMessage(chatId, { text: '🤖 *Jarvis:* ' + autoIntervention });
                    return;
                }
            } catch (errAuto: any) { console.error('[ERRO INTERVENÇÃO AUTÔNOMA]', errAuto.message); }
        }
    }
    const isNavigatingMenu = state && [
        'cadastro_waiting_id', 'cadastro_waiting_role', 'remover_waiting_id',
        'bv_waiting_text', 'divulga_waiting_time', 'divulga_waiting_content', 'inativos_confirm_removal', 'inativos_select_keep',
        'ma_menu_main', 'ma_opt1_confirm', 'ma_opt2_text', 'ma_opt2_type', 'ma_opt3_hours', 'ma_opt4_reps',
        'news_menu', 'news_city', 'news_topics_menu', 'horoscope_menu', 'horoscope_sign', 'weather_menu', 'weather_city', 'football_menu', 'football_query'
    ].includes(state.mode);
    const parts = text.trim().split(/\s+/);
    const cmdCandidate = parts[0].toLowerCase();
    const actionCandidate = parts[1]?.toLowerCase();
    if (cmdCandidate.startsWith('!') && (actionCandidate === 'on' || actionCandidate === 'off')) {
        const featKey = FEATURE_MAP[cmdCandidate];
        if (featKey && featKey !== 'bot_master') {
            if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Controle exclusivo para grupos.' }, { quoted: msg }); return; }
            const userRole = parseInt(getUserRole(userId, storage.data.users));
            if (userRole < 2) { await sock.sendMessage(chatId, { text: '❌ ' + userInfo.pushName + ', apenas administradores.' }, { quoted: msg }); return; }
            const enable = actionCandidate === 'on';
            storage.setFeatureStatus(chatId, featKey, enable);
            const statusWord = enable ? '*LIGADO*' : '*DESLIGADO*';
            const featName = FEATURE_NAMES[featKey] || cmdCandidate;
            await sock.sendMessage(chatId, { text: (enable ? '🟢' : '🔴') + ' *CONTROLE JARVIS*\n\n⚙️ ' + featName + '\n📊 ' + statusWord, mentions: [userInfo.jid] });
            return;
        }
    }
    if (isGroup && firstWord.startsWith('!') && !isNavigatingMenu) {
        const featKey = FEATURE_MAP[firstWord];
        if (featKey && featKey !== 'bot_master' && storage.isFeatureDisabled(chatId, featKey)) {
            const featName = FEATURE_NAMES[featKey] || firstWord;
            await sock.sendMessage(chatId, { text: '⚠️ *' + featName + ' DESATIVADO*\n\nReative com: `' + firstWord + ' on`', mentions: [userInfo.jid] });
            return;
        }
    }
    if (['!voz', '!falar'].includes(firstWord)) {
        const queryVoz = text.slice(firstWord.length).trim();
        if (!queryVoz) { await sock.sendMessage(chatId, { text: '🗣️ *COMO USAR:*\n\n`!voz texto aqui`' }, { quoted: msg }); return; }
        await sock.sendMessage(chatId, { text: '🗣️ *Jarvis:* Sintetizando voz...' }, { quoted: msg });
        try {
            const audioBuffer = await generateTTS(queryVoz);
            if (audioBuffer) await sock.sendMessage(chatId, { audio: audioBuffer, mimetype: 'audio/mpeg' }, { quoted: msg });
            else await sock.sendMessage(chatId, { text: '❌ Não foi possível sintetizar.' });
        } catch (e: any) { await sock.sendMessage(chatId, { text: '❌ Erro no motor de voz.' }); }
        return;
    }
    if (['!desenhe', '!criarimg', '!gerarimg'].includes(firstWord)) {
        const promptText = text.slice(firstWord.length).trim();
        if (!promptText) { await sock.sendMessage(chatId, { text: '🎨 *COMO USAR:*\n\n`!desenhe descrição da imagem`' }, { quoted: msg }); return; }
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) {
            const lastUse = aiCooldowns[userId]?.['image_gen'] || 0;
            const elapsed = Date.now() - lastUse;
            if (elapsed < 15000) { await sock.sendMessage(chatId, { text: '⏳ Aguarde ' + Math.ceil((15000 - elapsed) / 1000) + 's.' }, { quoted: msg }); return; }
            if (!aiCooldowns[userId]) aiCooldowns[userId] = {};
            aiCooldowns[userId]['image_gen'] = Date.now();
        }
        try {
            const imgBuffer = await generateAIImage(promptText);
            if (imgBuffer) await sock.sendMessage(chatId, { image: imgBuffer, caption: '🎨 *IMAGEM GERADA*\n\n📝 ' + promptText + '\n👤 ' + userInfo.nameAndNumber, mentions: [userInfo.jid] }, { quoted: msg });
            else await sock.sendMessage(chatId, { text: '❌ Não foi possível gerar.' }, { quoted: msg });
        } catch (e: any) { await sock.sendMessage(chatId, { text: '❌ Erro ao gerar imagem.' }, { quoted: msg }); }
        return;
    }
    if (['!transcrever', '!ouvir', '!audio'].includes(firstWord)) {
        const targetMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage ? {
            key: { remoteJid: chatId, id: msg.message.extendedTextMessage.contextInfo.stanzaId, participant: msg.message.extendedTextMessage.contextInfo.participant },
            message: msg.message.extendedTextMessage.contextInfo.quotedMessage
        } : msg;
        const isAudio = targetMsg.message?.audioMessage;
        if (!isAudio) { await sock.sendMessage(chatId, { text: '🎙️ Responda a um áudio com `!transcrever`' }, { quoted: msg }); return; }
        try {
            const audioBuffer = await downloadMediaMessage(targetMsg as any, 'buffer', {});
            if (audioBuffer) {
                const transcript = await transcribeAudio(audioBuffer);
                if (transcript) {
                    const audioAuthor = targetMsg.key.participant || sender;
                    const authorInfo = getUserInfo(audioAuthor);
                    await sock.sendMessage(chatId, { text: '🎙️ *TRANSCRIÇÃO*\n\n👤 ' + authorInfo.nameAndNumber + '\n\n📝 "' + transcript + '"', mentions: [authorInfo.jid] }, { quoted: msg });
                } else { await sock.sendMessage(chatId, { text: '❌ Áudio inaudível.' }, { quoted: msg }); }
            }
        } catch (e: any) { await sock.sendMessage(chatId, { text: '❌ Erro ao transcrever.' }, { quoted: msg }); }
        return;
    }
    if (['!enquete', '!votacao'].includes(firstWord)) {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Enquetes só em grupos.' }, { quoted: msg }); return; }
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 1) { await sock.sendMessage(chatId, { text: '❌ Apenas membros autorizados.' }, { quoted: msg }); return; }
        const rawContent = text.slice(firstWord.length).trim();
        if (!rawContent || !rawContent.includes('|')) { await sock.sendMessage(chatId, { text: '📊 *COMO USAR:*\n\n`!enquete Pergunta | Opção 1 | Opção 2 | Opção 3`' }, { quoted: msg }); return; }
        const partsEnquete = rawContent.split('|').map(s => s.trim()).filter(Boolean);
        if (partsEnquete.length < 3) { await sock.sendMessage(chatId, { text: '⚠️ Precisa de 1 pergunta e 2 opções.' }, { quoted: msg }); return; }
        try {
            await sock.sendMessage(chatId, { poll: { name: '📊 ' + partsEnquete[0], values: partsEnquete.slice(1, 12), selectableCount: 1 } });
        } catch (e: any) {
            console.error('[ERRO CRIAR ENQUETE]', e.message);
            await sock.sendMessage(chatId, { text: '❌ Erro ao criar enquete.' });
        }
        return;
    }
        if (['!divulga', '!divulgar'].includes(firstWord)) {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        const subArg = text.slice(firstWord.length).trim().toLowerCase();
        if (subArg === 'off' || subArg === 'cancelar') {
            if (storage.data.promoSchedule && storage.data.promoSchedule[chatId]) {
                delete storage.data.promoSchedule[chatId];
                storage.flagSave();
                await sock.sendMessage(chatId, { text: '🛑 Divulgação cancelada.' });
                return;
            }
            await sock.sendMessage(chatId, { text: 'ℹ️ Nenhuma divulgação ativa.' });
            return;
        }
        storage.data.states[userId] = { mode: 'divulga_waiting_time', targetGroup: chatId };
        storage.flagSave();
        await sock.sendMessage(chatId, { text: '⏰ *Qual horário da divulgação?*\n\n_Ex: "das 20:00 às 21:00"_' });
        return;
    }
    if (['!ia', '!jarvis'].includes(firstWord)) {
        const q = text.slice(firstWord.length).trim();
        if (!q) { await sock.sendMessage(chatId, { text: '🤖 *Jarvis:* Envie sua pergunta após o comando.' }, { quoted: msg }); return; }
        const cluster = storage.data.memoryCluster?.[chatId] || [];
        const clusterStrings = cluster.map(m => m.authorName + ': ' + m.text);
        const aiRes = await callAI(q, clusterStrings);
        await sock.sendMessage(chatId, { text: '🤖 *JARVIS:*\n\n' + aiRes, mentions: [userInfo.jid] });
        return;
    }
    if (['!antifake', '!ddi', '!limparfakes'].includes(firstWord)) {
        const subCmd = text.slice(firstWord.length).trim().toLowerCase();
        if (subCmd === 'varrer' || subCmd === 'limpar' || firstWord === '!limparfakes') {
            if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
            const userRole = parseInt(getUserRole(userId, storage.data.users));
            if (userRole < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
            await sock.sendMessage(chatId, { text: '🔍 Varredura em andamento...' }, { quoted: msg });
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
                if (foreignList.length === 0) { await sock.sendMessage(chatId, { text: '✅ Nenhum número estrangeiro encontrado.' }); return; }
                let removedCount = 0;
                const removedNames: string[] = [];
                for (const target of foreignList) {
                    try {
                        await sock.groupParticipantsUpdate(chatId, [target.id], 'remove');
                        removedCount++;
                        const info = getUserInfo(target.id, target.name || (target as any).notify);
                        removedNames.push('• ' + info.nameAndNumber);
                        await new Promise(r => setTimeout(r, 600));
                    } catch (errRemove: any) { console.error('[ERRO REMOVER FAKE]', errRemove.message); }
                }
                await sock.sendMessage(chatId, { text: '🛡️ *VARREDURA ANTI-FAKE*\n\n📊 Removidos: ' + removedCount + '\n\n' + removedNames.slice(0, 20).join('\n') });
            } catch (errSweep: any) {
                await sock.sendMessage(chatId, { text: '❌ Erro na varredura.' });
            }
            return;
        }
    }
    if (['!fixar', '!desfixar', '!pin', '!unpin'].includes(firstWord)) {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        if (!contextInfo?.stanzaId) { await sock.sendMessage(chatId, { text: '📌 Responda a uma mensagem com `!fixar`' }, { quoted: msg }); return; }
        const targetKey = { remoteJid: chatId, id: contextInfo.stanzaId, participant: contextInfo.participant };
        const isUnpin = firstWord === '!desfixar' || firstWord === '!unpin';
        try {
            await sock.sendMessage(chatId, { pin: targetKey as any, type: isUnpin ? 2 : 1, time: isUnpin ? undefined : 604800 } as any);
            await sock.sendMessage(chatId, { text: isUnpin ? '📌 Desfixada.' : '📌 Fixada no topo.' }, { quoted: msg });
        } catch (e: any) { await sock.sendMessage(chatId, { text: '❌ Erro ao fixar.' }, { quoted: msg }); }
        return;
    }
    if (['!remove', '!apagar', '!deletar', '!del'].includes(firstWord)) {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        if (!contextInfo?.stanzaId) { await sock.sendMessage(chatId, { text: '🗑️ Responda com `!remove`' }, { quoted: msg }); return; }
        const targetKey = { remoteJid: chatId, id: contextInfo.stanzaId, participant: contextInfo.participant };
        try {
            await sock.sendMessage(chatId, { delete: targetKey });
            try { await sock.sendMessage(chatId, { delete: key }); } catch (e) { }
        } catch (e: any) { await sock.sendMessage(chatId, { text: '❌ Não foi possível apagar.' }, { quoted: msg }); }
        return;
    }
    if (['!todos', '!all', '!marcartodos'].includes(firstWord)) {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        const customMsg = text.slice(firstWord.length).trim();
        try {
            const groupMeta = await sock.groupMetadata(chatId);
            const participants = groupMeta.participants || [];
            const participantsJids = participants.map(p => p.id);
            const finalText = customMsg ? ('📢 *CHAMADA GERAL*\n\n' + customMsg + '\n\n📢 @todos @all') : '📢 @todos @all';
            await sock.sendMessage(chatId, { text: finalText, mentions: participantsJids });
        } catch (e: any) { await sock.sendMessage(chatId, { text: '❌ Erro ao marcar todos.' }, { quoted: msg }); }
        return;
    }
    if (firstWord === '!megafone') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        let announcementText = '';
        if (text.includes('+')) announcementText = text.slice(text.indexOf('+') + 1).trim();
        else announcementText = text.slice(firstWord.length).trim();
        if (!announcementText) { await sock.sendMessage(chatId, { text: '⚠️ *Uso:*\n`!megafone + mensagem`' }, { quoted: msg }); return; }
        try {
            await sock.groupSettingUpdate(chatId, 'announcement');
            const groupMeta = await sock.groupMetadata(chatId).catch(() => null);
            const participantsJids = groupMeta?.participants?.map(p => p.id) || [];
            await sock.sendMessage(chatId, { text: '📢 *MEGAFONE*\n\n*' + announcementText.toUpperCase() + '*\n\n📢 @todos @all', mentions: participantsJids });
            setTimeout(async () => {
                try { await sock.groupSettingUpdate(chatId, 'not_announcement'); } catch (e) { }
            }, 3000);
        } catch (err: any) { await sock.sendMessage(chatId, { text: '❌ Erro no megafone.' }); }
        return;
    }
    if (firstWord === '!abrir' || firstWord === '!fechar') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        let arg = '';
        if (text.includes('+')) arg = text.slice(text.indexOf('+') + 1).trim().toLowerCase();
        else arg = text.slice(firstWord.length).trim().toLowerCase();
        if (arg === 'off') {
            if (!storage.data.groupSchedules) storage.data.groupSchedules = {};
            if (!storage.data.groupSchedules[chatId]) storage.data.groupSchedules[chatId] = { openTime: '', closeTime: '' };
            if (firstWord === '!abrir') delete storage.data.groupSchedules[chatId].openTime;
            else delete storage.data.groupSchedules[chatId].closeTime;
            storage.flagSave();
            await sock.sendMessage(chatId, { text: '🛑 Horário desativado.' });
            return;
        }
        const timeMatch = arg.match(/^([01]?[0-9]|2[0-3]):([0-5][0-9])$/);
        if (timeMatch) {
            const formattedTime = String(parseInt(timeMatch[1])).padStart(2, '0') + ':' + timeMatch[2];
            if (!storage.data.groupSchedules) storage.data.groupSchedules = {};
            if (!storage.data.groupSchedules[chatId]) storage.data.groupSchedules[chatId] = { openTime: '', closeTime: '' };
            if (firstWord === '!abrir') storage.data.groupSchedules[chatId].openTime = formattedTime;
            else storage.data.groupSchedules[chatId].closeTime = formattedTime;
            storage.flagSave();
            await sock.sendMessage(chatId, { text: '⏰ Agendado: ' + formattedTime });
            return;
        }
        try {
            const isLock = firstWord === '!fechar';
            await sock.groupSettingUpdate(chatId, isLock ? 'announcement' : 'not_announcement');
            storage.setGroupClosed(chatId, isLock);
            await sock.sendMessage(chatId, { text: isLock ? '🔒 Grupo fechado.' : '🔓 Grupo aberto.' });
        } catch (e) { await sock.sendMessage(chatId, { text: '❌ Falha.' }); }
        return;
    }
    if (['!status', '!painel'].includes(firstWord)) {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        let panelMsg = '📊 *PAINEL JARVIS*\n\n';
        const uniqueKeys = Array.from(new Set(Object.values(FEATURE_MAP)));
        uniqueKeys.forEach(k => {
            const disabled = storage.isFeatureDisabled(chatId, k);
            panelMsg += (disabled ? '🔴' : '🟢') + ' ' + (FEATURE_NAMES[k] || k) + '\n';
        });
        await sock.sendMessage(chatId, { text: panelMsg, mentions: [userInfo.jid] });
        return;
    }
    if (text.toLowerCase() === '!id') {
        const role = getUserRole(userId, storage.data.users);
        const roleNames: Record<string, string> = { '5': 'Super Admin 👑', '4': 'Gestor 🛡️', '3': 'Parceiro 🤝', '2': 'Admin ⭐', '1': 'Especial 🎵', '0': 'Comum 👤' };
        await sock.sendMessage(chatId, { text: '👤 *ID*\n\n' + userInfo.nameAndNumber + '\n👑 Nível ' + role + ' (' + (roleNames[role] || '?') + ')', mentions: [userInfo.jid] });
        return;
    }
    if (text.toLowerCase().startsWith('!cadastro')) {
        if (!isSuperAdmin(userId, storage.data.users)) return;
        if (text.includes('+')) {
            const partes = text.split('+');
            if (partes.length === 3) {
                const targetId = partes[1].trim().replace(/\D/g, '');
                const targetRole = partes[2].trim();
                if (!['0', '1', '2', '3', '4', '5'].includes(targetRole)) { await sock.sendMessage(chatId, { text: '❌ Nível inválido.' }, { quoted: msg }); return; }
                storage.data.users[targetId] = targetRole;
                storage.flagSave();
                const targetInfo = getUserInfo(targetId + '@s.whatsapp.net');
                await sock.sendMessage(chatId, { text: '✅ ' + targetInfo.nameAndNumber + ' agora é Nível ' + targetRole, mentions: [targetInfo.jid] });
                return;
            }
        }
        storage.data.states[userId] = { mode: 'cadastro_waiting_id' };
        storage.flagSave();
        await sock.sendMessage(chatId, { text: 'Qual número? (Ex: 5511999998888)' });
        return;
    }
    if (state && state.mode === 'cadastro_waiting_id') {
        const targetId = text.replace(/\D/g, '');
        if (!targetId) { await sock.sendMessage(chatId, { text: '❌ Número inválido.' }); return; }
        state.mode = 'cadastro_waiting_role';
        state.targetId = targetId;
        storage.flagSave();
        await sock.sendMessage(chatId, { text: 'Qual nível? (1 a 5)' });
        return;
    }
    if (state && state.mode === 'cadastro_waiting_role') {
        const targetRole = text.trim();
        if (!['1', '2', '3', '4', '5'].includes(targetRole)) { await sock.sendMessage(chatId, { text: '❌ Nível inválido.' }); return; }
        storage.data.users[state.targetId] = targetRole;
        delete storage.data.states[userId];
        storage.flagSave();
        const targetInfo = getUserInfo(state.targetId + '@s.whatsapp.net');
        await sock.sendMessage(chatId, { text: '✅ ' + targetInfo.nameAndNumber + ' cadastrado como Nível ' + targetRole, mentions: [targetInfo.jid] });
        return;
    }
    if (text.toLowerCase() === '!remover') {
        if (!isSuperAdmin(userId, storage.data.users)) return;
        storage.data.states[userId] = { mode: 'remover_waiting_id' };
        storage.flagSave();
        await sock.sendMessage(chatId, { text: 'Qual número remover?' });
        return;
    }
    if (state && state.mode === 'remover_waiting_id') {
        const targetId = text.replace(/\D/g, '');
        let foundKey: string | null = null;
        for (const dbNum of Object.keys(storage.data.users)) {
            if (checkMatch(dbNum, targetId)) { foundKey = dbNum; break; }
        }
        const targetInfo = getUserInfo(targetId + '@s.whatsapp.net');
        if (foundKey) delete storage.data.users[foundKey];
        delete storage.data.states[userId];
        storage.flagSave();
        await sock.sendMessage(chatId, { text: '✅ ' + targetInfo.nameAndNumber + ' removido.', mentions: [targetInfo.jid] });
        return;
    }
    if (['!warn', '!advertir', '!warns', '!advertencias', '!unwarn'].includes(firstWord)) {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        if (!storage.data.warnings[chatId]) storage.data.warnings[chatId] = {};
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        const targetJid = contextInfo?.participant || (text.match(/@(\d+)/)?.[1] ? text.match(/@(\d+)/)![1] + '@s.whatsapp.net' : '');
        const targetNum = targetJid ? targetJid.split('@')[0] : userInfo.number;
        const targetInfo = getUserInfo(targetJid || sender);
        if (firstWord === '!warns' || firstWord === '!advertencias') {
            const warns = storage.data.warnings[chatId][targetNum] || 0;
            const limit = storage.data.maxWarnings[chatId] || 2;
            await sock.sendMessage(chatId, { text: '⚠️ ' + targetInfo.nameAndNumber + ' — ' + warns + '/' + limit, mentions: [targetInfo.jid] });
            return;
        }
        if (firstWord === '!unwarn') {
            if (!targetJid) { await sock.sendMessage(chatId, { text: '❌ Marque o membro.' }, { quoted: msg }); return; }
            if (storage.data.warnings[chatId][targetNum] && storage.data.warnings[chatId][targetNum] > 0) {
                storage.data.warnings[chatId][targetNum]--;
                storage.flagSave();
                await sock.sendMessage(chatId, { text: '✅ Advertência removida de ' + targetInfo.nameAndNumber, mentions: [targetInfo.jid] });
                return;
            }
            await sock.sendMessage(chatId, { text: 'ℹ️ Sem advertências.' });
            return;
        }
        if (firstWord === '!warn' || firstWord === '!advertir') {
            if (!targetJid) { await sock.sendMessage(chatId, { text: '❌ Marque o membro.' }, { quoted: msg }); return; }
            const reason = text.replace(firstWord, '').replace(/@\d+/, '').trim() || 'Violação das regras';
            await storage.applyWarning(sock, chatId, targetJid, reason, 2);
            return;
        }
    }
    if (firstWord === '!ban' || firstWord === '!kick') {
        if (!isGroup) return;
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        const targetJid = contextInfo?.participant || (text.match(/@(\d+)/)?.[1] ? text.match(/@(\d+)/)![1] + '@s.whatsapp.net' : '');
        if (!targetJid) { await sock.sendMessage(chatId, { text: '❌ Marque o membro.' }, { quoted: msg }); return; }
        try {
            const groupMeta = await sock.groupMetadata(chatId);
            const targetParticipant = groupMeta.participants.find(p => p.id === targetJid || checkMatch(p.id.split('@')[0], targetJid.split('@')[0]));
            if (!targetParticipant) { await sock.sendMessage(chatId, { text: '⚠️ Membro não encontrado.' }); return; }
            if (targetParticipant.admin === 'admin' || targetParticipant.admin === 'superadmin') { await sock.sendMessage(chatId, { text: '⚠️ Não posso remover outro admin.' }); return; }
            const targetInfo = getUserInfo(targetParticipant.id);
            await sock.groupParticipantsUpdate(chatId, [targetParticipant.id], 'remove');
            await sock.sendMessage(chatId, { text: '🚫 ' + targetInfo.nameAndNumber + ' foi removido.', mentions: [targetInfo.jid] });
        } catch (e: any) { await sock.sendMessage(chatId, { text: '❌ Não foi possível remover.' }); }
        return;
    }
    if (['!rank', '!top'].includes(firstWord)) {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const stats = storage.data.groupStats[chatId];
        if (!stats || Object.keys(stats).length === 0) { await sock.sendMessage(chatId, { text: 'ℹ️ Sem dados ainda.' }, { quoted: msg }); return; }
        const sorted = Object.keys(stats).sort((a, b) => stats[b].total - stats[a].total).slice(0, 10);
        const medals = ['🥇', '🥈', '🥉', '4º', '5º', '6º', '7º', '8º', '9º', '10º'];
        let rankMsg = '🏆 *RANKING*\n\n';
        sorted.forEach((num, i) => {
            const uInfo = getUserInfo(num + '@s.whatsapp.net');
            rankMsg += medals[i] + ' ' + uInfo.nameAndNumber + ' — ' + stats[num].total + ' msgs\n';
        });
        await sock.sendMessage(chatId, { text: rankMsg });
        return;
    }
    if (text.toLowerCase() === '!m') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const stats = storage.data.groupStats[chatId];
        if (!stats || Object.keys(stats).length === 0) { await sock.sendMessage(chatId, { text: 'ℹ️ Sem dados.' }, { quoted: msg }); return; }
        const sorted = Object.keys(stats).sort((a, b) => stats[b].total - stats[a].total).slice(0, 30);
        let report = '📊 *MÉTRICAS*\n\n';
        sorted.forEach((authorNum, index) => {
            const s = stats[authorNum];
            const uInfo = getUserInfo(authorNum + '@s.whatsapp.net');
            report += (index + 1) + 'º ' + uInfo.nameAndNumber + ' (' + s.total + ')\n';
        });
        const mentionsArr = sorted.map(num => num + '@s.whatsapp.net');
        await sock.sendMessage(chatId, { text: report, mentions: mentionsArr });
        return;
    }
    if (firstWord === '!sorteio') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        try {
            const groupMeta = await sock.groupMetadata(chatId);
            const participants = groupMeta.participants;
            if (!participants || participants.length === 0) { await sock.sendMessage(chatId, { text: '❌ Sem participantes.' }, { quoted: msg }); return; }
            const winner = participants[Math.floor(Math.random() * participants.length)];
            const winnerInfo = getUserInfo(winner.id);
            await sock.sendMessage(chatId, { text: '🎲 *GANHADOR:*\n\n' + winnerInfo.nameAndNumber, mentions: [winnerInfo.jid] });
        } catch (e) { await sock.sendMessage(chatId, { text: '❌ Erro no sorteio.' }); }
        return;
    }
    if (['!inativosmsg', '!msginativos'].includes(firstWord)) {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        let customText = '';
        if (text.includes('+')) customText = text.slice(text.indexOf('+') + 1).trim();
        else customText = text.slice(firstWord.length).trim();
        if (!customText) {
            const currentMsg = storage.data.inativosMsgs?.[chatId]?.text;
            await sock.sendMessage(chatId, { text: '🧹 *Mensagem atual:*\n\n' + (currentMsg || '_padrão_') + '\n\n*Como definir:*\n`!inativosmsg + sua mensagem`' }, { quoted: msg });
            return;
        }
        if (!storage.data.inativosMsgs) storage.data.inativosMsgs = {};
        storage.data.inativosMsgs[chatId] = { text: customText, setBy: userId, date: new Date().toISOString() };
        storage.flagSave();
        await sock.sendMessage(chatId, { text: '✅ Mensagem de inativos definida:\n\n' + customText }, { quoted: msg });
        return;
    }
    if (['!inativos', '!fantasmas'].includes(firstWord)) {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        try {
            const persisted = storage.data.cache?.contacts;
            if (persisted) {
                if (persisted.lidMap) Object.assign(lidMap, persisted.lidMap);
                if (persisted.contactCache) Object.assign(contactCache, persisted.contactCache);
            }
            const groupMeta = await sock.groupMetadata(chatId);
            const participants = groupMeta.participants || [];
            const stats = storage.data.groupStats[chatId] || {};
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
                if ((rawBotNum && (checkMatch(rawBotNum, pIdClean) || checkMatch(rawBotNum, pLidClean))) || (botId && pIdRaw && pIdRaw.startsWith(botId.split(':')[0]))) continue;
                const realPhoneNum = pIdRaw.endsWith('@s.whatsapp.net') ? pIdClean : (lidMap[pIdClean] || lidMap[pLidClean] || '');
                const pNum = realPhoneNum || pIdClean;
                if (checkMatch('5511927018683', pNum) || checkMatch(RBAC.superAdmin, pNum)) continue;
                const hasActivity = (stats[pNum] && stats[pNum].total > 0) || (realPhoneNum && stats[realPhoneNum] && stats[realPhoneNum].total > 0);
                if (!hasActivity) {
                    const pName = (p as any).name || (p as any).notify || (p as any).verifiedName || contactCache[pNum]?.name || contactCache[pIdClean]?.name || contactCache[pLidClean]?.name || storage.data.cache?.names?.[pNum] || storage.data.cache?.names?.[pIdClean] || '';
                    const queryJid = realPhoneNum ? (realPhoneNum + '@s.whatsapp.net') : pIdRaw;
                    const uInfo = getUserInfo(queryJid, pName);
                    inactiveList.push({ ...uInfo, removeJid: pIdRaw });
                }
            }
            if (!storage.data.cache) storage.data.cache = {};
            storage.data.cache.contacts = { lidMap: { ...lidMap }, contactCache: { ...contactCache } };
            storage.flagSave();
            if (inactiveList.length === 0) { await sock.sendMessage(chatId, { text: '👏 Nenhum inativo encontrado!' }, { quoted: msg }); return; }
            storage.data.states[userId] = { mode: 'inativos_confirm_removal', targetChat: chatId, inactiveList: inactiveList, date: Date.now() };
            storage.flagSave();
            let listReport = '👻 *INATIVOS (' + inactiveList.length + ')* 👻\n\n🏢 ' + groupMeta.subject + '\n\n';
            inactiveList.forEach((u, idx) => { listReport += (idx + 1) + ' - ' + u.nameAndNumber + '\n'; });
            listReport += '\n⚠️ *Remover todos?*\n\nResponda: *SIM* (1) ou *NÃO* (2)';
            await sock.sendMessage(chatId, { text: listReport }, { quoted: msg });
        } catch (e: any) {
            console.error('[ERRO VARREDURA INATIVOS]', e.message);
            await sock.sendMessage(chatId, { text: '❌ Erro na análise.' });
        }
        return;
    }
    if (firstWord === '!idgrupo') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        await sock.sendMessage(chatId, { text: '🆔 *ID DO GRUPO:*\n\n`' + chatId + '`' }, { quoted: msg });
        return;
    }
    if (firstWord === '!cadastroidgrupo') {
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 4 && !checkMatch('5511927018683', userInfo.number)) { await sock.sendMessage(chatId, { text: '❌ Apenas nível 4+ ou o criador.' }, { quoted: msg }); return; }
        let target = text.slice(firstWord.length).trim();
        if (!target && isGroup) target = chatId;
        if (!target) { await sock.sendMessage(chatId, { text: '⚠️ Use dentro do grupo de admins ou: `!cadastroidgrupo <id>`' }, { quoted: msg }); return; }
        if (!storage.data.cache) storage.data.cache = {};
        storage.data.cache.adminGroupId = target;
        storage.flagSave();
        await sock.sendMessage(chatId, { text: '✅ *GRUPO DE ADMINS REGISTRADO!*\n\n📨 Os correios anônimos serão encaminhados para:\n`' + target + '`' }, { quoted: msg });
        return;
    }
    if (firstWord === '!linkcorreio') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        if (!storage.data.cache) storage.data.cache = {};
        if (!storage.data.cache.anonSlugs) storage.data.cache.anonSlugs = {};
        let slug = storage.data.cache.anonSlugs[chatId];
        if (!slug) {
            const meta = await sock.groupMetadata(chatId).catch(() => null);
            const base = (meta?.subject || 'grupo').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
            slug = base + '-' + Math.random().toString(36).slice(2, 6);
            storage.data.cache.anonSlugs[chatId] = slug;
            storage.flagSave();
        }
        const port = process.env.WEB_PORT || '3000';
        await sock.sendMessage(chatId, { text: '🌐 *PÁGINA DO CORREIO ANÔNIMO*\n\nhttp://localhost:' + port + '/c/' + slug + '\n\n📲 Troque "localhost" pelo IP da máquina para compartilhar.' }, { quoted: msg });
        return;
    }
    if (firstWord === '!anonimo' || firstWord === '!correio') {
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        let receiverJid = contextInfo?.mentionedJid?.[0] || '';
        if (!receiverJid) { const mm = text.match(/@(\d+)/); if (mm) receiverJid = mm[1] + '@s.whatsapp.net'; }
        if (!receiverJid) { await sock.sendMessage(chatId, { text: '🎭 *CORREIO ANÔNIMO*\n\n`!anonimo @pessoa mensagem`\n\n🌐 Ou pela página: `!linkcorreio`' }, { quoted: msg }); return; }
        if (receiverJid === sender) { await sock.sendMessage(chatId, { text: '❌ Não pode enviar para si mesmo.' }, { quoted: msg }); return; }
        const anonText = text.replace(firstWord, '').replace(/@\d+/, '').trim();
        if (!anonText) { await sock.sendMessage(chatId, { text: '❌ Escreva a mensagem.' }, { quoted: msg }); return; }
        const receiverInfo = getUserInfo(receiverJid);
        const anonId = storage.generateAnonId();
        if (!storage.data.anonMsgs) storage.data.anonMsgs = [];
        storage.data.anonMsgs.push({ id: anonId, chatId: chatId, senderJid: sender, senderNum: userInfo.number, senderName: userInfo.pushName, receiverJid: receiverJid, receiverNum: receiverInfo.number, receiverName: receiverInfo.pushName, text: anonText, timestamp: Date.now(), type: 'anonimo' });
        storage.flagSave();
        try {
            await sock.sendMessage(receiverJid, { text: '🎭 ━ *CORREIO ANÔNIMO* ━ \n\n💬 *"' + anonText + '"*\n\n🕵️ *Remetente:* _Alguém secreto_\n🔖 *ID:* #' + anonId + '\n\n━━━━━━━━━━\n↩️ Responder: `!responder ' + anonId + ' sua resposta`' });
            await sock.sendMessage(chatId, { text: '💌 *Correio enviado!*\n📮 Para: ' + receiverInfo.nameAndNumber + '\n🔖 #' + anonId }, { quoted: msg });
        } catch (e) { await sock.sendMessage(chatId, { text: '❌ Não foi possível entregar.' }, { quoted: msg }); return; }
        const adminGroup = storage.data.cache?.adminGroupId;
        if (adminGroup) {
            try {
                const timeStr = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                const footer = '📱 ' + userInfo.formattedNum + '   •   🕒 ' + timeStr;
                const card = await generateNglCard(anonText, footer);
                await sock.sendMessage(adminGroup, { image: card, caption: '🎭 *NOVO CORREIO ANÔNIMO*\n\n💬 "' + anonText + '"\n🕒 *Horário:* ' + timeStr + '\n👤 *Remetente:* ' + userInfo.nameAndNumber });
            } catch (e) { console.error('[ERRO CARD NGL]', (e as any).message); }
        }
        return;
    }
    if (firstWord === '!responder') {
        const parts = text.trim().split(/\s+/);
        const targetId = (parts[1] || '').replace('#', '').toUpperCase();
        const replyText = text.replace(firstWord, '').replace(new RegExp('#?' + targetId, 'i'), '').trim();
        if (!targetId || !replyText) { await sock.sendMessage(chatId, { text: '🎭 *Uso:*\n`!responder ID mensagem`' }, { quoted: msg }); return; }
        const originalMsg = (storage.data.anonMsgs || []).find(m => m.id === targetId);
        if (!originalMsg) { await sock.sendMessage(chatId, { text: '❌ ID #' + targetId + ' não encontrado.' }, { quoted: msg }); return; }
        if (originalMsg.receiverJid !== sender && !isSuperAdmin(userId, storage.data.users)) { await sock.sendMessage(chatId, { text: '❌ Só o destinatário original responde.' }, { quoted: msg }); return; }
        const replyId = storage.generateAnonId();
        storage.data.anonMsgs.push({ id: replyId, chatId: chatId, senderJid: sender, senderNum: userInfo.number, senderName: userInfo.pushName, receiverJid: originalMsg.senderJid, receiverNum: originalMsg.senderNum, receiverName: originalMsg.senderName, text: replyText, timestamp: Date.now(), type: 'resposta', replyToId: targetId });
        storage.flagSave();
        await sock.sendMessage(originalMsg.senderJid, { text: '🎭 ━ *RESPOSTA ANÔNIMA* ━ 🎭\n\n💬 *"' + replyText + '"*\n\n🔗 Referente a: #' + targetId });
        await sock.sendMessage(chatId, { text: '💌 *Resposta enviada!* 🔖 #' + replyId }, { quoted: msg });
        return;
    }
    if (firstWord === '!vercorreio') {
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 4) { await sock.sendMessage(chatId, { text: '❌ Apenas nível 4+.' }, { quoted: msg }); return; }
        if (!storage.data.anonMsgs || storage.data.anonMsgs.length === 0) { await sock.sendMessage(chatId, { text: 'ℹ️ Nenhum correio registrado.' }, { quoted: msg }); return; }
        let report = '🎭 ━ *LOG DO CORREIO* ━ 🎭\n\n';
        storage.data.anonMsgs.slice(-20).reverse().forEach(m => {
            report += (m.type === 'resposta' ? '↩️' : '📩') + ' #' + m.id + ' — ' + new Date(m.timestamp).toLocaleString('pt-BR') + '\n' +
                '👤 De: ' + m.senderName + ' - +' + m.senderNum + '\n🎯 Para: ' + m.receiverName + ' - +' + m.receiverNum + '\n💬 "' + m.text.substring(0, 80) + '"\n\n';
        });
        await sock.sendMessage(chatId, { text: report }, { quoted: msg });
        return;
    }
    if (firstWord === '!limparcorreio') {
        if (!isSuperAdmin(userId, storage.data.users)) { await sock.sendMessage(chatId, { text: '❌ Apenas super admin.' }, { quoted: msg }); return; }
        const count = storage.data.anonMsgs?.length || 0;
        storage.data.anonMsgs = [];
        storage.data.anonCounter = 1000;
        storage.flagSave();
        await sock.sendMessage(chatId, { text: '✅ *Log limpo!* 🗑️ ' + count + ' registros removidos.' }, { quoted: msg });
        return;
    }
    if (['!s', '!sticker', '!figurinha'].includes(firstWord)) {
        try {
            const targetMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage ? { key: { remoteJid: chatId, id: msg.message.extendedTextMessage.contextInfo.stanzaId, participant: msg.message.extendedTextMessage.contextInfo.participant }, message: msg.message.extendedTextMessage.contextInfo.quotedMessage } : msg;
            const isMedia = targetMsg.message?.imageMessage || targetMsg.message?.videoMessage;
            if (!isMedia) { await sock.sendMessage(chatId, { text: '❌ Responda imagem/vídeo com !s' }, { quoted: msg }); return; }
            const mediaBuffer = await downloadMediaMessage(targetMsg as any, 'buffer', {});
            if (!mediaBuffer) { await sock.sendMessage(chatId, { text: '❌ Não foi possível baixar.' }, { quoted: msg }); return; }
            const stickerBuffer = await imageToStickerBuffer(mediaBuffer);
            await sock.sendMessage(chatId, { sticker: stickerBuffer }, { quoted: msg });
        } catch (err: any) { await sock.sendMessage(chatId, { text: '❌ Erro em figurinha.' }, { quoted: msg }); }
        return;
    }
    if (['!s2img', '!baixarfig', '!fig'].includes(firstWord)) {
        try {
            const targetMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage ? { key: { remoteJid: chatId, id: msg.message.extendedTextMessage.contextInfo.stanzaId, participant: msg.message.extendedTextMessage.contextInfo.participant }, message: msg.message.extendedTextMessage.contextInfo.quotedMessage } : msg;
            const isSticker = targetMsg.message?.stickerMessage;
            if (!isSticker) { await sock.sendMessage(chatId, { text: '❌ Responda figurinha com !s2img' }, { quoted: msg }); return; }
            const stickerMediaBuffer = await downloadMediaMessage(targetMsg as any, 'buffer', {});
            if (!stickerMediaBuffer) { await sock.sendMessage(chatId, { text: '❌ Não foi possível.' }, { quoted: msg }); return; }
            const imageBuffer = await stickerToImageBuffer(stickerMediaBuffer);
            await sock.sendMessage(chatId, { image: imageBuffer, caption: '🖼️ Extraída!' }, { quoted: msg });
        } catch (err: any) { await sock.sendMessage(chatId, { text: '❌ Erro.' }, { quoted: msg }); }
        return;
    }
    if (text.toLowerCase() === '!n') {
        storage.data.states[userId] = { mode: 'news_menu' };
        storage.flagSave();
        await sock.sendMessage(chatId, { text: '📰 *NOTÍCIAS*\n\n1 - Globais\n2 - Regionais\n3 - Por Tópicos', mentions: [userInfo.jid] });
        return;
    }
    if (state && state.mode === 'news_menu') {
        if (text === '1') { delete storage.data.states[userId]; storage.flagSave(); const newsData = await fetchNews('Mundo OR Internacional', 6); await sock.sendMessage(chatId, { text: '🌍 *Globais*\n\n' + newsData }); return; }
        else if (text === '2') { state.mode = 'news_city'; storage.flagSave(); await sock.sendMessage(chatId, { text: '🏙️ Qual cidade/estado?' }); return; }
        else if (text === '3') { state.mode = 'news_topics_menu'; storage.flagSave(); let topicsMenu = '📋 *TÓPICOS*\n\n'; for (const [key, value] of Object.entries(NEWS_TOPICS)) topicsMenu += key + ' - ' + value.name + '\n'; await sock.sendMessage(chatId, { text: topicsMenu }); return; }
    }
    if (state && state.mode === 'news_city') {
        const region = text;
        delete storage.data.states[userId];
        storage.flagSave();
        const newsData = await fetchNews(region, 5);
        await sock.sendMessage(chatId, { text: '📍 *' + region.toUpperCase() + '*\n\n' + newsData });
        return;
    }
    if (state && state.mode === 'news_topics_menu') {
        const topicObj = NEWS_TOPICS[text];
        if (!topicObj) return;
        delete storage.data.states[userId];
        storage.flagSave();
        const newsData = await fetchNews(topicObj.query, 5);
        await sock.sendMessage(chatId, { text: '📌 *' + topicObj.name.toUpperCase() + '*\n\n' + newsData });
        return;
    }
    if (text.toLowerCase() === '!h') {
        storage.data.states[userId] = { mode: 'horoscope_menu' };
        storage.flagSave();
        await sock.sendMessage(chatId, { text: '✨ *HORÓSCOPO*\n\n1 - Todos os signos\n2 - Seu signo', mentions: [userInfo.jid] });
        return;
    }
    if (state && state.mode === 'horoscope_menu') {
        const currentDate = new Date().toLocaleDateString('pt-BR');
        if (text === '1') {
            delete storage.data.states[userId];
            storage.flagSave();
            let report = '✨ *HORÓSCOPO ' + currentDate + '*\n\n';
            const promises = SIGNS.map(async (s) => { const data = await fetchHoroscope(s.name, false); return s.emoji + ' *' + s.name + '*\n_' + data + '_\n\n'; });
            const results = await Promise.all(promises);
            report += results.join('');
            await sock.sendMessage(chatId, { text: report });
            return;
        } else if (text === '2') {
            state.mode = 'horoscope_sign';
            storage.flagSave();
            let signMenu = '🔮 *ESCOLHA:*\n\n';
            SIGNS.forEach(s => { signMenu += s.id + ' - ' + s.emoji + ' ' + s.name + '\n'; });
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
        await sock.sendMessage(chatId, { text: '✨ *' + selectedSign.name + '*\n\n' + webData + '\n\n📅 ' + currentDate });
        return;
    }
    if (text.toLowerCase() === '!t') {
        storage.data.states[userId] = { mode: 'weather_menu' };
        storage.flagSave();
        await sock.sendMessage(chatId, { text: '🌤️ *CLIMA*\n\n1 - Hoje\n2 - Próximos dias', mentions: [userInfo.jid] });
        return;
    }
    if (state && state.mode === 'weather_menu') {
        if (text === '1' || text === '2') { state.mode = 'weather_city'; state.weatherType = text === '1' ? 'hoje' : 'semana'; storage.flagSave(); await sock.sendMessage(chatId, { text: '🏙️ Qual cidade?' }); return; }
    }
    if (state && state.mode === 'weather_city') {
        const city = text;
        const weatherType = state.weatherType;
        delete storage.data.states[userId];
        storage.flagSave();
        try {
            const res = await axios.get('https://wttr.in/' + encodeURIComponent(city) + '?format=j1&lang=pt');
            const data = res.data;
            if (weatherType === 'hoje') {
                const current = data.current_condition[0];
                const today = data.weather[0];
                const desc = current.lang_pt ? current.lang_pt[0].value : current.weatherDesc[0].value;
                await sock.sendMessage(chatId, { text: '🌤️ *' + city.toUpperCase() + '*\n\n' + desc + '\n' + current.temp_C + '°C\nMín/Máx: ' + today.mintempC + '/' + today.maxtempC + '°C' });
            } else {
                let reply = '📅 *Próximos dias: ' + city.toUpperCase() + '*\n\n';
                data.weather.forEach((day: any) => {
                    const dateParts = day.date.split('-');
                    const desc = day.hourly[4].lang_pt ? day.hourly[4].lang_pt[0].value : day.hourly[4].weatherDesc[0].value;
                    reply += dateParts[2] + '/' + dateParts[1] + ': ' + day.mintempC + '°C a ' + day.maxtempC + '°C | ' + desc + '\n';
                });
                await sock.sendMessage(chatId, { text: reply });
            }
        } catch (e) { await sock.sendMessage(chatId, { text: '❌ Cidade não encontrada.' }); }
        return;
    }
    if (text.toLowerCase() === '!f') {
        storage.data.states[userId] = { mode: 'football_menu' };
        storage.flagSave();
        await sock.sendMessage(chatId, { text: '⚽ *FUTEBOL*\n\n1 - Brasileirão A\n2 - Copa do Brasil\n3 - Libertadores\n4 - Paulistão\n5 - Champions', mentions: [userInfo.jid] });
        return;
    }
    if (state && state.mode === 'football_menu') {
        const champObj = FOOTBALL_CHAMPIONSHIPS[text];
        if (!champObj) return;
        state.mode = 'football_query';
        state.leagueId = champObj.id;
        state.leagueName = champObj.name;
        storage.flagSave();
        await sock.sendMessage(chatId, { text: '📝 *' + champObj.name + '*\n\n1 - Tabela\n2 - Próximos Jogos\n3 - Artilheiros' });
        return;
    }
    if (state && state.mode === 'football_query') {
        let queryType = text === '1' ? 'standings' : text === '2' ? 'fixtures' : text === '3' ? 'topscorers' : null;
        if (!queryType) return;
        const leagueId = state.leagueId;
        delete storage.data.states[userId];
        storage.flagSave();
        const apiResponseText = await fetchFootballData(leagueId, queryType, storage.data.cache);
        await sock.sendMessage(chatId, { text: apiResponseText });
        return;
    }
    if (firstWord === '!r') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        try {
            const cluster = storage.data.memoryCluster?.[chatId] || [];
            const clusterStrings = cluster.map(m => m.authorName + ': ' + m.text);
            if (clusterStrings.length === 0) { await sock.sendMessage(chatId, { text: 'ℹ️ Sem mensagens recentes.' }); return; }
            const dateStrLog = new Date().toLocaleDateString('pt-BR');
            const promptMeta = 'Resumo do grupo:\n\n📌 *RELATÓRIO JARVIS*\n📅 ' + dateStrLog + '\n\n🗣️ Tópicos:\n👥 Membros:\n🌟 Clima:';
            const summaryText = await callAI(promptMeta, clusterStrings);
            await sock.sendMessage(chatId, { text: summaryText });
        } catch (e) { await sock.sendMessage(chatId, { text: '❌ Erro no resumo.' }); }
        return;
    }
    if (['!moeda', '!cotacao'].includes(firstWord)) { await sock.sendMessage(chatId, { text: await fetchCurrency() }, { quoted: msg }); return; }
    if (['!wiki', '!wikipedia'].includes(firstWord)) {
        const q = text.replace(firstWord, '').trim();
        if (!q) { await sock.sendMessage(chatId, { text: '⚠️ Use: `!wiki termo`' }, { quoted: msg }); return; }
        await sock.sendMessage(chatId, { text: await fetchWikipedia(q) }, { quoted: msg });
        return;
    }
    if (firstWord === '!qrcode') {
        const q = text.replace(firstWord, '').trim();
        if (!q) { await sock.sendMessage(chatId, { text: '⚠️ Digite o texto/link.' }, { quoted: msg }); return; }
        try {
            const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(q);
            const res = await axios.get(qrUrl, { responseType: 'arraybuffer' });
            await sock.sendMessage(chatId, { image: Buffer.from(res.data), caption: '📱 QR Code' }, { quoted: msg });
        } catch (e) { await sock.sendMessage(chatId, { text: '❌ Erro no QR.' }, { quoted: msg }); }
        return;
    }
    if (['!quiz', '!charada'].includes(firstWord)) {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const q = QUIZ_DATABASE[Math.floor(Math.random() * QUIZ_DATABASE.length)];
        storage.data.activeQuiz[chatId] = { question: q.question, answer: q.answer.toLowerCase().trim(), startedBy: userId, date: Date.now() };
        storage.flagSave();
        await sock.sendMessage(chatId, { text: '🧩 *QUIZ*\n\n❓ ' + q.question + '\n\nResponda no chat!' });
        return;
    }
    if (firstWord === '!regras') {
        if (!isGroup) return;
        if (text.toLowerCase().startsWith('!regras definir ')) {
            const userRole = parseInt(getUserRole(userId, storage.data.users));
            if (userRole < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas admins.' }); return; }
            storage.data.groupRules[chatId] = text.slice('!regras definir '.length).trim();
            storage.flagSave();
            await sock.sendMessage(chatId, { text: '📋 *REGRAS ATUALIZADAS!*' });
            return;
        }
        const rules = storage.data.groupRules[chatId];
        await sock.sendMessage(chatId, { text: rules ? '📋 *REGRAS*\n\n' + rules : '📋 *REGRAS*\n\n_Nenhuma regra._' });
        return;
    }
    if (['!sa', '!boasvindas'].includes(firstWord)) {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas admins.' }, { quoted: msg }); return; }
        let customText = '';
        if (text.includes('+')) customText = text.slice(text.indexOf('+') + 1).trim();
        else customText = text.slice(firstWord.length).trim();
        if (customText.toLowerCase() === 'off') {
            if (storage.data.welcomeMsgs && storage.data.welcomeMsgs[chatId]) { delete storage.data.welcomeMsgs[chatId]; storage.flagSave(); await sock.sendMessage(chatId, { text: '🛑 Saudação desativada.' }, { quoted: msg }); return; }
            await sock.sendMessage(chatId, { text: 'ℹ️ Sem saudação ativa.' }, { quoted: msg });
            return;
        }
        if (!customText) {
            const current = storage.data.welcomeMsgs?.[chatId]?.text;
            await sock.sendMessage(chatId, { text: '👋 *SAUDAÇÃO*\n\nAtual: ' + (current || '_padrão_') + '\n\n*Use:* `!sa mensagem` ou `!sa off`' }, { quoted: msg });
            return;
        }
        if (!storage.data.welcomeMsgs) storage.data.welcomeMsgs = {};
        storage.data.welcomeMsgs[chatId] = { text: customText, setBy: userId, date: new Date().toISOString() };
        storage.flagSave();
        await sock.sendMessage(chatId, { text: '✅ *SAUDAÇÃO CONFIGURADA*\n\n' + customText }, { quoted: msg });
        return;
    }
    if (firstWord === '!bv') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas admins.' }, { quoted: msg }); return; }
        let customText = '';
        if (text.includes('+')) customText = text.slice(text.indexOf('+') + 1).trim();
        else customText = text.slice(firstWord.length).trim();
        if (customText.toLowerCase() === 'off') {
            if (storage.data.welcomeReminders && storage.data.welcomeReminders[chatId]) { delete storage.data.welcomeReminders[chatId]; storage.flagSave(); await sock.sendMessage(chatId, { text: '🛑 Lembrete desativado.' }, { quoted: msg }); return; }
            await sock.sendMessage(chatId, { text: 'ℹ️ Sem lembrete.' }, { quoted: msg });
            return;
        }
        if (!customText) {
            const current = storage.data.welcomeReminders?.[chatId]?.text;
            await sock.sendMessage(chatId, { text: '🔔 *LEMBRETE 15MIN*\n\nAtual: ' + (current || '_nenhum_') + '\n\n*Use:* `!bv mensagem` ou `!bv off`' }, { quoted: msg });
            return;
        }
        if (!storage.data.welcomeReminders) storage.data.welcomeReminders = {};
        storage.data.welcomeReminders[chatId] = { text: customText, setBy: userId, date: new Date().toISOString() };
        storage.flagSave();
        await sock.sendMessage(chatId, { text: '✅ *LEMBRETE CONFIGURADO*\n\n' + customText }, { quoted: msg });
        return;
    }
    if (['!exit', '!saida'].includes(firstWord)) {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas admins.' }, { quoted: msg }); return; }
        let customText = '';
        if (text.includes('+')) customText = text.slice(text.indexOf('+') + 1).trim();
        else customText = text.slice(firstWord.length).trim();
        if (customText.toLowerCase() === 'off') {
            if (storage.data.exitMsgs && storage.data.exitMsgs[chatId]) { delete storage.data.exitMsgs[chatId]; storage.flagSave(); await sock.sendMessage(chatId, { text: '🛑 Despedida desativada.' }, { quoted: msg }); return; }
            await sock.sendMessage(chatId, { text: 'ℹ️ Sem despedida.' }, { quoted: msg });
            return;
        }
        if (!customText) {
            const current = storage.data.exitMsgs?.[chatId]?.text;
            await sock.sendMessage(chatId, { text: '👋 *DESPEDIDA*\n\nAtual: ' + (current || '_nenhuma_') + '\n\n*Use:* `!exit mensagem` ou `!exit off`' }, { quoted: msg });
            return;
        }
        if (!storage.data.exitMsgs) storage.data.exitMsgs = {};
        storage.data.exitMsgs[chatId] = { text: customText, setBy: userId, date: new Date().toISOString() };
        storage.flagSave();
        await sock.sendMessage(chatId, { text: '✅ *DESPEDIDA CONFIGURADA*\n\n' + customText }, { quoted: msg });
        return;
    }
    if (text.toLowerCase() === '!ajuda') {
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        const isAdmin = userRole >= 2;
        let menu = '🤖 *JARVIS BOT2.0* 🤖\n\n';
        menu += '*🔌 CONTROLE*\n';
        menu += '`!bot on/off` - Ligar/desligar\n';
        menu += '`!divulga` - Divulgação\n';
        menu += '`!admins` - Listar admins\n\n';
        menu += '*🧠 JARVIS*\n';
        menu += '`!jarvis on/off` - Análise em tempo real\n';
        menu += '`!ia [pergunta]` - Consulta IA\n';
        menu += '`!status` - Painel\n\n';
        menu += '*🎨 DIVERSÃO*\n';
        menu += '`!s` `!s2img` - Figurinhas\n';
        menu += '`!quiz` `!qrcode` `!sorteio`\n';
        menu += '`!moeda` `!wiki` `!rank`\n\n';
        menu += '*📰 UTIL*\n';
        menu += '`!n` `!h` `!t` `!f`\n';
        menu += '`!regras` `!id`';
        if (isAdmin) {
            menu += '\n\n*🛡️ ADMIN*\n';
            menu += '`!megafone + msg`\n';
            menu += '`!antilink on/off`\n';
            menu += '`!antifake on/off`\n';
            menu += '`!antighost on/off`\n';
            menu += '`!warn @membro`\n';
            menu += '`!ban @membro`\n';
            menu += '`!fechar` `!abrir`\n';
            menu += '`!sa` `!bv` `!exit`\n';
            menu += '`!inativos` `!m` `!r`\n';
            menu += '`!idgrupo` `!linkcorreio`\n';
            menu += '`!cadastroidgrupo`\n';
            menu += '`!anonimo` `!responder`\n';
            menu += '`!vercorreio` `!limparcorreio`';
        }
        if (userRole === 5) {
            menu += '\n\n*👑 SUPER ADMIN*\n';
            menu += '`!cadastro+num+nivel`\n';
            menu += '`!remover`';
        }
        await sock.sendMessage(chatId, { text: menu, mentions: [userInfo.jid] });
        return;
    }
    if (firstWord.startsWith('!') && !isNavigatingMenu) {
        const suggestion = findSuggestedCommand(firstWord);
        if (suggestion) { await sock.sendMessage(chatId, { text: '💡 Você quis dizer `' + suggestion + '`?' }, { quoted: msg }); return; }
        await sock.sendMessage(chatId, { text: '🤖 Comando não reconhecido.', mentions: [SETTINGS.CREATOR_JID] }, { quoted: msg });
        return;
    }
}