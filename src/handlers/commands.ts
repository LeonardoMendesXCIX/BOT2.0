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
    