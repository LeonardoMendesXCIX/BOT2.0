import { WASocket, proto, downloadMediaMessage } from '@whiskeysockets/baileys';
import { StorageManager } from '../database/storage';
import { RBAC, getUserRole, hasPermission, isSuperAdmin, checkMatch } from '../config/rbac';
import { SIGNS, FOOTBALL_CHAMPIONSHIPS, NEWS_TOPICS, FEATURE_MAP, FEATURE_NAMES, SETTINGS } from '../config/settings';
import { callAI, evaluateAutonomousIntervention } from '../services/ai';
import { checkImageNSFW } from '../services/nsfw';
import { transcribeAudio } from '../services/transcription';
import { generateTTS } from '../services/tts';
import { fetchHoroscope } from '../services/horoscope';
import { fetchNews } from '../services/news';
import { fetchFootballData } from '../services/football';
import { fetchWikipedia } from '../services/wikipedia';
import { imageToStickerBuffer, stickerToImageBuffer } from '../utils/sticker';
import { getUserInfo, updateLidMapping, extractRawNumber, detectBrazilianNumber, UserDisplayInfo, lidMap, contactCache } from '../utils/user';
import { generateNglCard, generateProfileCard, generateMemeCard, generateQuoteCard, generateTextSticker } from '../services/nglCard';
import { downloadMedia, translateText, defineWord, removeBackground, fetchLiveMatches } from '../services/media';
import { getHHMM, isWithinWindow } from '../utils/time';
import axios from 'axios';
import { searchYouTube, getAudioBuffer, getVideoBuffer } from '../services/ytDownloader';
import { consultarN8nSugestao } from '../utils/n8n';
import { extractPhoneFromImage } from '../services/reportService';

const userMessageHistory: Record<string, number[]> = {};
const stickerHistory: Record<string, number[]> = {};
const musicCooldowns: Record<string, number> = {};
const aiCooldowns: Record<string, Record<string, number>> = {};
const lastAdminResponse = new Map<string, number>();

const DDI_COUNTRIES: Record<string, string> = {
    '246': 'Diego Garcia', '993': 'Turcomenistão', '682': 'Ilhas Cook', '351': 'Portugal',
    '256': 'Uganda', '252': 'Somália', '243': 'RD Congo', '240': 'Guiné Equatorial',
    '237': 'Camarões', '234': 'Nigéria', '93': 'Afeganistão', '92': 'Paquistão',
    '91': 'Índia', '90': 'Turquia', '86': 'China', '81': 'Japão', '64': 'Nova Zelândia',
    '62': 'Indonésia', '58': 'Venezuela', '54': 'Argentina', '53': 'Cuba', '49': 'Alemanha',
    '47': 'Noruega', '44': 'Reino Unido', '39': 'Itália', '34': 'Espanha', '33': 'França',
    '32': 'Bélgica', '27': 'África do Sul', '20': 'Egito', '7': 'Rússia',
    '1': 'EUA/Canadá', '55': 'Brasil'
};

function ddiCountry(num: string): string {
    const prefixes = Object.keys(DDI_COUNTRIES).sort((a, b) => b.length - a.length);
    for (const prefix of prefixes) {
        if (num.startsWith(prefix)) return DDI_COUNTRIES[prefix];
    }
    return 'Desconhecido';
}

function resolveTargetJid(msg: any, text: string): string {
    const ctx = msg.message?.extendedTextMessage?.contextInfo;
    if (ctx?.mentionedJid && ctx.mentionedJid[0]) return ctx.mentionedJid[0];
    if (ctx?.participant) return ctx.participant;
    const m = text.match(/@(\d{6,})/);
    if (m) return m[1] + '@s.whatsapp.net';
    return '';
}

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

    if (storage.data.maintenance === true && firstWord !== '!botmanutencao') return;

    if (firstWord === '!botmanutencao') {
        const subArg = text.slice(firstWord.length).trim().toLowerCase();
        if (subArg === 'off') {
            if (!isSuperAdmin(userId, storage.data.users)) { await sock.sendMessage(chatId, { text: '❌ Apenas super admin pode retirar do modo manutenção.' }, { quoted: msg }); return; }
            storage.data.maintenance = false;
            storage.flagSave();
            await sock.sendMessage(chatId, { text: '🟢 *BOT DROPHTTP ONLINE NOVAMENTE!*\n\n🤖 O bot saiu do modo manutenção e voltou a operar normalmente.' });
            return;
        }
        if (!isSuperAdmin(userId, storage.data.users)) { await sock.sendMessage(chatId, { text: '❌ Apenas super admin pode ativar o modo manutenção.' }, { quoted: msg }); return; }
        if (storage.data.maintenance === true) { await sock.sendMessage(chatId, { text: 'ℹ️ O bot já está em modo manutenção. Use `!botmanutencao off` para voltar.' }, { quoted: msg }); return; }
        await sock.sendMessage(chatId, { text: '🛠️ *INICIANDO MODO MANUTENÇÃO*\n\n⚠️ O bot entrará em modo offline em breve.\n\nContagem regressiva iniciada...' }, { quoted: msg });
        for (let i = 10; i >= 0; i--) {
            await new Promise(r => setTimeout(r, 1000));
            await sock.sendMessage(chatId, { text: '⏱️ *' + i + '*' });
        }
        storage.data.maintenance = true;
        storage.flagSave();
        await sock.sendMessage(chatId, { text: '⚠️ *Bot em modo offline (MANUTENÇÃO)*\n\nO BOT DROPHTTP foi temporariamente desativado para manutenção.\n_Use `!botmanutencao off` para voltar ao normal._' });
        return;
    }

    if (!isGroup && !key.fromMe) {
        const creatorNum = '5511927018683';
        if (userInfo.number === creatorNum && storage.data.activeTicket && text && !text.startsWith('!')) {
            try { await sock.sendMessage(storage.data.activeTicket.userJid, { text: '🎫 *SUPORTE:*\n' + text }); } catch (e) { }
            return;
        }
        const businessHours = storage.data.businessHours;
        if (businessHours && text && !text.startsWith('!') && !isWithinWindow(businessHours.open, businessHours.close, getHHMM())) {
            await sock.sendMessage(chatId, { text: businessHours.msg + '\n\n🕐 Atendimento: ' + businessHours.open + ' às ' + businessHours.close + '.' }).catch(() => {});
            return;
        }
    }

    if (state && state.mode === 'inativos_confirm_removal') {
        const answer = textLower.trim();
        const isYes = ['sim', '1', 's', 'yes', 'si'].includes(answer);
        const isNo = ['nao', 'não', 'naõ', '2', 'n', 'no'].includes(answer);
        if (!isYes && !isNo) { await sock.sendMessage(chatId, { text: '⚠️ Responda *SIM* (ou 1) para confirmar a remoção, ou *NÃO* (ou 2) para cancelar.' }, { quoted: msg }); return; }
        const targetChat = state.targetChat || chatId;
        const inactiveList: any[] = state.inactiveList || [];
        delete storage.data.states[userId];
        storage.flagSave();
        if (isNo) { await sock.sendMessage(chatId, { text: '🛑 *Limpeza de inativos cancelada.* Nenhum integrante foi removido.' }, { quoted: msg }); return; }
        await sock.sendMessage(chatId, { text: '🧹 *BOT DROPHTTP:* Iniciando remoção de ' + inactiveList.length + ' integrante(s) inativo(s)...' }, { quoted: msg });
        let removedCount = 0;
        const removedNames: string[] = [];
        const removedMentions: string[] = [];
        for (const u of inactiveList) {
            const removeJid = u.removeJid || u.jid;
            try {
                await sock.groupParticipantsUpdate(targetChat, [removeJid], 'remove');
                removedCount++;
                removedNames.push('• ' + u.smartMention);
                if (u.mentionJid) removedMentions.push(u.mentionJid);
                if (u.jid) removedMentions.push(u.jid);
                await new Promise(r => setTimeout(r, 600));
            } catch (e: any) { console.error('[ERRO REMOVER INATIVO]', e.message); }
        }
        const report = '🧹 *LIMPEZA DE INATIVOS CONCLUÍDA!*\n\n📊 *Removidos:* ' + removedCount + ' de ' + inactiveList.length + '\n\n' + (removedNames.join('\n') || '_Nenhum integrante removido._');
        await sock.sendMessage(chatId, { text: report, mentions: removedMentions });
        const afterMsg = storage.data.inativosMsgs?.[targetChat]?.text;
        if (afterMsg) await sock.sendMessage(targetChat, { text: afterMsg });
        return;
    }

    const IGNORED_MULTIMEDIA_PREFIXES = ['!song', '!msc', '!tocar', '!ytmp3'];
    if (IGNORED_MULTIMEDIA_PREFIXES.includes(firstWord)) return;

    if (['!desenhe', '!criarimg', '!gerarimg', '!sorteio', '!quiz', '!charada', '!moeda', '!cotacao', '!qrcode'].includes(firstWord)) {
        await sock.sendMessage(chatId, { text: '⚠️ Este comando foi removido do BOT DROPHTTP.' }, { quoted: msg });
        return;
    }

    if (textLower.startsWith('!jarvis on') || textLower.startsWith('!jarvis off')) {
        await sock.sendMessage(chatId, { text: '⚠️ O comando !jarvis on/off foi removido do BOT DROPHTTP.' }, { quoted: msg });
        return;
    }

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
                await sock.sendMessage(chatId, { text: '🔴 *BOT DROPHTTP DESATIVADO NESTE GRUPO*\n\nO bot foi colocado em modo de espera exclusivo para este grupo.\n_Para reativar:_ `!bot on`', mentions: [userInfo.jid] });
            } else {
                await sock.sendMessage(chatId, { text: '🟢 *BOT DROPHTTP REATIVADO COM SUCESSO!*', mentions: [userInfo.jid] });
            }
            return;
        }
    }

    if (isGroup && storage.isBotDisabled(chatId)) {
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

    const wantsAdmins = firstWord === '!admins' || firstWord === '!adms' || (isGroup && textLower.includes('quem manda'));
    if (wantsAdmins && isGroup) {
        const roleNames: Record<string, string> = { '5': 'Super Admin', '4': 'Gestor', '3': 'Parceiro', '2': 'Admin' };
        const meta = await sock.groupMetadata(chatId).catch(() => null);
        const mentions: string[] = [];
        let txt = '👑 *ADMINISTRADORES*\n\n📱 *Do WhatsApp:*\n';
        
        if (meta) {
            updateLidMapping(meta.participants);
            const wa = meta.participants.filter((p: any) => p.admin);
            if (!wa.length) txt += '_nenhum_\n';
            for (const p of wa) {
                const participantName = p.name || p.notify || p.verifiedName || '';
                const info = getUserInfo(p.id, participantName);
                const numOnly = info.number || p.id.split('@')[0].split(':')[0].replace(/\D/g, '');
                const displayName = info.pushName || info.formattedNum || p.id;
                const mentionJid = info.mentionJid || p.id;
                txt += '• @' + numOnly + ' (' + displayName + ')' + (p.admin === 'superadmin' ? ' (dono)' : '') + '\n';
                mentions.push(mentionJid);
            }
        } else {
            txt += '_não foi possível ler o grupo_\n';
        }
        
        txt += '\n🤖 *Do Bot (cadastrados):*\n';
        let anyBot = false;
        const usersDb = storage.data.users || {};
        
        for (const num in usersDb) {
            const lvl = parseInt(usersDb[num]);
            if (!(lvl >= 2)) continue;
            anyBot = true;
            const inputJid = num.length > 15 ? num + '@lid' : num + '@s.whatsapp.net';
            const i = getUserInfo(inputJid, storage.data.cache?.names?.[num] || '');
            const numOnly = i.number || num;
            const displayName = i.pushName || i.formattedNum || numOnly || inputJid;
            
            const inGroup = !!meta && meta.participants.some((p: any) => {
                const pid = (p.id || '').split('@')[0].split(':')[0].replace(/\D/g, '');
                const plid = (((p as any).lid || '') + '').split('@')[0].split(':')[0].replace(/\D/g, '');
                return pid === numOnly || plid === numOnly || pid === i.number || plid === i.number;
            });
            
            if (inGroup) {
                txt += '• @' + numOnly + ' (' + displayName + ') (' + (roleNames[String(lvl)] || '') + ')\n';
                if (i.mentionJid) mentions.push(i.mentionJid);
            } else {
                txt += '• @' + numOnly + ' (' + displayName + ') (' + (roleNames[String(lvl)] || '') + ') — _fora deste grupo_\n';
                if (i.mentionJid) mentions.push(i.mentionJid);
            }
        }
        if (!anyBot) txt += '_nenhum_\n';
        
        await sock.sendMessage(chatId, { text: txt, mentions: Array.from(new Set(mentions)) }, { quoted: msg });
        return;
    }

    if (isGroup && !key.fromMe) {
        if (text && Math.random() < 0.4) {
            const gainedXp = 5 + Math.floor(Math.random() * 10);
            const gainedCoins = 1 + Math.floor(Math.random() * 3);
            const newXp = storage.addXp(chatId, userInfo.number, gainedXp);
            storage.addCoins(chatId, userInfo.number, gainedCoins);
            const newLevel = storage.getLevel(newXp);
            const prevLevel = storage.getLevel(newXp - gainedXp);
            if (newLevel > prevLevel) {
                const role = storage.getRoleByLevel(newLevel);
                await sock.sendMessage(chatId, {
                    text: '🎉 *LEVEL UP!* ' + userInfo.smartMention + ' subiu para o *Nível ' + newLevel + '* (' + role + ')!',
                    mentions: [userInfo.mentionJid, userInfo.jid]
                }).catch(() => {});
            }
        }
        if (text && !key.fromMe && text.trim().endsWith('?') && !text.startsWith('!') && storage.data.faqEnabled?.[chatId]) {
            const last = storage.data.lastFaqAnswer?.[chatId] || 0;
            if (Date.now() - last > 60000) {
                storage.data.lastFaqAnswer[chatId] = Date.now();
                storage.flagSave();
                const answer = await callAI('Responda de forma curta e útil (máx 2 linhas) à pergunta do grupo: ' + text);
                if (answer && !answer.toLowerCase().startsWith('erro')) {
                    await sock.sendMessage(chatId, { text: '🤖 *FAQ:*\n' + answer, mentions: [userInfo.jid] }).catch(() => {});
                }
            }
        }

        const pc = storage.data.pendingCaptcha?.[chatId]?.[userInfo.number];
        if (pc) {
            if (Date.now() > pc.expires) {
                delete storage.data.pendingCaptcha[chatId][userInfo.number];
                storage.flagSave();
                try {
                    await sock.groupParticipantsUpdate(chatId, [sender], 'remove');
                    await sock.sendMessage(chatId, { text: '⏰ ' + userInfo.smartMention + ' não respondeu o captcha a tempo. Removido.', mentions: [userInfo.mentionJid, userInfo.jid] });
                } catch (e) { }
                return;
            }
            if (text.trim() === pc.code) {
                delete storage.data.pendingCaptcha[chatId][userInfo.number];
                storage.flagSave();
                await sock.sendMessage(chatId, { text: '✅ ' + userInfo.smartMention + ' verificado com sucesso! Bem-vindo(a)! 🎉', mentions: [userInfo.mentionJid, userInfo.jid] });
                return;
            }
        }

        if (storage.data.dailyQuota?.[chatId]) {
            const roleQ = parseInt(getUserRole(userId, storage.data.users));
            if (roleQ < 2) {
                const q = storage.checkDailyQuota(chatId, userInfo.number);
                if (!q.allowed) {
                    try { await sock.sendMessage(chatId, { delete: key }); } catch (e) { }
                    if (q.used === q.limit + 1) {
                        await sock.sendMessage(chatId, { text: '🛑 ' + userInfo.smartMention + ', você atingiu o limite de *' + q.limit + ' mensagens/dia* neste grupo.', mentions: [userInfo.mentionJid, userInfo.jid] });
                    }
                    return;
                }
            }
        }

        if (storage.data.lockMedia?.[chatId] === true) {
            const roleM = parseInt(getUserRole(userId, storage.data.users));
            if (roleM < 2) {
                const hasLockedMedia = !!(msg.message?.imageMessage || msg.message?.videoMessage || msg.message?.audioMessage || msg.message?.documentMessage || msg.message?.stickerMessage);
                if (hasLockedMedia) {
                    try { await sock.sendMessage(chatId, { delete: key }); } catch (e) { }
                    return;
                }
            }
        }

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
                    await storage.applyWarning(sock, chatId, sender, 'Flood/Spam');
                    return;
                }
            }
            const userNumMod = userInfo.number;
            const userRoleMod = parseInt(getUserRole(userId, storage.data.users));
            const isAdmMod = userRoleMod >= 2;

            if (!isAdmMod && storage.isMuted(chatId, userNumMod)) {
                try { await sock.sendMessage(chatId, { delete: key }); } catch (e) { }
                return;
            }

            const isFwdOn = !storage.isFeatureDisabled(chatId, 'antiforward');
            if (isFwdOn && !isAdmMod) {
                const ctx: any = msg.message?.extendedTextMessage?.contextInfo || msg.message?.imageMessage?.contextInfo || msg.message?.videoMessage?.contextInfo || msg.message?.stickerMessage?.contextInfo;
                const isForwarded = !!(ctx?.isForwarded) || (ctx?.forwardingScore || 0) > 0;
                if (isForwarded) {
                    try { await sock.sendMessage(chatId, { delete: key }); } catch (e) { }
                    await storage.applyWarning(sock, chatId, sender, 'Encaminhamento proibido');
                    return;
                }
            }

            const words = storage.data.blacklistWords?.[chatId] || [];
            if (words.length && !isAdmMod && text) {
                const low = text.toLowerCase();
                if (words.some(w => low.includes(w.toLowerCase()))) {
                    try { await sock.sendMessage(chatId, { delete: key }); } catch (e) { }
                    await storage.applyWarning(sock, chatId, sender, 'Palavra proibida');
                    return;
                }
            }

            if (!storage.isFeatureDisabled(chatId, 'antistickerflood') && !isAdmMod && msg.message?.stickerMessage) {
                const sk = chatId + '_' + userNumMod;
                if (!stickerHistory[sk]) stickerHistory[sk] = [];
                const nowS = Date.now();
                stickerHistory[sk].push(nowS);
                stickerHistory[sk] = stickerHistory[sk].filter(t => nowS - t < 5000);
                if (stickerHistory[sk].length > 3) {
                    try { await sock.sendMessage(chatId, { delete: key }); } catch (e) { }
                    stickerHistory[sk] = [];
                    await storage.applyWarning(sock, chatId, sender, 'Flood de figurinhas');
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
                        await sock.sendMessage(chatId, { text: '🚫 *ANTI-LINK (EXPULSÃO AUTOMÁTICA)* 🚫\n\n👤 ' + userInfo.smartMention + '\n📝 Envio de link não autorizado.', mentions: [userInfo.mentionJid, userInfo.jid] });
                        return;
                    } catch (errKick: any) { console.error('[ERRO KICK ANTI-LINK]', errKick.message); }
                }
            }
        }
        const isNsfwOn = storage.data.antinsfw?.[chatId] === true;
        if (isNsfwOn && isGroup && !key.fromMe) {
            const userRole2 = getUserRole(userId, storage.data.users);
            const isAdm2 = parseInt(userRole2) >= 2;
            if (!isAdm2) {
                const imgMsg = msg.message?.imageMessage ||
                    msg.message?.viewOnceMessage?.message?.imageMessage ||
                    msg.message?.viewOnceMessageV2?.message?.imageMessage ||
                    msg.message?.ephemeralMessage?.message?.imageMessage;
                if (imgMsg) {
                    try {
                        const buf = await downloadMediaMessage(msg as any, 'buffer', {});
                        if (buf) {
                            const isNsfw = await checkImageNSFW(buf);
                            if (isNsfw) {
                                try { await sock.sendMessage(chatId, { delete: key }); } catch (e) { }
                                await storage.applyWarning(sock, chatId, sender, 'Conteúdo impróprio (NSFW) detectado');
                                return;
                            }
                        }
                    } catch (e) { }
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
                        await sock.sendMessage(chatId, { text: '🎙️ *TRANSCRIÇÃO AUTOMÁTICA*\n👤 ' + userInfo.smartMention + '\n\n📝 "' + transcript + '"', mentions: [userInfo.mentionJid, userInfo.jid] }, { quoted: msg });
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
            await storage.applyWarning(sock, chatId, sender, 'Caracteres invisíveis');
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

    if (isGroup && !key.fromMe && userInfo.number && userInfo.number.length <= 13) {
        if (!storage.data.firstMsgSeen) storage.data.firstMsgSeen = {};
        if (!storage.data.firstMsgSeen[chatId]) storage.data.firstMsgSeen[chatId] = {};
        if (!storage.data.firstMsgSeen[chatId][userInfo.number]) {
            storage.data.firstMsgSeen[chatId][userInfo.number] = true;
            storage.flagSave();
            
            const isBR = detectBrazilianNumber(userInfo.number);
            let pais = 'Desconhecido';
            let ddi = '??';

            if (isBR) {
                pais = 'Brasil';
                ddi = '55';
            } else {
                pais = ddiCountry(userInfo.number);
                const prefixes = Object.keys(DDI_COUNTRIES).sort((a, b) => b.length - a.length);
                for (const prefix of prefixes) {
                    if (userInfo.number.startsWith(prefix)) { ddi = prefix; break; }
                }
            }

            await sock.sendMessage(chatId, {
                text: '🌐 *PRIMEIRA MENSAGEM DETECTADA*\n\n👤 ' + userInfo.smartMention +
                    '\n📍 Número registrado em: *' + pais + '* (DDI +' + ddi + ')' +
                    '\n🌍 Origem: ' + (isBR ? '🇧🇷 Brasil' : '🌍 Exterior') +
                    '\n🕐 Primeira msg no grupo: ' + new Date().toLocaleString('pt-BR') +
                    '\n\n_(O WhatsApp não expõe a data de criação da conta nem a localização GPS real; mostramos o país de registro do número.)_',
                mentions: [userInfo.mentionJid]
            }).catch(() => {});
        }
    }

    if (!text) return;
    if (key.fromMe && !text.startsWith('!')) return;
    if (isGroup && !storage.isGroupClosed(chatId) && !text.startsWith('!')) {
        const cluster = storage.data.memoryCluster?.[chatId] || [];
        const clusterStrings = cluster.map(m => m.authorName + ' (+' + m.authorNum + '): ' + m.text);
        const now = Date.now();
        const lastIntervention = storage.data.lastJarvisIntervention?.[chatId] || 0;
        const msgCountSince = storage.data.messageCountSinceLastJarvis?.[chatId] || 0;
        const botJidPart = sock.user?.id?.split(':')[0] || '';
        const isExplicitCall = textLower.includes('drophttp') ||
            (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.some(j => j.includes(botJidPart))) ||
            (msg.message?.extendedTextMessage?.contextInfo?.participant?.includes(botJidPart));
        if (isExplicitCall) {
            try {
                const cleanQuery = text.replace(/drophttp/gi, '').replace(/@\d+/g, '').trim() || text;
                const prompt = 'O integrante ' + userInfo.pushName + ' disse: "' + cleanQuery + '". Responda como BOT DROPHTTP.';
                const aiResponse = await callAI(prompt, clusterStrings);
                if (aiResponse && !aiResponse.toLowerCase().includes('erro')) {
                    storage.data.lastJarvisIntervention[chatId] = now;
                    storage.data.messageCountSinceLastJarvis[chatId] = 0;
                    storage.flagSave();
                    await sock.sendMessage(chatId, { text: '🤖 *BOT DROPHTTP:* ' + aiResponse, mentions: [userInfo.jid] }, { quoted: msg });
                }
                return;
            } catch (e: any) { console.error('[ERRO IA EXPLÍCITA]', e.message); }
        }
        const isCooldownElapsed = (now - lastIntervention) >= (45 * 1000);
        const hasEnoughTraffic = msgCountSince >= 4;
        if (isCooldownElapsed && hasEnoughTraffic && clusterStrings.length >= 3) {
            try {
                const autoIntervention = await evaluateAutonomousIntervention(clusterStrings);
                if (autoIntervention && !autoIntervention.toLowerCase().includes('erro')) {
                    storage.data.lastJarvisIntervention[chatId] = now;
                    storage.data.messageCountSinceLastJarvis[chatId] = 0;
                    storage.flagSave();
                    await sock.sendMessage(chatId, { text: '🤖 *BOT DROPHTTP:* ' + autoIntervention });
                    return;
                }
            } catch (errAuto: any) { console.error('[ERRO INTERVENÇÃO AUTÔNOMA]', errAuto.message); }
        }
    }
    const isNavigatingMenu = state && [
        'cadastro_waiting_id', 'cadastro_waiting_role', 'remover_waiting_id',
        'bv_waiting_text', 'divulga_waiting_time', 'divulga_waiting_content', 'inativos_confirm_removal', 'inativos_select_keep',
        'ma_menu_main', 'ma_opt1_confirm', 'ma_opt2_text', 'ma_opt2_type', 'ma_opt3_hours', 'ma_opt4_reps',
        'news_menu', 'news_city', 'news_topics_menu', 'horoscope_menu', 'horoscope_sign', 'weather_menu', 'weather_city', 'football_menu', 'football_query',
        'msgremoveadm_waiting_text'
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
            await sock.sendMessage(chatId, { text: (enable ? '🟢' : '🔴') + ' *CONTROLE BOT DROPHTTP*\n\n⚙️ ' + featName + '\n📊 ' + statusWord, mentions: [userInfo.jid] });
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
    if (['!voz', '!falar', '!transcrever', '!ouvir', '!audio'].includes(firstWord)) {
        await sock.sendMessage(chatId, { text: '⚠️ Este comando está temporariamente desativado para manutenção.' }, { quoted: msg });
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
            await sock.sendMessage(chatId, { poll: { name: '📊 ' + partsEnquete[0], values: partsEnquete.slice(1, 12), selectableCount: 1 } } as any);
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
            if (storage.data.promoSchedule && storage.data.promoSchedule[chatId]) { delete storage.data.promoSchedule[chatId]; storage.flagSave(); await sock.sendMessage(chatId, { text: '🛑 Divulgação cancelada.' }); return; }
            await sock.sendMessage(chatId, { text: 'ℹ️ Nenhuma divulgação ativa.' }); return;
        }
        storage.data.states[userId] = { mode: 'divulga_waiting_time', targetGroup: chatId };
        storage.flagSave();
        await sock.sendMessage(chatId, { text: '⏰ *Qual horário da divulgação?*\n\n_Ex: "das 20:00 às 21:00"_' });
        return;
    }
    if (['!ia', '!botia'].includes(firstWord)) {
        const q = text.slice(firstWord.length).trim();
        if (!q) { await sock.sendMessage(chatId, { text: '🤖 *BOT DROPHTTP:* Envie sua pergunta após o comando.' }, { quoted: msg }); return; }
        const cluster = storage.data.memoryCluster?.[chatId] || [];
        const clusterStrings = cluster.map(m => m.authorName + ': ' + m.text);
        try {
            const aiRes = await callAI(q, clusterStrings);
            if (aiRes && !aiRes.toLowerCase().includes('erro')) {
                await sock.sendMessage(chatId, { text: '🤖 *BOT DROPHTTP:*\n\n' + aiRes, mentions: [userInfo.jid] });
            }
        } catch (e: any) { console.error('[ERRO IA COMANDO]', e.message); }
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
                    const resolved = extractRawNumber(p.id);
                    const effectiveNum = (p.id || '').endsWith('@s.whatsapp.net')
                        ? resolved
                        : (resolved && resolved.length <= 13 ? resolved : '');
                    if (!effectiveNum) continue;
                    const isBr = detectBrazilianNumber(effectiveNum);
                    if (!isBr) foreignList.push(p);
                }
                if (foreignList.length === 0) { await sock.sendMessage(chatId, { text: '✅ Nenhum número estrangeiro encontrado.' }); return; }
                let removedCount = 0;
                const removedNames: string[] = [];
                for (const target of foreignList) {
                    try {
                        await sock.groupParticipantsUpdate(chatId, [target.id], 'remove');
                        removedCount++;
                        const info = getUserInfo(target.id, target.name || (target as any).notify || '');
                        removedNames.push('• ' + info.smartMention);
                        await new Promise(r => setTimeout(r, 600));
                    } catch (errRemove: any) { console.error('[ERRO REMOVER FAKE]', errRemove.message); }
                }
                await sock.sendMessage(chatId, { text: '🛡️ *VARREDURA ANTI-FAKE*\n\n📊 Removidos: ' + removedCount + '\n\n' + (removedNames.slice(0, 20).join('\n') || '_Nenhum removido._'), mentions: foreignList.flatMap(target => { const info = getUserInfo(target.id); return [info.mentionJid, info.jid]; }).filter(Boolean) });
            } catch (errSweep: any) { await sock.sendMessage(chatId, { text: '❌ Erro na varredura.' }); }
            return;
        }
    }
    if (['!antiflood'].includes(firstWord)) {
        const action = parts[1]?.toLowerCase();
        if (action === 'on' || action === 'off') {
            if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
            const userRole = parseInt(getUserRole(userId, storage.data.users));
            if (userRole < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas admins.' }, { quoted: msg }); return; }
            const enable = action === 'on';
            storage.setFeatureStatus(chatId, 'antiflood', enable);
            await sock.sendMessage(chatId, { text: (enable ? '🟢' : '🔴') + ' *Anti-Flood:* ' + (enable ? 'ATIVADO' : 'DESATIVADO') }, { quoted: msg });
            return;
        }
    }
    if (['!fixar', '!desfixar', '!pin', '!unpin'].includes(firstWord)) {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        if (!contextInfo?.stanzaId) { await sock.sendMessage(chatId, { text: '📌 Responda a uma mensagem com `!fixar` ou `!desfixar`.' }, { quoted: msg }); return; }
        const targetKey = { remoteJid: chatId, id: contextInfo.stanzaId, participant: contextInfo.participant };
        const isUnpin = firstWord === '!desfixar' || firstWord === '!unpin';
        try {
            await sock.sendMessage(chatId, { pin: targetKey as any, type: isUnpin ? 2 : 1, time: isUnpin ? undefined : 604800 } as any);
            await sock.sendMessage(chatId, { text: isUnpin ? '📌 Mensagem desfixada.' : '📌 Mensagem fixada no topo.' }, { quoted: msg });
        } catch (e: any) { await sock.sendMessage(chatId, { text: '❌ Erro ao fixar/desfixar.' }, { quoted: msg }); }
        return;
    }
    if (['!remove', '!apagar', '!deletar', '!del'].includes(firstWord)) {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        if (!contextInfo?.stanzaId) { await sock.sendMessage(chatId, { text: '🗑️ Responda a mensagem que deseja apagar com `!remove`.' }, { quoted: msg }); return; }
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
            setTimeout(async () => { try { await sock.groupSettingUpdate(chatId, 'not_announcement'); } catch (e) { } }, 3000);
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
        if (arg === '-') {
            if (!storage.data.groupSchedules) storage.data.groupSchedules = {};
            if (!storage.data.groupSchedules[chatId]) storage.data.groupSchedules[chatId] = { openTime: '', closeTime: '' };
            if (firstWord === '!abrir') storage.data.groupSchedules[chatId].openTime = '';
            else storage.data.groupSchedules[chatId].closeTime = '';
            storage.flagSave();
            await sock.sendMessage(chatId, { text: '🛑 Horário de ' + (firstWord === '!abrir' ? 'abertura' : 'fechamento') + ' resetado para NULO. Modo manual ativo (!abrir / !fechar ou configurações do grupo).' }, { quoted: msg });
            return;
        }
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
        let panelMsg = '📊 *PAINEL BOT DROPHTTP*\n\n';
        const uniqueKeys = Array.from(new Set(Object.values(FEATURE_MAP)));
        uniqueKeys.forEach(k => {
            const disabled = storage.isFeatureDisabled(chatId, k);
            panelMsg += (disabled ? '🔴' : '🟢') + ' ' + (FEATURE_NAMES[k] || k) + '\n';
        });
        await sock.sendMessage(chatId, { text: panelMsg, mentions: [userInfo.jid] });
        return;
    }
    if (textLower === '!id') {
        const target = resolveTargetJid(msg, text) || sender;
        const info = getUserInfo(target, target === sender ? pushNameRaw : "");
        const role = getUserRole(info.number || userId, storage.data.users);
        const roleNames: Record<string, string> = {
          "5": "Super Admin 👑",
          "4": "Gestor 🛡️",
          "3": "Parceiro 🤝",
          "2": "Admin ⭐",
          "1": "Especial 🎵",
          "0": "Comum 👤",
        };
        await sock.sendMessage(
          chatId,
          {
            text:
              "👤 *ID*\n\n" +
              "👤 *Nome:* " +
              (info.pushName || "Membro") +
              "\n" +
              "📱 *Número:* " +
              (info.formattedNum || "não disponível") +
              "\n" +
              "🆔 *ID:* " +
              (info.number || target) +
              "\n" +
              "👑 Nível " +
              role +
              " (" +
              (roleNames[role] || "?") +
              ")",
            mentions: [info.jid],
          },
          { quoted: msg },
        );
        return;
    }
    if (textLower.startsWith('!cadastro')) {
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
                await sock.sendMessage(chatId, { text: '✅ ' + targetInfo.smartMention + ' agora é Nível ' + targetRole, mentions: [targetInfo.mentionJid, targetInfo.jid] });
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
        const targetId = state.targetId;
        storage.data.users[targetId] = targetRole;
        delete storage.data.states[userId];
        storage.flagSave();
        const targetInfo = getUserInfo(targetId + '@s.whatsapp.net');
        await sock.sendMessage(chatId, { text: '✅ ' + targetInfo.smartMention + ' cadastrado como Nível ' + targetRole, mentions: [targetInfo.mentionJid, targetInfo.jid] });
        return;
    }
    
    if (textLower === '!remover') {
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
        
        if (foundKey) {
            delete storage.data.users[foundKey];
            delete storage.data.states[userId];
            storage.flagSave();
            storage.saveSync();
            await sock.sendMessage(chatId, { text: '✅ ' + targetInfo.smartMention + ' removido com sucesso do banco de dados de admins.', mentions: [targetInfo.mentionJid, targetInfo.jid] });
        } else {
            delete storage.data.states[userId];
            storage.flagSave();
            await sock.sendMessage(chatId, { text: '⚠️ Número ' + targetId + ' não encontrado no banco de dados de admins.' });
        }
        return;
    }
    
    if (['!warn', '!advertir', '!warns', '!advertencias', '!unwarn'].includes(firstWord)) {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        if (!storage.data.warnings[chatId]) storage.data.warnings[chatId] = {};
        const targetJid = resolveTargetJid(msg, text);
        const targetNum = targetJid ? extractRawNumber(targetJid) : userInfo.number;
        const targetInfo = getUserInfo(targetJid || sender);
        if (firstWord === '!warns' || firstWord === '!advertencias') {
            const warns = storage.data.warnings[chatId][targetNum] || 0;
            const limit = storage.data.maxWarnings[chatId] || 3;
            await sock.sendMessage(chatId, { text: '⚠️ ' + targetInfo.smartMention + ' — ' + warns + '/' + limit, mentions: [targetInfo.mentionJid, targetInfo.jid] });
            return;
        }
        if (firstWord === '!unwarn') {
            if (!targetJid) { await sock.sendMessage(chatId, { text: '❌ Marque o membro.' }, { quoted: msg }); return; }
            if (storage.data.warnings[chatId][targetNum] && storage.data.warnings[chatId][targetNum] > 0) {
                storage.data.warnings[chatId][targetNum]--;
                storage.flagSave();
                await sock.sendMessage(chatId, { text: '✅ Advertência removida de ' + targetInfo.smartMention, mentions: [targetInfo.mentionJid, targetInfo.jid] });
                return;
            }
            await sock.sendMessage(chatId, { text: 'ℹ️ Sem advertências.' });
            return;
        }
        if (firstWord === '!warn' || firstWord === '!advertir') {
            if (!targetJid) { await sock.sendMessage(chatId, { text: '❌ Marque o membro.' }, { quoted: msg }); return; }
            const reason = text.replace(firstWord, '').replace(/@\d+/, '').trim() || 'Violação das regras';
            await storage.applyWarning(sock, chatId, targetJid, reason);
            return;
        }
    }
    if (firstWord === '!ban' || firstWord === '!kick') {
        if (!isGroup) return;
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        const targetJid = resolveTargetJid(msg, text);
        if (!targetJid) { await sock.sendMessage(chatId, { text: '❌ Marque o membro.' }, { quoted: msg }); return; }
        try {
            const groupMeta = await sock.groupMetadata(chatId);
            const targetParticipant = groupMeta.participants.find(p => p.id === targetJid || checkMatch(p.id.split('@')[0], targetJid.split('@')[0]));
            if (!targetParticipant) { await sock.sendMessage(chatId, { text: '⚠️ Membro não encontrado.' }); return; }
            if (targetParticipant.admin === 'admin' || targetParticipant.admin === 'superadmin') { await sock.sendMessage(chatId, { text: '⚠️ Não posso remover outro admin.' }); return; }
            const targetInfo = getUserInfo(targetParticipant.id, (targetParticipant as any).name || (targetParticipant as any).notify || '');
            await sock.groupParticipantsUpdate(chatId, [targetParticipant.id], 'remove');
            const customRemoval = storage.data.removalMsgs?.[chatId]?.text;
            if (customRemoval) {
                const finalText = customRemoval
                    .replace(/\{membro\}/gi, targetInfo.smartMention)
                    .replace(/\{nome\}/gi, targetInfo.pushName || targetInfo.formattedNum)
                    .replace(/\{numero\}/gi, targetInfo.formattedNum);
                await sock.sendMessage(chatId, { text: finalText, mentions: [targetInfo.mentionJid, targetInfo.jid] });
            } else {
                await sock.sendMessage(chatId, { text: '🚫 ' + targetInfo.smartMention + ' foi removido.', mentions: [targetInfo.mentionJid, targetInfo.jid] });
            }
        } catch (e: any) { await sock.sendMessage(chatId, { text: '❌ Não foi possível remover.' }); }
        return;
    }
    if (['!rank', '!top'].includes(firstWord)) {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const stats = storage.data.groupStats[chatId];
        if (!stats || Object.keys(stats).length === 0) { await sock.sendMessage(chatId, { text: 'ℹ️ Sem dados ainda.' }, { quoted: msg }); return; }
        const sorted = Object.keys(stats).sort((a, b) => stats[b].total - stats[a].total).slice(0, 10);
        const medals = ['🥇', '', '🥉', '4º', '5º', '6º', '7º', '8º', '9º', '10º'];
        let rankMsg = '🏆 *RANKING*\n\n';
        sorted.forEach((num, i) => {
            const uInfo = getUserInfo(num + '@s.whatsapp.net', storage.data.cache?.names?.[num] || '');
            rankMsg += medals[i] + ' ' + uInfo.smartMention + ' — ' + stats[num].total + ' msgs\n';
        });
        await sock.sendMessage(chatId, { text: rankMsg, mentions: sorted.flatMap(num => { const info = getUserInfo(num + '@s.whatsapp.net', storage.data.cache?.names?.[num] || ''); return [info.mentionJid, info.jid]; }).filter(Boolean) });
        return;
    }
    if (textLower === '!m') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const stats = storage.data.groupStats[chatId];
        if (!stats || Object.keys(stats).length === 0) { await sock.sendMessage(chatId, { text: 'ℹ️ Sem dados.' }, { quoted: msg }); return; }
        const sorted = Object.keys(stats).sort((a, b) => stats[b].total - stats[a].total).slice(0, 30);
        let report = '📊 *MÉTRICAS DO GRUPO*\n\n';
        const mentionsArr: string[] = [];
        sorted.forEach((authorNum, index) => {
            const s = stats[authorNum];
            const cachedName = storage.data.cache?.names?.[authorNum] || '';
            const uInfo = getUserInfo(authorNum + '@s.whatsapp.net', cachedName);
            report += (index + 1) + 'º ' + uInfo.smartMention + ' — ' + s.total + ' msg(s)\n';
            if (uInfo.mentionJid) mentionsArr.push(uInfo.mentionJid);
            if (uInfo.jid) mentionsArr.push(uInfo.jid);
        });
        await sock.sendMessage(chatId, { text: report, mentions: mentionsArr });
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
    if (firstWord === '!msgremoveadm') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        let customText = '';
        if (text.includes('+')) customText = text.slice(text.indexOf('+') + 1).trim();
        else customText = text.slice(firstWord.length).trim();
        if (customText.toLowerCase() === 'off') {
            if (storage.data.removalMsgs && storage.data.removalMsgs[chatId]) {
                delete storage.data.removalMsgs[chatId];
                storage.flagSave();
                await sock.sendMessage(chatId, { text: '🛑 Mensagem de remoção desativada. Usando padrão.' }, { quoted: msg });
                return;
            }
            await sock.sendMessage(chatId, { text: 'ℹ️ Nenhuma mensagem personalizada ativa.' }, { quoted: msg });
            return;
        }
        if (!customText) {
            const current = storage.data.removalMsgs?.[chatId]?.text;
            const defaultMsg = 'Xiii, acho que o integrante {membro} fez algo de errado, pois foi removido!';
            await sock.sendMessage(chatId, {
                text: '🚫 *MENSAGEM DE REMOÇÃO POR ADMIN*\n\n' +
                    'Atual: ' + (current || '_' + defaultMsg + '_') + '\n\n' +
                    '*Use:* `!msgremoveadm + sua mensagem`\n' +
                    '*Variável:* `{membro}` → Nome - Número\n' +
                    '*Desativar:* `!msgremoveadm off`'
            }, { quoted: msg });
            return;
        }
        if (!storage.data.removalMsgs) storage.data.removalMsgs = {};
        storage.data.removalMsgs[chatId] = { text: customText, setBy: userId, date: new Date().toISOString() };
        storage.flagSave();
        await sock.sendMessage(chatId, { text: '✅ *Mensagem de remoção por admin definida:*\n\n' + customText }, { quoted: msg });
        return;
    }
    if (firstWord === '!antifakestric') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        if (userRole < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        const arg = text.slice(firstWord.length).trim().toLowerCase();
        const enable = arg !== 'off';
        if (!storage.data.antifakeStrictLid) storage.data.antifakeStrictLid = {};
        storage.data.antifakeStrictLid[chatId] = enable;
        storage.flagSave();
        await sock.sendMessage(chatId, { text: ' *Verificação estrita de LID:* ' + (enable ? 'ATIVADA (remove quem entra com número oculto).' : 'DESATIVADA (permite entrada com número oculto).') }, { quoted: msg });
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
                    const pName = (p as any).name || (p as any).notify || (p as any).verifiedName ||
                        contactCache[pNum]?.name || contactCache[pIdClean]?.name || contactCache[pLidClean]?.name ||
                        storage.data.cache?.names?.[pNum] || storage.data.cache?.names?.[pIdClean] || '';
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
            const inactiveMentions = inactiveList.flatMap(u => [u.mentionJid, u.jid]).filter(Boolean);
            inactiveList.forEach((u, idx) => { listReport += (idx + 1) + ' - ' + u.smartMention + '\n'; });
            listReport += '\n⚠️ *Remover todos?*\n\nResponda: *SIM* (1) ou *NÃO* (2)';
            await sock.sendMessage(chatId, { text: listReport, mentions: inactiveMentions }, { quoted: msg });
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
        const receiverJid = resolveTargetJid(msg, text);
        if (!receiverJid) { await sock.sendMessage(chatId, { text: '🎭 *CORREIO ANÔNIMO*\n\n`!anonimo @pessoa mensagem`\n\n🌐 Ou pela página: `!linkcorreio`' }, { quoted: msg }); return; }
        if (receiverJid === sender) { await sock.sendMessage(chatId, { text: '❌ Não pode enviar para si mesmo.' }, { quoted: msg }); return; }
        const anonText = text.replace(firstWord, '').replace(/@\d+/, '').trim();
        if (!anonText) { await sock.sendMessage(chatId, { text: '❌ Escreva a mensagem.' }, { quoted: msg }); return; }
        const receiverInfo = getUserInfo(receiverJid);
        const anonId = storage.generateAnonId();
        if (!storage.data.anonMsgs) storage.data.anonMsgs = [];
        storage.data.anonMsgs.push({ id: anonId, chatId: chatId, senderJid: sender, senderNum: userInfo.number, senderName: userInfo.nameAndNumber, receiverJid: receiverJid, receiverNum: receiverInfo.number, receiverName: receiverInfo.nameAndNumber, text: anonText, timestamp: Date.now(), type: 'anonimo' });
        storage.flagSave();
        try {
            await sock.sendMessage(receiverJid, { text: '🎭 ━ *CORREIO ANÔNIMO* ━ \n\n💬 *"' + anonText + '"*\n\n🕵️ *Remetente:* _Alguém secreto_\n🔖 *ID:* #' + anonId + '\n\n━━━━━━━━━━\n↩️ Responder: `!responder ' + anonId + ' sua resposta`' });
            await sock.sendMessage(chatId, { text: '💌 *Correio enviado!*\n📮 Para: ' + receiverInfo.smartMention + '\n🔖 #' + anonId, mentions: [receiverInfo.mentionJid, receiverInfo.jid] }, { quoted: msg });
        } catch (e) { await sock.sendMessage(chatId, { text: '❌ Não foi possível entregar.' }, { quoted: msg }); return; }
        const adminGroup = storage.data.cache?.adminGroupId;
        if (adminGroup) {
            try {
                const timeStr = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                const footer = '📱 ' + userInfo.formattedNum + '   •   🕒 ' + timeStr;
                const card = await generateNglCard(anonText, footer);
                await sock.sendMessage(adminGroup, { image: card, caption: '🎭 *NOVO CORREIO ANÔNIMO*\n\n💬 "' + anonText + '"\n🕒 *Horário:* ' + timeStr + '\n👤 *Remetente:* ' + userInfo.smartMention, mentions: [userInfo.mentionJid, userInfo.jid] });
            } catch (e) { console.error('[ERRO CARD NGL]', (e as any).message); }
        }
        return;
    }
    if (firstWord === '!responder') {
        const partsResp = text.trim().split(/\s+/);
        const targetId = (partsResp[1] || '').replace('#', '').toUpperCase();
        const replyText = text.replace(firstWord, '').replace(new RegExp('#?' + targetId, 'i'), '').trim();
        if (!targetId || !replyText) { await sock.sendMessage(chatId, { text: '🎭 *Uso:*\n`!responder ID mensagem`' }, { quoted: msg }); return; }
        const originalMsg = (storage.data.anonMsgs || []).find(m => m.id === targetId);
        if (!originalMsg) { await sock.sendMessage(chatId, { text: '❌ ID #' + targetId + ' não encontrado.' }, { quoted: msg }); return; }
        if (originalMsg.receiverJid !== sender && !isSuperAdmin(userId, storage.data.users)) { await sock.sendMessage(chatId, { text: '❌ Só o destinatário original responde.' }, { quoted: msg }); return; }
        const replyId = storage.generateAnonId();
        storage.data.anonMsgs.push({ id: replyId, chatId: chatId, senderJid: sender, senderNum: userInfo.number, senderName: userInfo.nameAndNumber, receiverJid: originalMsg.senderJid, receiverNum: originalMsg.senderNum, receiverName: originalMsg.senderName, text: replyText, timestamp: Date.now(), type: 'resposta', replyToId: targetId });
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
                '👤 De: ' + m.senderName + '\n🎯 Para: ' + m.receiverName + '\n💬 "' + m.text.substring(0, 80) + '"\n\n';
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
    if (firstWord === '!horariobot') {
        if (isGroup) {
            const userRole = parseInt(getUserRole(userId, storage.data.users));
            if (userRole < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        }
        const nowHHMM = getHHMM();
        let report = '🕒 *DEBUG DE HORÁRIO & AGENDA*\n\n';
        report += '🇧🇷 *Hora de Brasília (bot):* ' + nowHHMM + '\n';
        report += '🖥️ *Hora do PC:* ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + '\n';
        report += '🌎 *TZ do processo:* ' + (process.env.TZ || '_não definido_') + '\n';
        if (isGroup) {
            const sched = storage.data.groupSchedules?.[chatId];
            if (sched && (sched.openTime || sched.closeTime)) {
                const shouldOpen = isWithinWindow(sched.openTime, sched.closeTime, nowHHMM);
                const internalOpen = !storage.isGroupClosed(chatId);
                report += '\n📅 *Agenda deste grupo:*\n';
                report += '• Abertura: ' + (sched.openTime || '_não definida_') + '\n';
                report += '• Fechamento: ' + (sched.closeTime || '_não definido_') + '\n';
                report += '✅ *Deveria estar:* ' + (shouldOpen ? '🔓 ABERTO' : '🔒 FECHADO') + '\n';
                report += '🤖 *Estado interno:* ' + (internalOpen ? '🔓 aberto' : '🔒 fechado') + '\n';
                try {
                    const meta = await sock.groupMetadata(chatId);
                    report += '📡 *Estado real no WhatsApp:* ' + (meta.announce ? '🔒 fechado' : '🔓 aberto') + '\n';
                    if ((meta.announce === true) === shouldOpen) report += '⚠️ *DIVERGÊNCIA:* o WhatsApp está diferente do que a agenda diz.\n';
                } catch (e) { }
                if (shouldOpen !== internalOpen) report += '⚠️ *DIVERGÊNCIA INTERNA:* agenda e estado interno não batem.\n';
            } else {
                report += '\n📅 *Agenda deste grupo:* nenhuma configurada.\n';
            }
        }
        report += '\n⚙️ Agendar: `!abrir HH:MM` / `!fechar HH:MM`';
        await sock.sendMessage(chatId, { text: report }, { quoted: msg });
        return;
    }
    if (['!s', '!sticker', '!figurinha'].includes(firstWord)) {
        try {
            const targetMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage ? {
                key: { remoteJid: chatId, id: msg.message.extendedTextMessage.contextInfo.stanzaId, participant: msg.message.extendedTextMessage.contextInfo.participant },
                message: msg.message.extendedTextMessage.contextInfo.quotedMessage
            } : msg;
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
            const targetMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage ? {
                key: { remoteJid: chatId, id: msg.message.extendedTextMessage.contextInfo.stanzaId, participant: msg.message.extendedTextMessage.contextInfo.participant },
                message: msg.message.extendedTextMessage.contextInfo.quotedMessage
            } : msg;
            const isSticker = targetMsg.message?.stickerMessage;
            if (!isSticker) { await sock.sendMessage(chatId, { text: '❌ Responda figurinha com !s2img' }, { quoted: msg }); return; }
            const stickerMediaBuffer = await downloadMediaMessage(targetMsg as any, 'buffer', {});
            if (!stickerMediaBuffer) { await sock.sendMessage(chatId, { text: '❌ Não foi possível.' }, { quoted: msg }); return; }
            const imageBuffer = await stickerToImageBuffer(stickerMediaBuffer);
            await sock.sendMessage(chatId, { image: imageBuffer, caption: '🖼️ Extraída!' }, { quoted: msg });
        } catch (err: any) { await sock.sendMessage(chatId, { text: '❌ Erro.' }, { quoted: msg }); }
        return;
    }
    if (textLower === '!n') {
        storage.data.states[userId] = { mode: 'news_menu' };
        storage.flagSave();
        await sock.sendMessage(chatId, { text: '📰 *NOTÍCIAS*\n\n1 - Globais\n2 - Regionais\n3 - Por Tópicos', mentions: [userInfo.jid] });
        return;
    }
    if (state && state.mode === 'news_menu') {
        if (text === '1') {
            delete storage.data.states[userId]; storage.flagSave();
            const newsData = await fetchNews('Mundo OR Internacional', 6);
            await sock.sendMessage(chatId, { text: '🌍 *Globais*\n\n' + newsData });
            return;
        } else if (text === '2') {
            state.mode = 'news_city'; storage.flagSave();
            await sock.sendMessage(chatId, { text: '🏙️ Qual cidade/estado?' });
            return;
        } else if (text === '3') {
            state.mode = 'news_topics_menu'; storage.flagSave();
            let topicsMenu = '📋 *TÓPICOS*\n\n';
            for (const [key, value] of Object.entries(NEWS_TOPICS)) topicsMenu += key + ' - ' + value.name + '\n';
            await sock.sendMessage(chatId, { text: topicsMenu });
            return;
        }
    }
    if (state && state.mode === 'news_city') {
        const region = text;
        delete storage.data.states[userId]; storage.flagSave();
        const newsData = await fetchNews(region, 5);
        await sock.sendMessage(chatId, { text: '📍 *' + region.toUpperCase() + '*\n\n' + newsData });
        return;
    }
    if (state && state.mode === 'news_topics_menu') {
        const topicObj = NEWS_TOPICS[text];
        if (!topicObj) return;
        delete storage.data.states[userId]; storage.flagSave();
        const newsData = await fetchNews(topicObj.query, 5);
        await sock.sendMessage(chatId, { text: '📌 *' + topicObj.name.toUpperCase() + '*\n\n' + newsData });
        return;
    }
    if (textLower === '!h') {
        storage.data.states[userId] = { mode: 'horoscope_menu' };
        storage.flagSave();
        await sock.sendMessage(chatId, { text: '✨ *HORÓSCOPO*\n\n1 - Todos os signos\n2 - Seu signo', mentions: [userInfo.jid] });
        return;
    }
    if (state && state.mode === 'horoscope_menu') {
        const currentDate = new Date().toLocaleDateString('pt-BR');
        if (text === '1') {
            delete storage.data.states[userId]; storage.flagSave();
            let report = '✨ *HORÓSCOPO ' + currentDate + '*\n\n';
            const promises = SIGNS.map(async (s) => {
                const data = await fetchHoroscope(s.name, false);
                return s.emoji + ' *' + s.name + '*\n_' + data + '_\n\n';
            });
            const results = await Promise.all(promises);
            report += results.join('');
            await sock.sendMessage(chatId, { text: report });
            return;
        } else if (text === '2') {
            state.mode = 'horoscope_sign'; storage.flagSave();
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
        delete storage.data.states[userId]; storage.flagSave();
        const webData = await fetchHoroscope(selectedSign.name, true);
        await sock.sendMessage(chatId, { text: '✨ *' + selectedSign.name + '*\n\n' + webData + '\n\n📅 ' + currentDate });
        return;
    }
    if (textLower === '!t') {
        storage.data.states[userId] = { mode: 'weather_menu' };
        storage.flagSave();
        await sock.sendMessage(chatId, { text: '🌤️ *CLIMA*\n\n1 - Hoje\n2 - Próximos dias', mentions: [userInfo.jid] });
        return;
    }
    if (state && state.mode === 'weather_menu') {
        if (text === '1' || text === '2') {
            state.mode = 'weather_city';
            state.weatherType = text === '1' ? 'hoje' : 'semana';
            storage.flagSave();
            await sock.sendMessage(chatId, { text: '🏙️ Qual cidade?' });
            return;
        }
    }
    if (state && state.mode === 'weather_city') {
        const city = text;
        const weatherType = state.weatherType;
        delete storage.data.states[userId]; storage.flagSave();
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
        const queryType = text === '1' ? 'standings' : text === '2' ? 'fixtures' : text === '3' ? 'topscorers' : null;
        if (!queryType) return;
        const leagueId = state.leagueId;
        delete storage.data.states[userId]; storage.flagSave();
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
            const promptMeta = 'Resumo do grupo:\n\n📌 *RELATÓRIO BOT DROPHTTP*\n📅 ' + dateStrLog + '\n\n🗣️ Tópicos:\n👥 Membros:\n🌟 Clima:';
            const summaryText = await callAI(promptMeta, clusterStrings);
            if (summaryText && !summaryText.toLowerCase().includes('erro')) {
                await sock.sendMessage(chatId, { text: summaryText });
            }
        } catch (e) { await sock.sendMessage(chatId, { text: '❌ Erro no resumo.' }); }
        return;
    }
    if (['!wiki', '!wikipedia'].includes(firstWord)) {
        const q = text.replace(firstWord, '').trim();
        if (!q) { await sock.sendMessage(chatId, { text: '⚠️ Use: `!wiki termo`' }, { quoted: msg }); return; }
        await sock.sendMessage(chatId, { text: await fetchWikipedia(q) }, { quoted: msg });
        return;
    }
    if (firstWord === '!regras') {
        if (!isGroup) return;
        if (textLower.startsWith('!regras definir ')) {
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
            if (storage.data.welcomeMsgs && storage.data.welcomeMsgs[chatId]) {
                delete storage.data.welcomeMsgs[chatId]; storage.flagSave();
                await sock.sendMessage(chatId, { text: '🛑 Saudação desativada.' }, { quoted: msg });
                return;
            }
            await sock.sendMessage(chatId, { text: 'ℹ️ Sem saudação ativa.' }, { quoted: msg });
            return;
        }
        if (!customText) {
            const current = storage.data.welcomeMsgs?.[chatId]?.text;
            await sock.sendMessage(chatId, { text: '👋 *SAUDAÇÃO*\n\nAtual: ' + (current || '_padrão_') + '\n\n*Use:* `!sa mensagem` ou `!sa off`\n\nVariáveis: `{membro}`, `{nome}`, `{numero}`' }, { quoted: msg });
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
            if (storage.data.welcomeReminders && storage.data.welcomeReminders[chatId]) {
                delete storage.data.welcomeReminders[chatId]; storage.flagSave();
                await sock.sendMessage(chatId, { text: '🛑 Lembrete desativado.' }, { quoted: msg });
                return;
            }
            await sock.sendMessage(chatId, { text: 'ℹ️ Sem lembrete.' }, { quoted: msg });
            return;
        }
        if (!customText) {
            const current = storage.data.welcomeReminders?.[chatId]?.text;
            await sock.sendMessage(chatId, { text: '🔔 *LEMBRETE 5 MIN*\n\nAtual: ' + (current || '_nenhum_') + '\n\n*Use:* `!bv mensagem` ou `!bv off`\n\nVariáveis: `{membro}`, `{nome}`, `{numero}`' }, { quoted: msg });
            return;
        }
        if (!storage.data.welcomeReminders) storage.data.welcomeReminders = {};
        storage.data.welcomeReminders[chatId] = { text: customText, setBy: userId, date: new Date().toISOString() };
        storage.flagSave();
        await sock.sendMessage(chatId, { text: '✅ *LEMBRETE CONFIGURADO (5min após entrada)*\n\n' + customText }, { quoted: msg });
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
            if (storage.data.exitMsgs && storage.data.exitMsgs[chatId]) {
                delete storage.data.exitMsgs[chatId]; storage.flagSave();
                await sock.sendMessage(chatId, { text: '🛑 Despedida desativada.' }, { quoted: msg });
                return;
            }
            await sock.sendMessage(chatId, { text: 'ℹ️ Sem despedida.' }, { quoted: msg });
            return;
        }
        if (!customText) {
            const current = storage.data.exitMsgs?.[chatId]?.text;
            await sock.sendMessage(chatId, { text: '👋 *DESPEDIDA*\n\nAtual: ' + (current || '_nenhuma_') + '\n\n*Use:* `!exit mensagem` ou `!exit off`\n\nVariáveis: `{membro}`, `{nome}`, `{numero}`' }, { quoted: msg });
            return;
        }
        if (!storage.data.exitMsgs) storage.data.exitMsgs = {};
        storage.data.exitMsgs[chatId] = { text: customText, setBy: userId, date: new Date().toISOString() };
        storage.flagSave();
        await sock.sendMessage(chatId, { text: '✅ *DESPEDIDA CONFIGURADA*\n\n' + customText }, { quoted: msg });
        return;
    }
    if (state && state.mode === 'music_selection') {
        const num = parseInt(text.trim(), 10);
        if (!isNaN(num) && num >= 1 && num <= (state.options?.length || 0)) {
            const chosen = state.options[num - 1];
            const mediaType = state.mediaType || 'audio';
            delete storage.data.states[userId];
            storage.flagSave();
            await sock.sendMessage(chatId, { text: '⏳ *Baixando ' + (mediaType === 'audio' ? 'áudio' : 'vídeo') + ':* _' + chosen.title + '_\n\nAguarde alguns segundos...' }, { quoted: msg });
            try {
                if (mediaType === 'audio') {
                    const buf = await getAudioBuffer(chosen.url);
                    await sock.sendMessage(chatId, { audio: buf, mimetype: 'audio/mpeg', ptt: false });
                } else {
                    const buf = await getVideoBuffer(chosen.url);
                    await sock.sendMessage(chatId, { video: buf, mimetype: 'video/mp4', caption: '🎬 ' + chosen.title });
                }
            } catch (e: any) {
                console.error('[YT DOWNLOAD ERR]', e.message);
                await sock.sendMessage(chatId, { text: '❌ Erro ao baixar. Tente outro número.' }, { quoted: msg });
            }
            return;
        }
    }
    if (firstWord === '!botmusica') {
        const subArg = text.slice(firstWord.length).trim().toLowerCase();
        if (subArg === 'on' || subArg === 'off') {
            if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
            const userRole = parseInt(getUserRole(userId, storage.data.users));
            if (userRole < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
            storage.setMusicDisabled(chatId, subArg === 'off');
            await sock.sendMessage(chatId, { text: subArg === 'on' ? '🎵 *Bot de Música LIGADO*' : '🔇 *Bot de Música DESLIGADO*' }, { quoted: msg });
            return;
        }
        const off = storage.isMusicDisabled(chatId);
        await sock.sendMessage(chatId, { text: '🎛️ *Bot de Música:* ' + (off ? '🔴 DESLIGADO' : '🟢 LIGADO') + '\n\n`!botmusica on` / `!botmusica off`' }, { quoted: msg });
        return;
    }
    if (firstWord === '!mute' || firstWord === '!unmute') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        if (parseInt(getUserRole(userId, storage.data.users)) < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        const tJid = resolveTargetJid(msg, text);
        if (!tJid) { await sock.sendMessage(chatId, { text: '❌ Marque o membro.' }, { quoted: msg }); return; }
        const tNum = extractRawNumber(tJid);
        const tInfo = getUserInfo(tJid);
        if (firstWord === '!unmute') { storage.clearMute(chatId, tNum); await sock.sendMessage(chatId, { text: '🔊 ' + tInfo.smartMention + ' desmutado.', mentions: [tInfo.mentionJid, tInfo.jid] }, { quoted: msg }); return; }
        const durMatch = text.match(/(\d+)\s*(m|min|h|hr|s)?/i);
        let ms = 10 * 60 * 1000;
        if (durMatch) { const v = parseInt(durMatch[1]); const u = (durMatch[2] || 'm').toLowerCase(); ms = u.startsWith('h') ? v * 3600000 : u.startsWith('s') ? v * 1000 : v * 60000; }
        storage.setMute(chatId, tNum, ms);
        await sock.sendMessage(chatId, { text: '🔇 ' + tInfo.smartMention + ' mutado por ' + Math.round(ms / 60000) + ' min.', mentions: [tInfo.mentionJid, tInfo.jid] }, { quoted: msg });
        return;
    }
    if (firstWord === '!blacklist') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        if (parseInt(getUserRole(userId, storage.data.users)) < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        const sub = text.slice(firstWord.length).trim();
        if (!storage.data.blacklistWords) storage.data.blacklistWords = {};
        if (!storage.data.blacklistWords[chatId]) storage.data.blacklistWords[chatId] = [];
        if (sub.toLowerCase().startsWith('remover ')) {
            const w = sub.slice(8).trim().toLowerCase();
            storage.data.blacklistWords[chatId] = storage.data.blacklistWords[chatId].filter(x => x !== w);
            storage.flagSave(); await sock.sendMessage(chatId, { text: '✅ Palavra removida da blacklist.' }, { quoted: msg }); return;
        }
        if (sub.toLowerCase() === 'lista') {
            await sock.sendMessage(chatId, { text: '🚫 *Blacklist:*\n' + (storage.data.blacklistWords[chatId].join(', ') || '_vazia_') }, { quoted: msg }); return;
        }
        if (sub.startsWith('+')) {
            const w = sub.slice(1).trim().toLowerCase();
            if (w && !storage.data.blacklistWords[chatId].includes(w)) storage.data.blacklistWords[chatId].push(w);
            storage.flagSave(); await sock.sendMessage(chatId, { text: '✅ Palavra "' + w + '" adicionada à blacklist.' }, { quoted: msg }); return;
        }
        await sock.sendMessage(chatId, { text: '🚫 *Uso:*\n`!blacklist + palavra`\n`!blacklist remover palavra`\n`!blacklist lista`' }, { quoted: msg });
        return;
    }
    if (firstWord === '!antiforward' || firstWord === '!antistickerflood') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        if (parseInt(getUserRole(userId, storage.data.users)) < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        const on = !text.slice(firstWord.length).trim().toLowerCase().startsWith('off');
        const featKey = firstWord === '!antiforward' ? 'antiforward' : 'antistickerflood';
        storage.setFeatureStatus(chatId, featKey, on);
        await sock.sendMessage(chatId, { text: (on ? '🟢' : '🔴') + ' ' + firstWord + ' ' + (on ? 'ATIVADO' : 'DESATIVADO') }, { quoted: msg });
        return;
    }
    if (firstWord === '!raidmode') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        if (parseInt(getUserRole(userId, storage.data.users)) < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        const on = !text.slice(firstWord.length).trim().toLowerCase().startsWith('off');
        storage.data.raidMode[chatId] = on;
        storage.flagSave();
        storage.logAdminAction(chatId, userInfo.number, 'raidmode ' + (on ? 'ON' : 'OFF'));
        await sock.sendMessage(chatId, { text: (on ? '🟢' : '🔴') + ' *Raid-Mode:* ' + (on ? 'ATIVADO (5+ entradas/min → grupo tranca)' : 'DESATIVADO') }, { quoted: msg });
        return;
    }
    if (firstWord === '!captcha') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        if (parseInt(getUserRole(userId, storage.data.users)) < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        const on = !text.slice(firstWord.length).trim().toLowerCase().startsWith('off');
        storage.data.captcha[chatId] = on;
        storage.flagSave();
        storage.logAdminAction(chatId, userInfo.number, 'captcha ' + (on ? 'ON' : 'OFF'));
        await sock.sendMessage(chatId, { text: (on ? '🟢' : '🔴') + ' *Captcha:* ' + (on ? 'ATIVADO (novo membro digita código em 2min)' : 'DESATIVADO') }, { quoted: msg });
        return;
    }
    if (firstWord === '!autoaprovar') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        if (parseInt(getUserRole(userId, storage.data.users)) < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        const on = !text.slice(firstWord.length).trim().toLowerCase().startsWith('off');
        storage.data.autoApprove[chatId] = on;
        storage.flagSave();
        storage.logAdminAction(chatId, userInfo.number, 'autoaprovar ' + (on ? 'ON' : 'OFF'));
        await sock.sendMessage(chatId, { text: (on ? '🟢' : '🔴') + ' *Auto-Aprovar:* ' + (on ? 'ATIVADO (solicitações aceitas automaticamente)' : 'DESATIVADO') }, { quoted: msg });
        return;
    }
    if (firstWord === '!cota') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        if (parseInt(getUserRole(userId, storage.data.users)) < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        const arg = text.slice(firstWord.length).trim().toLowerCase();
        if (arg === 'off') {
            delete storage.data.dailyQuota[chatId];
            storage.flagSave();
            await sock.sendMessage(chatId, { text: '🔴 *Cota diária:* DESATIVADA' }, { quoted: msg });
            return;
        }
        const num = parseInt(arg);
        if (!num || num < 1) { await sock.sendMessage(chatId, { text: '❌ *Uso:* `!cota 50` ou `!cota off`' }, { quoted: msg }); return; }
        storage.data.dailyQuota[chatId] = num;
        storage.flagSave();
        storage.logAdminAction(chatId, userInfo.number, 'cota ' + num);
        await sock.sendMessage(chatId, { text: '🟢 *Cota diária:* ' + num + ' mensagens/dia por membro.' }, { quoted: msg });
        return;
    }
    if (firstWord === '!autoremove') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        if (parseInt(getUserRole(userId, storage.data.users)) < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        const arg = text.slice(firstWord.length).trim().toLowerCase();
        if (arg === 'off') {
            delete storage.data.autoRemoveInactive[chatId];
            storage.flagSave();
            await sock.sendMessage(chatId, { text: '🔴 *Auto-remove inativos:* DESATIVADO' }, { quoted: msg });
            return;
        }
        const dias = parseInt(arg);
        if (!dias || dias < 1) { await sock.sendMessage(chatId, { text: '❌ *Uso:* `!autoremove 7` (dias) ou `!autoremove off`' }, { quoted: msg }); return; }
        storage.data.autoRemoveInactive[chatId] = dias;
        storage.flagSave();
        storage.logAdminAction(chatId, userInfo.number, 'autoremove ' + dias + ' dias');
        await sock.sendMessage(chatId, { text: '🟢 *Auto-remove:* membros inativos há *' + dias + ' dias* serão avisados e removidos.' }, { quoted: msg });
        return;
    }
    if (firstWord === '!logadmin') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        if (parseInt(getUserRole(userId, storage.data.users)) < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        const logs = storage.data.adminLog?.[chatId] || [];
        if (!logs.length) { await sock.sendMessage(chatId, { text: '📋 Nenhum log registrado.' }, { quoted: msg }); return; }
        const last20 = logs.slice(-20);
        let logText = '📋 *LOG DE AÇÕES (últimos 20)*\n\n';
        for (const l of last20) {
            const d = new Date(l.ts);
            const hh = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            const dd = d.toLocaleDateString('pt-BR');
            logText += dd + ' ' + hh + ' — ' + l.admin + ': ' + l.action + (l.target ? ' → ' + l.target : '') + '\n';
        }
        await sock.sendMessage(chatId, { text: logText }, { quoted: msg });
        return;
    }
    if (firstWord === '!lockmedia') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        if (parseInt(getUserRole(userId, storage.data.users)) < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        const on = !text.slice(firstWord.length).trim().toLowerCase().startsWith('off');
        storage.data.lockMedia[chatId] = on;
        storage.flagSave();
        storage.logAdminAction(chatId, userInfo.number, 'lockmedia ' + (on ? 'ON' : 'OFF'));
        await sock.sendMessage(chatId, { text: (on ? '🟢' : '🔴') + ' *Lock Mídia:* ' + (on ? 'ATIVADO (apenas texto permitido)' : 'DESATIVADO') }, { quoted: msg });
        return;
    }
    if (firstWord === '!purge') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        if (parseInt(getUserRole(userId, storage.data.users)) < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        const arg = text.slice(firstWord.length).trim().toLowerCase();
        if (arg === 'off') {
            delete storage.data.purgeSchedule[chatId];
            storage.flagSave();
            await sock.sendMessage(chatId, { text: '🔴 *Purge agendado:* DESATIVADO' }, { quoted: msg });
            return;
        }
        const hrs = parseInt(arg);
        if (!hrs || hrs < 1) { await sock.sendMessage(chatId, { text: '❌ *Uso:* `!purge 24` (apaga msgs +24h diariamente às 04:00) ou `!purge off`' }, { quoted: msg }); return; }
        storage.data.purgeSchedule[chatId] = { hour: 4, olderThanHrs: hrs };
        storage.flagSave();
        storage.logAdminAction(chatId, userInfo.number, 'purge ' + hrs + 'h');
        await sock.sendMessage(chatId, { text: '🟢 *Purge agendado:* mensagens com mais de *' + hrs + 'h* serão limpas diariamente às 04:00.' }, { quoted: msg });
        return;
    }
    if (firstWord === '!level' || firstWord === '!nivel') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const tJid = resolveTargetJid(msg, text) || sender;
        const tNum = extractRawNumber(tJid);
        const tInfo = getUserInfo(tJid, tJid === sender ? pushNameRaw : '');
        const xpVal = storage.data.xp?.[chatId]?.[tNum] || 0;
        const lvl = storage.getLevel(xpVal);
        const role = storage.getRoleByLevel(lvl);
        const coinsVal = storage.data.coins?.[chatId]?.[tNum] || 0;
        await sock.sendMessage(chatId, {
            text: '📊 *NÍVEL DE ' + tInfo.pushName.toUpperCase() + '*\n\n⭐ Nível: *' + lvl + '* (' + role + ')\n✨ XP: ' + xpVal + '\n💰 Moedas: ' + coinsVal,
            mentions: [tInfo.mentionJid, tInfo.jid]
        }, { quoted: msg });
        return;
    }
    if (firstWord === '!pay') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const tJid = resolveTargetJid(msg, text);
        const amtMatch = text.match(/(\d+)/);
        if (!tJid || !amtMatch) { await sock.sendMessage(chatId, { text: '❌ *Uso:* `!pay @membro 100`' }, { quoted: msg }); return; }
        const amt = parseInt(amtMatch[1]);
        const fromNum = userInfo.number;
        const toNum = extractRawNumber(tJid);
        const fromCoins = storage.data.coins?.[chatId]?.[fromNum] || 0;
        if (fromCoins < amt) { await sock.sendMessage(chatId, { text: '❌ Saldo insuficiente. Você tem 💰' + fromCoins }, { quoted: msg }); return; }
        storage.addCoins(chatId, fromNum, -amt);
        storage.addCoins(chatId, toNum, amt);
        const toInfo = getUserInfo(tJid);
        await sock.sendMessage(chatId, {
            text: '💸 ' + userInfo.smartMention + ' enviou *💰' + amt + '* para ' + toInfo.smartMention + '!\n\n💰 Saldo atual: ' + (fromCoins - amt),
            mentions: [userInfo.mentionJid, userInfo.jid, toInfo.mentionJid, toInfo.jid]
        }, { quoted: msg });
        return;
    }
    if (firstWord === '!shop') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const myCoins = storage.data.coins?.[chatId]?.[userInfo.number] || 0;
        await sock.sendMessage(chatId, {
            text: '🛒 *LOJA DO GRUPO*\n\n💰 Seu saldo: *' + myCoins + ' moedas*\n\n📦 *Itens disponíveis:*\n• 🎨 Figurinha custom — 50 moedas (em breve)\n• ⭐ Destaque no ranking — 200 moedas (em breve)\n• 🎁 Presente surpresa — 100 moedas (em breve)\n\n_Use `!pay @membro valor` para transferir._',
        }, { quoted: msg });
        return;
    }
    if (firstWord === '!reaction') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        if (parseInt(getUserRole(userId, storage.data.users)) < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        const arg = text.slice(firstWord.length).trim();
        if (!storage.data.autoReaction) storage.data.autoReaction = {};
        if (!storage.data.autoReaction[chatId]) storage.data.autoReaction[chatId] = {};
        if (arg.toLowerCase() === 'lista') {
            const entries = Object.entries(storage.data.autoReaction[chatId]);
            await sock.sendMessage(chatId, { text: '😄 *Reações automáticas:*\n' + (entries.length ? entries.map(([k, v]) => k + ' → ' + v).join('\n') : '_nenhuma_') }, { quoted: msg });
            return;
        }
        if (arg.toLowerCase() === 'off' || arg.toLowerCase() === 'limpar') {
            storage.data.autoReaction[chatId] = {};
            storage.flagSave();
            await sock.sendMessage(chatId, { text: '🗑️ Reações automáticas limpas.' }, { quoted: msg });
            return;
        }
        const parts = arg.split(/\s+/);
        if (parts.length < 2) { await sock.sendMessage(chatId, { text: '❌ *Uso:* `!reaction palavra emoji`\nEx: `!reaction bomdia ☀️`\n`!reaction lista`\n`!reaction limpar`' }, { quoted: msg }); return; }
        const emoji = parts.pop()!;
        const keyword = parts.join(' ').toLowerCase();
        storage.data.autoReaction[chatId][keyword] = emoji;
        storage.flagSave();
        await sock.sendMessage(chatId, { text: '✅ Reação cadastrada: "' + keyword + '" → ' + emoji }, { quoted: msg });
        return;
    }
    if (isGroup && !key.fromMe && text && storage.data.autoReaction?.[chatId]) {
        const low = text.toLowerCase();
        for (const kw in storage.data.autoReaction[chatId]) {
            if (low.includes(kw)) {
                try {
                    await sock.sendMessage(chatId, { react: { text: storage.data.autoReaction[chatId][kw], key } });
                } catch (e) { }
                break;
            }
        }
    }
    if (firstWord === '!aniversario' || firstWord === '!aniversário') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const arg = text.slice(firstWord.length).trim();
        const match = arg.match(/(\d{1,2})\/(\d{1,2})/);
        if (!match) { await sock.sendMessage(chatId, { text: '❌ *Uso:* `!aniversario DD/MM`\nEx: `!aniversario 25/12`' }, { quoted: msg }); return; }
        const dd = match[1].padStart(2, '0');
        const mm = match[2].padStart(2, '0');
        if (!storage.data.birthdays) storage.data.birthdays = {};
        if (!storage.data.birthdays[chatId]) storage.data.birthdays[chatId] = {};
        storage.data.birthdays[chatId][userInfo.number] = dd + '/' + mm;
        storage.flagSave();
        await sock.sendMessage(chatId, { text: '🎂 Aniversário de ' + userInfo.smartMention + ' cadastrado: *' + dd + '/' + mm + '*! Você será parabenizado automaticamente. 🎉', mentions: [userInfo.mentionJid, userInfo.jid] }, { quoted: msg });
        return;
    }
    if (firstWord === '!countdown') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        if (parseInt(getUserRole(userId, storage.data.users)) < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        const arg = text.slice(firstWord.length).trim();
        const dateMatch = arg.match(/(\d{4}-\d{2}-\d{2})/);
        if (!dateMatch) { await sock.sendMessage(chatId, { text: '❌ *Uso:* `!countdown nome YYYY-MM-DD`\nEx: `!countdown Natal 2026-12-25`' }, { quoted: msg }); return; }
        const name = arg.replace(dateMatch[0], '').trim() || 'Evento';
        if (!storage.data.countdowns) storage.data.countdowns = {};
        if (!storage.data.countdowns[chatId]) storage.data.countdowns[chatId] = {};
        const key = name.toLowerCase().replace(/\s+/g, '_');
        storage.data.countdowns[chatId][key] = { name, date: dateMatch[0] };
        storage.flagSave();
        const target = new Date(dateMatch[0] + 'T00:00:00-03:00').getTime();
        const days = Math.ceil((target - Date.now()) / (1000 * 60 * 60 * 24));
        await sock.sendMessage(chatId, { text: '⏳ *Countdown cadastrado:* ' + name + ' — faltam *' + days + ' dias*! Atualização diária às 07:00.' }, { quoted: msg });
        return;
    }
    if (firstWord === '!pergunta') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        if (parseInt(getUserRole(userId, storage.data.users)) < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        const q = text.slice(firstWord.length).trim();
        if (!q) { await sock.sendMessage(chatId, { text: '❌ *Uso:* `!pergunta Qual seu filme favorito?`' }, { quoted: msg }); return; }
        if (!storage.data.perguntaDia) storage.data.perguntaDia = {};
        storage.data.perguntaDia[chatId] = { question: q, date: new Date().toLocaleDateString('pt-BR') };
        storage.flagSave();
        await sock.sendMessage(chatId, { text: '🤔 *Pergunta do dia cadastrada!*\n\n"' + q + '"\n\nSerá disparada diariamente às 08:00.' }, { quoted: msg });
        return;
    }
    if (firstWord === '!verdade' || firstWord === '!desafio') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const verdades = ['Qual foi a maior mentira que você já contou?', 'Qual seu maior medo?', 'Qual foi a coisa mais vergonhosa que você fez?', 'Se pudesse trocar de vida com alguém do grupo, quem seria?', 'Qual seu maior arrependimento?', 'Qual foi o último sonho que você teve?', 'Qual segredo você nunca contou pra ninguém?', 'Se tivesse que deletar um app do celular, qual seria?', 'Qual foi a última vez que você chorou?', 'Qual sua maior qualidade e defeito?'];
        const desafios = ['Mande um áudio cantando o refrão da música que está tocando agora', 'Troque sua foto de perfil por um meme por 1 hora', 'Mande o print da última conversa do seu WhatsApp', 'Imite um animal por 10 segundos em áudio', 'Mande uma selfie fazendo careta', 'Deixe o próximo membro escolher sua foto de perfil', 'Conte uma piada ruim em áudio', 'Mande o último print da sua galeria', 'Fale 30 segundos sem parar sobre qualquer tema', 'Marque 3 pessoas e diga algo bonito sobre cada uma'];
        const isVerdade = firstWord === '!verdade';
        const list = isVerdade ? verdades : desafios;
        const pick = list[Math.floor(Math.random() * list.length)];
        const tJid = resolveTargetJid(msg, text);
        const tInfo = tJid ? getUserInfo(tJid) : null;
        const prefix = isVerdade ? '🔮 *VERDADE*' : '🔥 *DESAFIO*';
        const target = tInfo ? ' para ' + tInfo.smartMention : '';
        await sock.sendMessage(chatId, {
            text: prefix + target + ':\n\n' + pick,
            mentions: tInfo ? [tInfo.mentionJid, tInfo.jid] : []
        }, { quoted: msg });
        return;
    }
    if (firstWord === '!sorteio') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const arg = text.slice(firstWord.length).trim().toLowerCase();
        if (arg === 'participar' || arg === 'entrar') {
            const s = storage.data.sorteios?.[chatId];
            if (!s || s.ended) { await sock.sendMessage(chatId, { text: '❌ Nenhum sorteio ativo.' }, { quoted: msg }); return; }
            if (s.participants.includes(sender)) { await sock.sendMessage(chatId, { text: 'ℹ️ Você já está participando!' }, { quoted: msg }); return; }
            s.participants.push(sender);
            storage.flagSave();
            await sock.sendMessage(chatId, { text: '✅ ' + userInfo.smartMention + ' entrou no sorteio! (*' + s.participants.length + '* participantes)', mentions: [userInfo.mentionJid, userInfo.jid] }, { quoted: msg });
            return;
        }
        if (parseInt(getUserRole(userId, storage.data.users)) < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores podem criar sorteios.' }, { quoted: msg }); return; }
        const timeMatch = text.match(/(\d+)\s*(m|min|h|hr)/i);
        let ms = 600000;
        if (timeMatch) { const v = parseInt(timeMatch[1]); const u = timeMatch[2].toLowerCase(); ms = u.startsWith('h') ? v * 3600000 : v * 60000; }
        const prize = text.replace(firstWord, '').replace(timeMatch?.[0] || '', '').trim() || 'Prêmio surpresa';
        if (!storage.data.sorteios) storage.data.sorteios = {};
        storage.data.sorteios[chatId] = { prize, participants: [], endsAt: Date.now() + ms, ended: false };
        storage.flagSave();
        await sock.sendMessage(chatId, { text: '🎲 *NOVO SORTEIO!* 🎲\n\n🏆 *Prêmio:* ' + prize + '\n⏰ *Encerra em:* ' + Math.round(ms / 60000) + ' min\n\n👉 Digite `!sorteio participar` para entrar!' }, { quoted: msg });
        return;
    }
    if (firstWord === '!recompensa' || firstWord === '!daily') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        if (!storage.data.dailyRewardClaimed) storage.data.dailyRewardClaimed = {};
        if (!storage.data.dailyRewardClaimed[chatId]) storage.data.dailyRewardClaimed[chatId] = {};
        const today = new Date().toLocaleDateString('pt-BR');
        if (storage.data.dailyRewardClaimed[chatId][userInfo.number] === today) {
            await sock.sendMessage(chatId, { text: 'ℹ️ Você já resgatou sua recompensa hoje! Volte amanhã. 🕐' }, { quoted: msg });
            return;
        }
        const reward = 20 + Math.floor(Math.random() * 30);
        storage.addCoins(chatId, userInfo.number, reward);
        storage.data.dailyRewardClaimed[chatId][userInfo.number] = today;
        storage.flagSave();
        const newBal = storage.data.coins[chatId][userInfo.number];
        await sock.sendMessage(chatId, { text: '🎁 *RECOMPENSA DIÁRIA!*\n\n' + userInfo.smartMention + ' recebeu *💰' + reward + ' moedas*!\n💰 Saldo atual: ' + newBal, mentions: [userInfo.mentionJid, userInfo.jid] }, { quoted: msg });
        return;
    }
    if (firstWord === '!forca' || firstWord === '!f') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const words = ['banana','computador','whatsapp','javascript','cachorro','pipoca','girassol','teclado','montanha','chocolate'];
        const arg = text.slice(firstWord.length).trim().toLowerCase();
        if (!storage.data.hangman) storage.data.hangman = {};
        const cur = storage.data.hangman[chatId];
        if (!arg || arg === 'nova') {
            const w = words[Math.floor(Math.random() * words.length)];
            storage.data.hangman[chatId] = { word: w, guessed: [], misses: 0, by: userInfo.number };
            storage.flagSave();
            await sock.sendMessage(chatId, { text: '🎯 *FORCA INICIADA!*\n\nPalavra: ' + w.split('').map(() => '_').join(' ') + '\n\nUse `!forca <letra>` ou `!forca palavra <palavra>`' }, { quoted: msg });
            return;
        }
        if (!cur) { await sock.sendMessage(chatId, { text: '❌ Nenhuma forca ativa. Use `!forca nova`.' }, { quoted: msg }); return; }
        if (arg.startsWith('palavra ')) {
            const guess = arg.slice(8).trim();
            if (guess === cur.word) {
                delete storage.data.hangman[chatId]; storage.flagSave();
                await sock.sendMessage(chatId, { text: '🎉 *ACERTOU!* A palavra era "' + cur.word.toUpperCase() + '". Parabéns ' + userInfo.smartMention + '!', mentions: [userInfo.mentionJid, userInfo.jid] }, { quoted: msg });
            } else {
                cur.misses++; storage.flagSave();
                await sock.sendMessage(chatId, { text: '❌ Errou! (' + cur.misses + '/6 erros)' }, { quoted: msg });
                if (cur.misses >= 6) { delete storage.data.hangman[chatId]; storage.flagSave(); await sock.sendMessage(chatId, { text: '💀 *ENFORCADO!* A palavra era "' + cur.word.toUpperCase() + '".' }, { quoted: msg }); }
            }
            return;
        }
        const letter = arg[0];
        if (!letter) return;
        if (cur.guessed.includes(letter)) { await sock.sendMessage(chatId, { text: 'ℹ️ Letra "' + letter + '" já tentada.' }, { quoted: msg }); return; }
        cur.guessed.push(letter);
        if (!cur.word.includes(letter)) cur.misses++;
        storage.flagSave();
        const display = cur.word.split('').map(c => cur.guessed.includes(c) ? c : '_').join(' ');
        const won = !display.includes('_');
        if (won) { delete storage.data.hangman[chatId]; storage.flagSave(); await sock.sendMessage(chatId, { text: '🎉 *COMPLETOU!* "' + cur.word.toUpperCase() + '" — vitória de ' + userInfo.smartMention + '!', mentions: [userInfo.mentionJid, userInfo.jid] }, { quoted: msg }); return; }
        if (cur.misses >= 6) { delete storage.data.hangman[chatId]; storage.flagSave(); await sock.sendMessage(chatId, { text: '💀 *ENFORCADO!* A palavra era "' + cur.word.toUpperCase() + '".' }, { quoted: msg }); return; }
        await sock.sendMessage(chatId, { text: '🎯 Palavra: ' + display + '\n❌ Erros: ' + cur.misses + '/6\n🔤 Tentadas: ' + cur.guessed.join(', ') }, { quoted: msg });
        return;
    }
    if (firstWord === '!jogo') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        if (!storage.data.tictactoe) storage.data.tictactoe = {};
        const arg = text.slice(firstWord.length).trim();
        const cur = storage.data.tictactoe[chatId];
        if (!cur) {
            const tJid = resolveTargetJid(msg, text);
            if (!tJid) { await sock.sendMessage(chatId, { text: '❌ *Uso:* `!jogo @membro` para iniciar.' }, { quoted: msg }); return; }
            storage.data.tictactoe[chatId] = { board: ['1','2','3','4','5','6','7','8','9'], turn: sender, p1: sender, p2: tJid };
            storage.flagSave();
            const senderInfo = getUserInfo(sender);
            const targetInfo = getUserInfo(tJid);
            await sock.sendMessage(chatId, { text: '❌ *JOGO DA VELHA!*\n\n' + senderInfo.smartMention + ' vs ' + targetInfo.smartMention + '\n\n1|2|3\n4|5|6\n7|8|9\n\nVez de ' + senderInfo.pushName + '. Use `!jogo <posição>`.', mentions: [senderInfo.mentionJid, senderInfo.jid, targetInfo.mentionJid, targetInfo.jid] }, { quoted: msg });
            return;
        }
        const pos = parseInt(arg);
        if (!pos || pos < 1 || pos > 9) { await sock.sendMessage(chatId, { text: '❌ Use `!jogo <1-9>`.' }, { quoted: msg }); return; }
        if (sender !== cur.turn) { await sock.sendMessage(chatId, { text: '⏳ Não é sua vez!' }, { quoted: msg }); return; }
        if (!/^[1-9]$/.test(cur.board[pos-1])) { await sock.sendMessage(chatId, { text: '❌ Casa ocupada.' }, { quoted: msg }); return; }
        const mark = cur.turn === cur.p1 ? 'X' : 'O';
        cur.board[pos-1] = mark;
        const wins = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
        let winner = '';
        for (const w of wins) { if (cur.board[w[0]] !== '' && cur.board[w[0]] === cur.board[w[1]] && cur.board[w[1]] === cur.board[w[2]]) { winner = cur.turn; break; } }
        const full = cur.board.every(c => c === 'X' || c === 'O');
        if (winner || full) {
            delete storage.data.tictactoe[chatId]; storage.flagSave();
            const winnerInfo = winner ? getUserInfo(winner) : null;
            await sock.sendMessage(chatId, { text: winnerInfo ? '🏆 *VITÓRIA de ' + winnerInfo.smartMention + '!*' : '🤝 *EMPATE!*', mentions: winnerInfo ? [winnerInfo.mentionJid, winnerInfo.jid] : undefined }, { quoted: msg });
            return;
        }
        cur.turn = cur.turn === cur.p1 ? cur.p2 : cur.p1;
        storage.flagSave();
        await sock.sendMessage(chatId, { text: cur.board.slice(0,3).join('|') + '\n' + cur.board.slice(3,6).join('|') + '\n' + cur.board.slice(6,9).join('|') + '\n\nVez de ' + getUserInfo(cur.turn).pushName }, { quoted: msg });
        return;
    }
    if (firstWord === '!roleta') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const m = text.match(/(\d+)\s+(vermelho|preto|verde|\d+)/i);
        if (!m) { await sock.sendMessage(chatId, { text: '❌ *Uso:* `!roleta 50 vermelho` / `preto` / `verde` / número' }, { quoted: msg }); return; }
        const bet = parseInt(m[1]); const choice = m[2].toLowerCase();
        const bal = storage.data.coins?.[chatId]?.[userInfo.number] || 0;
        if (bal < bet) { await sock.sendMessage(chatId, { text: '❌ Saldo insuficiente (💰' + bal + ').' }, { quoted: msg }); return; }
        const num = Math.floor(Math.random() * 37);
        const reds = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
        const color = num === 0 ? 'verde' : reds.includes(num) ? 'vermelho' : 'preto';
        let mult = 0;
        if (choice === 'verde' && num === 0) mult = 14;
        else if ((choice === 'vermelho' || choice === 'preto') && color === choice) mult = 2;
        else if (/^\d+$/.test(choice) && parseInt(choice) === num) mult = 36;
        const delta = mult > 0 ? bet * (mult - 1) : -bet;
        storage.addCoins(chatId, userInfo.number, delta);
        await sock.sendMessage(chatId, { text: '🎰 *ROLETA:* caiu *' + num + ' ' + color.toUpperCase() + '*\n\n' + (mult > 0 ? '🎉 Você GANHOU 💰' + (bet * mult) + '!' : '💸 Você perdeu 💰' + bet + '.') + '\n💰 Saldo: ' + (bal + delta) }, { quoted: msg });
        return;
    }
    if (firstWord === '!bj') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        if (!storage.data.bjHands) storage.data.bjHands = {};
        if (!storage.data.bjHands[chatId]) storage.data.bjHands[chatId] = {};
        const arg = text.slice(firstWord.length).trim().toLowerCase();
        const hand = storage.data.bjHands[chatId][userInfo.number];
        const val = (cards: number[]) => { let s = cards.reduce((a,b)=>a+b,0); let aces = cards.filter(c=>c===11).length; while (s>21 && aces>0){s-=10;aces--;} return s; };
        const draw = () => { const r = Math.floor(Math.random()*13)+1; return r>10?10:r===1?11:r; };
        if (!hand || arg.match(/^\d+/)) {
            const bet = parseInt(arg) || 10;
            const bal = storage.data.coins?.[chatId]?.[userInfo.number] || 0;
            if (bal < bet) { await sock.sendMessage(chatId, { text: '❌ Saldo insuficiente (💰' + bal + ').' }, { quoted: msg }); return; }
            storage.data.bjHands[chatId][userInfo.number] = { player: [draw(), draw()], bot: [draw(), draw()], bet, done: false };
            storage.flagSave();
            const h = storage.data.bjHands[chatId][userInfo.number];
            await sock.sendMessage(chatId, { text: '🃏 *BLACKJACK* (aposta 💰' + bet + ')\n\nSua mão: ' + h.player.join(', ') + ' = *' + val(h.player) + '*\nBot: ' + h.bot[0] + ', ?\n\n`!bj hit` ou `!bj stand`' }, { quoted: msg });
            return;
        }
        if (!hand) { await sock.sendMessage(chatId, { text: '❌ Nenhuma mão ativa. Use `!bj <aposta>`.' }, { quoted: msg }); return; }
        if (arg === 'hit') {
            hand.player.push(draw()); storage.flagSave();
            if (val(hand.player) > 21) { storage.addCoins(chatId, userInfo.number, -hand.bet); delete storage.data.bjHands[chatId][userInfo.number]; storage.flagSave(); await sock.sendMessage(chatId, { text: '💥 *ESTOUROU!* (' + val(hand.player) + ') Você perdeu 💰' + hand.bet }, { quoted: msg }); return; }
            await sock.sendMessage(chatId, { text: '🃏 Sua mão: ' + hand.player.join(', ') + ' = *' + val(hand.player) + '*\n\n`!bj hit` ou `!bj stand`' }, { quoted: msg }); return;
        }
        if (arg === 'stand') {
            while (val(hand.bot) < 17) hand.bot.push(draw());
            const pv = val(hand.player), bv = val(hand.bot);
            let delta = 0; let res = '';
            if (bv > 21 || pv > bv) { delta = hand.bet; res = '🎉 VOCÊ VENCEU!'; }
            else if (pv === bv) { delta = 0; res = '🤝 EMPATE'; }
            else { delta = -hand.bet; res = '💸 BOT VENCEU'; }
            storage.addCoins(chatId, userInfo.number, delta);
            delete storage.data.bjHands[chatId][userInfo.number]; storage.flagSave();
            await sock.sendMessage(chatId, { text: '🃏 Você: ' + pv + ' | Bot: ' + bv + '\n\n' + res + (delta !== 0 ? ' (' + (delta>0?'+':'') + delta + ')' : '') }, { quoted: msg }); return;
        }
        return;
    }
    if (firstWord === '!marry' || firstWord === '!casar' || firstWord === '!namorar' || firstWord === '!conhecer') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const tJid = resolveTargetJid(msg, text);
        if (!tJid || tJid === sender) { await sock.sendMessage(chatId, { text: '❌ *Uso:* `' + firstWord + ' @pessoa`' }, { quoted: msg }); return; }
        if (!storage.data.marriages) storage.data.marriages = {};
        if (!storage.data.marriages[chatId]) storage.data.marriages[chatId] = {};
        const get = (n: string): any => {
            const value = (storage.data.marriages[chatId] as any)[n];
            if (!value) return null;
            return typeof value === 'string' ? { partner: value, type: 'casado' } : value;
        };
        const a = userInfo.number, b = extractRawNumber(tJid);
        if (get(a) || get(b)) { await sock.sendMessage(chatId, { text: '❌ Um de vocês já está em um relacionamento!' }, { quoted: msg }); return; }
        const type = firstWord === '!marry' || firstWord === '!casar' ? 'casado' : firstWord === '!namorar' ? 'namorando' : 'conhecendo';
        const emoji = type === 'casado' ? '💍' : type === 'namorando' ? '❤️' : '🤝';
        const verb = type === 'casado' ? 'CASAMENTO' : type === 'namorando' ? 'NAMORO' : 'NOVO CONHECIMENTO';
        (storage.data.marriages[chatId] as any)[a] = { partner: b, type };
        (storage.data.marriages[chatId] as any)[b] = { partner: a, type };
        storage.flagSave();
        const partnerInfo = getUserInfo(tJid);
        await sock.sendMessage(chatId, { text: emoji + ' *' + verb + '* ' + emoji + '\n\n' + userInfo.smartMention + ' 💞 ' + partnerInfo.smartMention + '\n\nFelicidades ao casal! 🎉', mentions: [userInfo.mentionJid, userInfo.jid, partnerInfo.mentionJid, partnerInfo.jid] }, { quoted: msg });
        return;
    }
    if (firstWord === '!divorciar' || firstWord === '!terminar') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const a = userInfo.number;
        const value = storage.data.marriages?.[chatId]?.[a] as any;
        const relationship = typeof value === 'string' ? { partner: value, type: 'casado' } : value;
        if (!relationship?.partner) { await sock.sendMessage(chatId, { text: '❌ Você não está em um relacionamento.' }, { quoted: msg }); return; }
        delete storage.data.marriages[chatId][a];
        delete storage.data.marriages[chatId][relationship.partner];
        storage.flagSave();
        const partnerInfo = getUserInfo(relationship.partner + '@s.whatsapp.net');
        await sock.sendMessage(chatId, { text: '💔 Relacionamento encerrado entre ' + userInfo.smartMention + ' e ' + partnerInfo.smartMention + '.', mentions: [userInfo.mentionJid, userInfo.jid, partnerInfo.mentionJid, partnerInfo.jid] }, { quoted: msg });
        return;
    }
    if (firstWord === '!profile' || firstWord === '!perfil') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const tJid = resolveTargetJid(msg, text) || sender;
        const tNum = extractRawNumber(tJid);
        const tInfo = getUserInfo(tJid, tJid === sender ? pushNameRaw : '');
        const xpV = storage.data.xp?.[chatId]?.[tNum] || 0;
        const lvl = storage.getLevel(xpV); const role = storage.getRoleByLevel(lvl);
        const coinsV = storage.data.coins?.[chatId]?.[tNum] || 0;
        const partnerValue = storage.data.marriages?.[chatId]?.[tNum] as any;
        const partner = typeof partnerValue === 'string' ? { partner: partnerValue, type: 'casado' } : partnerValue;
        const buf = await generateProfileCard(tInfo.pushName || 'Membro', lvl, role + (partner ? ' 💍' : ''), xpV, coinsV);
        await sock.sendMessage(chatId, { image: buf, caption: '📇 *PERFIL DE ' + (tInfo.pushName || 'MEMBRO').toUpperCase() + '*' }, { quoted: msg });
        return;
    }
    if (firstWord === '!meme') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const parts = text.slice(firstWord.length).split('|');
        const top = (parts[0] || 'QUANDO O BOT').trim().toUpperCase();
        const bottom = (parts[1] || 'FUNCIONA DE PRIMEIRA').trim().toUpperCase();
        const buf = await generateMemeCard(top, bottom);
        await sock.sendMessage(chatId, { image: buf, caption: '😂 *MEME*' }, { quoted: msg });
        return;
    }
    if (firstWord === '!quote' || firstWord === '!citacao') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const ctxQ = msg.message?.extendedTextMessage?.contextInfo;
        const qText = ctxQ?.quotedMessage?.conversation || ctxQ?.quotedMessage?.extendedTextMessage?.text || '';
        const qFrom = ctxQ?.participant || '';
        if (!qText) { await sock.sendMessage(chatId, { text: '❌ Responda uma mensagem com `!quote`.' }, { quoted: msg }); return; }
        const qInfo = qFrom ? getUserInfo(qFrom) : null;
        const buf = await generateQuoteCard(qInfo ? (qInfo.pushName || 'Membro') : 'Membro', qText.slice(0, 80));
        await sock.sendMessage(chatId, { image: buf, caption: '💬 *CITAÇÃO*' }, { quoted: msg });
        return;
    }
    if (firstWord === '!sfont') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const arg = text.slice(firstWord.length).trim();
        if (!arg) { await sock.sendMessage(chatId, { text: '❌ *Uso:* `!sfont seu texto` (vira figurinha)' }, { quoted: msg }); return; }
        const colors = ['#7b2ff7', '#f107a3', '#00c853', '#ff6d00', '#2979ff'];
        const bg = colors[Math.floor(Math.random() * colors.length)];
        const buf = await generateTextSticker(arg.slice(0, 20), bg);
        await sock.sendMessage(chatId, { sticker: buf }, { quoted: msg });
        return;
    }
    if (['!yt', '!youtube', '!tiktok', '!tt', '!insta', '!ig', '!musica', '!music', '!bg', '!fundo'].includes(firstWord)) {
        await sock.sendMessage(chatId, { text: '⚠️ Este comando está temporariamente desativado para manutenção.' }, { quoted: msg });
        return;
    }
    if (firstWord === '!traduzir' || firstWord === '!translate') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const ctxT = msg.message?.extendedTextMessage?.contextInfo;
        const qText = ctxT?.quotedMessage?.conversation || ctxT?.quotedMessage?.extendedTextMessage?.text || '';
        const lang = text.slice(firstWord.length).trim().toLowerCase() || 'pt';
        if (!qText) { await sock.sendMessage(chatId, { text: '❌ Responda uma mensagem com `!traduzir [idioma]` (padrão: pt).' }, { quoted: msg }); return; }
        await sock.sendMessage(chatId, { text: '⏳ Traduzindo...' }, { quoted: msg });
        const tr = await translateText(qText, lang);
        await sock.sendMessage(chatId, { text: tr ? '🌐 *Tradução (' + lang + '):*\n\n' + tr : '❌ Falha na tradução.' }, { quoted: msg });
        return;
    }
    if (firstWord === '!dicionario' || firstWord === '!definicao') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const w = text.slice(firstWord.length).trim();
        if (!w) { await sock.sendMessage(chatId, { text: '❌ *Uso:* `!dicionario palavra`' }, { quoted: msg }); return; }
        const def = await defineWord(w);
        await sock.sendMessage(chatId, { text: def ? '📖 *' + w.toUpperCase() + '*\n\n' + def : '❌ Palavra não encontrada.' }, { quoted: msg });
        return;
    }
    if (firstWord === '!signos' || firstWord === '!compatibilidade') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const signs = ['aries','touro','gemeos','cancer','leao','virgem','libra','escorpiao','sagitario','capricornio','aquario','peixes'];
        const arg = text.slice(firstWord.length).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const parts = arg.split(/\s+/).filter(Boolean);
        if (parts.length < 2) { await sock.sendMessage(chatId, { text: '❌ *Uso:* `!signos aries leao`' }, { quoted: msg }); return; }
        const a = signs.indexOf(parts[0]); const b = signs.indexOf(parts[1]);
        if (a < 0 || b < 0) { await sock.sendMessage(chatId, { text: '❌ Signos: ' + signs.join(', ') }, { quoted: msg }); return; }
        const compat = [98,72,88,55,90,65,78,45,82,60,70,95,72,96,60,85,50,92,68,80,58,75,88,62,88,60,94,70,82,55,90,48,85,63,76,80,55,85,70,97,62,88,72,90,65,82,58,78,90,50,82,62,95,68,80,52,88,60,74,85,65,92,55,88,68,96,72,85,60,90,66,82,78,68,90,72,80,72,93,58,86,64,79,88,45,80,48,90,52,85,58,96,62,88,70,82,82,58,85,65,88,60,86,62,94,68,80,75,60,75,63,82,60,90,64,88,68,92,72,86,70,88,76,58,74,66,79,70,80,72,90,68,95,62,80,78,85,82,88,82,75,86,68,97];
        const idx = a * 12 + b;
        const pct = compat[idx] || 70;
        let verdict = pct >= 85 ? '💘 ALTA COMPATIBILIDADE!' : pct >= 65 ? '❤️ Boa combinação.' : pct >= 45 ? '🤔 Requer esforço.' : '💔 Baixa compatibilidade.';
        await sock.sendMessage(chatId, { text: '✨ *COMPATIBILIDADE*\n\n' + parts[0] + ' × ' + parts[1] + ' = *' + pct + '%*\n\n' + verdict }, { quoted: msg });
        return;
    }
    if (firstWord === '!apelido') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const prefixes = ['Mestre','Lenda','Rei','Rainha','Capitão','Doutor','Professor','Ninja','Turbo','Mega','Super','Ultra','Divino','Épico','Supremo'];
        const suffixes = ['do Grupo','das Galáxias','Supremo','Invencível','Lendário','dos Memes','da Madrugada','Imbatível','Sombrio','Radiante'];
        const nick = prefixes[Math.floor(Math.random()*prefixes.length)] + ' ' + userInfo.pushName + ' ' + suffixes[Math.floor(Math.random()*suffixes.length)];
        await sock.sendMessage(chatId, { text: '🎭 Seu novo apelido: *' + nick + '* 😎', mentions: [userInfo.jid] }, { quoted: msg });
        return;
    }
    if (firstWord === '!exportar') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        if (parseInt(getUserRole(userId, storage.data.users)) < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        const hist = storage.data.chatHistory?.[chatId] || {};
        let txt = 'EXPORT DE CONVERSA - ' + chatId + '\nGerado em ' + new Date().toLocaleString('pt-BR') + '\n\n';
        for (const date in hist) { for (const line of (hist[date] || [])) { txt += '[' + date + '] ' + line + '\n'; } }
        const buf = Buffer.from(txt, 'utf8');
        await sock.sendMessage(chatId, { document: buf, mimetype: 'text/plain', fileName: 'conversa_' + chatId.replace(/\D/g,'') + '.txt', caption: '📄 Export da conversa em TXT' }, { quoted: msg });
        return;
    }
    if (firstWord === '!broadcast') {
        if (parseInt(getUserRole(userId, storage.data.users)) < 5) { await sock.sendMessage(chatId, { text: '❌ Apenas Super Admin.' }, { quoted: msg }); return; }
        const bcMsg = text.slice(firstWord.length).trim();
        if (!bcMsg) { await sock.sendMessage(chatId, { text: '❌ *Uso:* `!broadcast mensagem` (envia a todos os grupos)' }, { quoted: msg }); return; }
        const groups = Object.keys(storage.data.groupStats || {});
        let ok = 0;
        for (const g of groups) { try { await sock.sendMessage(g, { text: '📢 *BROADCAST*\n\n' + bcMsg }); ok++; } catch (e) { } }
        await sock.sendMessage(chatId, { text: '✅ Broadcast enviado para *' + ok + '/' + groups.length + '* grupos.' }, { quoted: msg });
        return;
    }
    if (firstWord === '!gol') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        if (parseInt(getUserRole(userId, storage.data.users)) < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        const on = !text.slice(firstWord.length).trim().toLowerCase().startsWith('off');
        if (!storage.data.goalAlerts) storage.data.goalAlerts = {};
        if (on) { storage.data.goalAlerts[chatId] = {}; storage.flagSave(); await sock.sendMessage(chatId, { text: '⚽ *Alertas de GOL ativados!* Notificações a cada minuto quando houver partidas ao vivo. (Requer API-Football configurada.)' }, { quoted: msg }); }
        else { delete storage.data.goalAlerts[chatId]; storage.flagSave(); await sock.sendMessage(chatId, { text: '⚽ Alertas de GOL desativados.' }, { quoted: msg }); }
        return;
    }
    if (firstWord === '!remind' || firstWord === '!lembrete') {
        const reminderMatch = text.match(/(\d+)\s*(s|m|min|h|hr)/i);
        if (!reminderMatch) { await sock.sendMessage(chatId, { text: '❌ *Uso:* `!remind 10m texto do lembrete`' }, { quoted: msg }); return; }
        const value = parseInt(reminderMatch[1], 10);
        const unit = reminderMatch[2].toLowerCase();
        const duration = unit.startsWith('h') ? value * 3600000 : unit.startsWith('s') ? value * 1000 : value * 60000;
        const reminderText = text.replace(reminderMatch[0], '').trim() || 'Seu lembrete!';
        storage.data.reminders.push({ id: Date.now() + '_' + userInfo.number, chatId, userJid: sender, text: reminderText, runAt: Date.now() + duration });
        storage.flagSave();
        await sock.sendMessage(chatId, { text: '⏰ Lembrete agendado para daqui a *' + value + unit + '*:\n"' + reminderText + '"', mentions: [userInfo.jid] }, { quoted: msg });
        return;
    }
    if (firstWord === '!relatorio') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        if (parseInt(getUserRole(userId, storage.data.users)) < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        const stats = storage.data.groupStats?.[chatId] || {};
        const entries = Object.entries(stats).map(([num, stat]) => ({ num, total: stat.total || 0 })).sort((a, b) => b.total - a.total).slice(0, 5);
        const totalMessages = Object.values(stats).reduce((total, stat) => total + (stat.total || 0), 0);
        const logs = storage.data.adminLog?.[chatId] || [];
        const week = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const recent = logs.filter(log => log.ts > week);
        const joins = recent.filter(log => log.action.includes('ENTROU')).length;
        const leaves = recent.filter(log => log.action.includes('SAIU') || log.action.includes('REMOVIDO')).length;
        const warns = recent.filter(log => /advert|warn/i.test(log.action)).length;
        const mentions: string[] = [];
        let report = '📊 *RELATÓRIO SEMANAL*\n\n💬 Total de mensagens: *' + totalMessages + '*\n👥 Entraram: ' + joins + ' | Saíram/Removidos: ' + leaves + '\n⚠️ Advertências: ' + warns + '\n\n🏆 *TOP 5 ATIVOS:*\n';
        entries.forEach((entry, index) => {
            const info = getUserInfo(entry.num + '@s.whatsapp.net', storage.data.cache?.names?.[entry.num] || '');
            report += (index + 1) + '. ' + info.smartMention + ' — ' + entry.total + ' msgs\n';
            if (info.mentionJid) mentions.push(info.mentionJid);
            if (info.jid) mentions.push(info.jid);
        });
        await sock.sendMessage(chatId, { text: report, mentions }, { quoted: msg });
        return;
    }
    if (firstWord === '!log') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        if (parseInt(getUserRole(userId, storage.data.users)) < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        const logs = (storage.data.adminLog?.[chatId] || []).filter(log => log.action.includes('ENTROU') || log.action.includes('SAIU') || log.action.includes('REMOVIDO')).slice(-20);
        if (!logs.length) { await sock.sendMessage(chatId, { text: '📋 Sem registros de entrada/saída.' }, { quoted: msg }); return; }
        let report = '📋 *LOG DE MEMBROS (últimos 20)*\n\n';
        for (const log of logs) {
            const date = new Date(log.ts);
            report += date.toLocaleDateString('pt-BR') + ' ' + date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + ' — ' + log.action + (log.target ? ' (+' + log.target + ')' : '') + '\n';
        }
        await sock.sendMessage(chatId, { text: report }, { quoted: msg });
        return;
    }
    if (firstWord === '!faq') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        if (parseInt(getUserRole(userId, storage.data.users)) < 2) { await sock.sendMessage(chatId, { text: '❌ Apenas administradores.' }, { quoted: msg }); return; }
        const enabled = !text.slice(firstWord.length).trim().toLowerCase().startsWith('off');
        storage.data.faqEnabled[chatId] = enabled;
        storage.flagSave();
        await sock.sendMessage(chatId, { text: (enabled ? '🟢' : '🔴') + ' *FAQ IA:* ' + (enabled ? 'ATIVADO (responde perguntas automaticamente, 1x/min)' : 'DESATIVADO') }, { quoted: msg });
        return;
    }
    if (firstWord === '!clima') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Só em grupos.' }, { quoted: msg }); return; }
        const buffer = storage.data.messageBuffer?.[chatId] || {};
        const texts = Object.values(buffer).map(message => (message.text || '').toLowerCase()).slice(-30);
        const positive = ['bom', 'boa', 'otimo', 'ótima', 'feliz', 'amor', 'top', 'legal', 'obrigado', 'parabéns', 'gratidão', '🎉', '❤️', '😂', '👏', '😊'];
        const negative = ['ruim', 'péssimo', 'pessimo', 'odio', 'ódio', 'triste', 'raiva', 'chato', 'lixo', '😡', '😞'];
        let positiveCount = 0;
        let negativeCount = 0;
        for (const message of texts) {
            for (const word of positive) if (message.includes(word)) positiveCount++;
            for (const word of negative) if (message.includes(word)) negativeCount++;
        }
        const total = positiveCount + negativeCount || 1;
        const percentage = Math.round((positiveCount / total) * 100);
        const mood = percentage >= 70 ? '😄 Clima POSITIVO e animado!' : percentage >= 40 ? '😐 Clima NEUTRO.' : '😟 Clima TENSO / negativo.';
        await sock.sendMessage(chatId, { text: '🌡️ *CLIMA DO GRUPO*\n\n😊 Positivo: ' + percentage + '%\n😞 Negativo: ' + (100 - percentage) + '%\n\n' + mood + '\n_(baseado nas últimas ' + texts.length + ' msgs)_' }, { quoted: msg });
        return;
    }
    if (firstWord === '!ticket') {
        const ticketMessage = text.slice(firstWord.length).trim();
        if (!ticketMessage) { await sock.sendMessage(chatId, { text: '❌ *Uso:* `!ticket descrição do problema`' }, { quoted: msg }); return; }
        if (storage.data.activeTicket) { await sock.sendMessage(chatId, { text: '⚠️ Já existe um ticket aberto. Aguarde atendimento.' }, { quoted: msg }); return; }
        storage.data.activeTicket = { userJid: sender, openedAt: Date.now() };
        storage.flagSave();
        const creator = '5511927018683@s.whatsapp.net';
        try { await sock.sendMessage(creator, { text: '🎫 *NOVO TICKET DE SUPORTE*\n\n👤 De: ' + userInfo.nameAndNumber + '\n💬 ' + ticketMessage + '\n\n_Responda aqui no privado para atender. Use `!fecharticket` para encerrar._' }); } catch (e) { }
        await sock.sendMessage(chatId, { text: '🎫 Ticket aberto! O suporte foi notificado no privado e responderá em breve.', mentions: [userInfo.jid] }, { quoted: msg });
        return;
    }
    if (firstWord === '!fecharticket') {
        if (userInfo.number !== '5511927018683') { await sock.sendMessage(chatId, { text: '❌ Apenas o suporte pode encerrar tickets.' }, { quoted: msg }); return; }
        if (!storage.data.activeTicket) { await sock.sendMessage(chatId, { text: 'ℹ️ Nenhum ticket aberto.' }, { quoted: msg }); return; }
        const ticketUser = storage.data.activeTicket.userJid;
        storage.data.activeTicket = null;
        storage.flagSave();
        try { await sock.sendMessage(ticketUser, { text: '✅ Seu ticket foi ENCERRADO. Obrigado pelo contato!' }); } catch (e) { }
        await sock.sendMessage(chatId, { text: '✅ Ticket encerrado.' }, { quoted: msg });
        return;
    }
    if (firstWord === '!horario') {
        if (parseInt(getUserRole(userId, storage.data.users)) < 5) { await sock.sendMessage(chatId, { text: '❌ Apenas Super Admin.' }, { quoted: msg }); return; }
        const argument = text.slice(firstWord.length).trim();
        if (argument.toLowerCase() === 'off') { storage.data.businessHours = null; storage.flagSave(); await sock.sendMessage(chatId, { text: '🔴 Auto-resposta de horário DESATIVADA.' }, { quoted: msg }); return; }
        const hours = argument.match(/(\d{2}:\d{2})\s*(\d{2}:\d{2})/);
        if (!hours) { await sock.sendMessage(chatId, { text: '❌ *Uso:* `!horario 08:00 18:00 mensagem fora do horário`' }, { quoted: msg }); return; }
        const messageOut = argument.replace(hours[0], '').trim() || '⏰ Estamos fora do horário de atendimento agora.';
        storage.data.businessHours = { open: hours[1], close: hours[2], msg: messageOut };
        storage.flagSave();
        await sock.sendMessage(chatId, { text: '🟢 Horário comercial: ' + hours[1] + ' às ' + hours[2] + '. Fora disso, auto-resposta no privado.' }, { quoted: msg });
        return;
    }
    // ===== SISTEMA DE DENÚNCIA =====

    if (firstWord === '!cadastrogrupodenuncia') {
        if (!isGroup) { await sock.sendMessage(chatId, { text: '❌ Use este comando dentro do grupo que receberá as denúncias.' }, { quoted: msg }); return; }
        if (!isSuperAdmin(userId, storage.data.users)) { await sock.sendMessage(chatId, { text: '❌ Apenas super admin.' }, { quoted: msg }); return; }
        storage.data.reportAdminGroup = chatId;
        storage.flagSave();
        await sock.sendMessage(chatId, { text: '✅ *GRUPO DE DENÚNCIAS REGISTRADO!*\n\nEste grupo receberá todas as denúncias com evidências.' }, { quoted: msg });
        return;
    }

    if (firstWord === '!denunciar') {
        if (!storage.data.reportAdminGroup) {
            await sock.sendMessage(chatId, { text: '❌ Sistema de denúncias não configurado. Avise um admin.' }, { quoted: msg });
            return;
        }
        storage.data.pendingReports[userId] = {
            userId,
            chatId,
            step: 'waiting_evidence',
            reporterJid: sender,
            groupName: isGroup ? (await sock.groupMetadata(chatId).catch(() => null))?.subject || 'Desconhecido' : 'Privado'
        };
        storage.flagSave();
        await sock.sendMessage(chatId, { text: '📎 *DENÚNCIA INICIADA*\n\nAnexe uma imagem como evidência (print, foto, etc).\n\n_O número do infrator será extraído automaticamente e enviado aos administradores._' }, { quoted: msg });
        return;
    }

    if (!firstWord.startsWith('!') && textLower.includes('denuncia') && !storage.data.pendingReports[userId]) {
        await sock.sendMessage(chatId, { text: '⚠️ *DENÚNCIA*\n\nPara registrar uma denúncia, responda com *!denunciar*\n\n_Você poderá anexar uma imagem como evidência._' }, { quoted: msg });
        return;
    }

    if (storage.data.reportAdminGroup && chatId === storage.data.reportAdminGroup && !key.fromMe) {
        const resposta = text.trim();
        if (resposta === '1' || resposta === '2') {
            const adminRole = parseInt(getUserRole(userId, storage.data.users));
            if (adminRole < 2) return;

            const entries = Object.entries(storage.data.pendingReports).filter(([_, r]) => r.step === 'waiting_admin_decision');
            if (entries.length === 0) return;

            const [reportKey, report] = entries[entries.length - 1];

            if (resposta === '1' && report.extractedNumber) {
                try {
                    const meta = await sock.groupMetadata(report.chatId).catch(() => null);
                    if (meta) {
                        const alvo = meta.participants.find((p: any) => {
                            const pid = (p.id || '').split('@')[0].split(':')[0].replace(/\D/g, '');
                            const plid = (((p as any).lid || '') + '').split('@')[0].split(':')[0].replace(/\D/g, '');
                            return pid === report.extractedNumber || plid === report.extractedNumber || pid.endsWith(report.extractedNumber!) || plid.endsWith(report.extractedNumber!);
                        });
                        if (alvo) {
                            await sock.groupParticipantsUpdate(report.chatId, [alvo.id], 'remove');
                            await sock.sendMessage(chatId, { text: '✅ Usuário *' + report.extractedNumber + '* removido do grupo *' + report.groupName + '*.' });
                        } else {
                            await sock.sendMessage(chatId, { text: '⚠️ Não encontrei o número *' + report.extractedNumber + '* no grupo. Talvez já tenha saído.' });
                        }
                    }
                } catch (e: any) {
                    await sock.sendMessage(chatId, { text: '❌ Erro ao remover: ' + e.message });
                }
            } else {
                await sock.sendMessage(chatId, { text: '❌ Remoção cancelada.' });
            }

            delete storage.data.pendingReports[reportKey];
            storage.flagSave();
            return;
        }
    }

    if (textLower === '!ajuda') {
        const userRole = parseInt(getUserRole(userId, storage.data.users));
        const isAdmin = userRole >= 2;
        let menu = '🤖 *BOT DROPHTTP* 🤖\n\n';
        menu += '*🔌 CONTROLE*\n';
        menu += '`!bot on/off` - Ligar/desligar\n';
        menu += '`!divulga` - Divulgação\n';
        menu += '`!admins` - Listar admins\n\n';
        menu += '*🧠 IA*\n';
        menu += '`!ia [pergunta]` - Consulta IA\n';
        menu += '`!status` - Painel\n';
        menu += '`!horariobot` - Debug\n\n';
        menu += '*🎮 DIVERSÃO / ENGAJAMENTO*\n';
        menu += '`!level` / `!nivel` — Seu nível e XP\n';
        menu += '`!recompensa` — Resgatar moedas diárias\n';
        menu += '`!pay @membro valor` — Transferir moedas\n';
        menu += '`!shop` — Loja do grupo\n';
        menu += '`!reaction palavra emoji` — Auto-reação\n';
        menu += '`!aniversario DD/MM` — Cadastrar aniversário\n';
        menu += '`!countdown nome YYYY-MM-DD` — Contagem regressiva\n';
        menu += '`!pergunta texto` — Pergunta do dia (08:00)\n';
        menu += '`!verdade` / `!desafio` — Brincadeiras\n';
        menu += '`!sorteio prêmio 10m` — Criar sorteio\n';
        menu += '`!sorteio participar` — Entrar no sorteio\n';
        menu += '`!forca nova` / `!forca letra` — Jogo da forca\n';
        menu += '`!jogo @membro` / `!jogo 1-9` — Jogo da velha\n';
        menu += '`!roleta 50 vermelho` — Roleta de moedas\n';
        menu += '`!bj 20` / `!bj hit` / `!bj stand` — Blackjack\n';
        menu += '`!marry @membro` / `!divorciar` — Casamento\n';
        menu += '`!profile` / `!perfil` — Card em imagem\n';
        menu += '`!meme topo | fundo` — Meme em imagem\n';
        menu += '`!quote` (responder) — Citação em card\n';
        menu += '`!sfont texto` — Texto vira figurinha\n';
        menu += '\n*🎨 DIVERSÃO*\n';
        menu += '`!s` `!s2img` - Figurinhas\n';
        menu += '`!wiki` `!rank`\n';
        menu += '`!enquete Pergunta | Op1 | Op2`\n\n';
        menu += '*🎵 MÚSICA*\n';
        menu += '`!musica [nome]` - Buscar música\n';
        if (isAdmin) menu += '`!botmusica on/off`\n\n';
        menu += '*📰 UTILIDADE / MÍDIA*\n';
        menu += '`!yt nome` — Buscar no YouTube\n';
        menu += '`!tiktok link` / `!insta link` — Download\n';
        menu += '`!musica nome` — Preview de música\n';
        menu += '`!bg` (responder imagem) — Remover fundo\n';
        menu += '`!traduzir [idioma]` (responder) — Traduzir\n';
        menu += '`!dicionario palavra` — Definição\n';
        menu += '`!signos aries leao` — Compatibilidade\n';
        menu += '`!apelido` — Gerador de apelido\n';
        menu += '`!exportar` — Conversa em TXT (admin)\n';
        menu += '`!broadcast msg` — Enviar a todos os grupos (super admin)\n';
        menu += '`!gol on/off` — Alertas de gol ao vivo (admin)\n';
        menu += '`!remind 10m texto` — Lembrete único\n';
        menu += '`!relatorio` — Balanço semanal (admin)\n';
        menu += '`!log` — Entradas/saídas (admin)\n';
        menu += '`!faq on/off` — IA responde perguntas (admin)\n';
        menu += '`!clima` — Sentimento do grupo\n';
        menu += '`!ticket descrição` — Suporte no privado\n';
        menu += '`!horario 08:00 18:00 msg` — Auto-resposta (super admin)\n';
        menu += '\n*📰 UTIL*\n';
        menu += '`!n` `!h` `!t`\n';
        menu += '`!regras` `!id`';
        if (isAdmin) {
            menu += '\n\n*🛡️ ADMIN*\n';
            menu += '`!megafone + msg`\n';
            menu += '`!todos mensagem`\n';
            menu += '`!antilink on/off`\n';
            menu += '`!antifake on/off`\n';
            menu += '`!antinsfw on/off`\n';
            menu += '`!mute @membro 10m` / `!unmute`\n';
            menu += '`!blacklist + palavra` / `lista` / `remover`\n';
            menu += '`!antiforward on/off`\n';
            menu += '`!antistickerflood on/off`\n';
            menu += '`!raidmode on/off` — Tranca grupo em raid\n';
            menu += '`!captcha on/off` — Código de verificação\n';
            menu += '`!autoaprovar on/off` — Auto-aceitar solicitações\n';
            menu += '`!cota 50` / `off` — Limite diário de mensagens\n';
            menu += '`!autoremove 7` / `off` — Remove inativos (dias)\n';
            menu += '`!logadmin` — Log de ações de admin\n';
            menu += '`!lockmedia on/off` — Só texto permitido\n';
            menu += '`!purge 24` / `off` — Limpa msgs antigas diariamente\n';
            menu += '`!warn @membro`\n';
            menu += '`!ban @membro`\n';
            menu += '`!fechar` `!abrir`\n';
            menu += '`!sa` `!bv` `!exit`\n';
            menu += '`!msgremoveadm` - Mensagem de remoção\n';
            menu += '`!inativos` `!m` `!r`\n';
            menu += '`!idgrupo` `!linkcorreio`\n';
            menu += '`!cadastroidgrupo`\n';
            menu += '`!anonimo` `!responder`\n';
            menu += '`!vercorreio` `!limparcorreio`';
        }
        if (userRole === 5) {
            menu += '\n\n*👑 SUPER ADMIN*\n';
            menu += '`!cadastro+num+nivel`\n';
            menu += '`!remover`\n';
            menu += '`!botmanutencao` - Modo manutenção';
        }
        await sock.sendMessage(chatId, { text: menu, mentions: [userInfo.jid] });
        return;
    }
    if (firstWord.startsWith('!') && !isNavigatingMenu) {
        const suggestion = findSuggestedCommand(firstWord);
        const n8nSuggestion = await consultarN8nSugestao(text, userId, chatId);
        if (n8nSuggestion?.action === 'reply') {
            await sock.sendMessage(chatId, { text: n8nSuggestion.message, mentions: n8nSuggestion.mentions }, { quoted: msg });
            return;
        }
        if (suggestion) {
            await sock.sendMessage(chatId, { text: '💡 Você quis dizer `' + suggestion + '`?' }, { quoted: msg });
            return;
        }
        await sock.sendMessage(chatId, { text: '🤖 Comando não reconhecido.' }, { quoted: msg });
        return;
    }
}