"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.StorageManager = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const user_1 = require("../utils/user");
const STORAGE_FILE = path_1.default.join(__dirname, '..', '..', 'bot_storage.json');
class StorageManager {
    data;
    pendingSave = false;
    constructor() {
        this.data = {
            states: {},
            cache: {},
            users: {},
            groupStats: {},
            scheduledMsgs: [],
            chatHistory: {},
            memoryCluster: {},
            lastJarvisIntervention: {},
            messageCountSinceLastJarvis: {},
            botDisabled: {},
            closedGroups: {},
            promoSchedule: {},
            welcomeMsgs: {},
            welcomeReminders: {},
            pendingBvReminders: [],
            pendingPresentations: [],
            activeTrolls: {},
            groupSchedules: {},
            exitMsgs: {},
            antilink: {},
            antifake: {},
            antiflood: {},
            antighost: {},
            autoMemes: {},
            jarvisMode: {},
            bannedWords: {},
            groupRules: {},
            warnings: {},
            maxWarnings: {},
            activeQuiz: {},
            autoAnim: {},
            lastGroupActivity: {},
            autoAnimSent: {},
            disabledFeatures: {}
        };
        this.load();
        setInterval(() => {
            if (this.pendingSave) {
                this.saveSync();
                this.pendingSave = false;
            }
        }, 15000);
    }
    load() {
        if (fs_1.default.existsSync(STORAGE_FILE)) {
            try {
                const raw = JSON.parse(fs_1.default.readFileSync(STORAGE_FILE, 'utf8'));
                this.data = { ...this.data, ...raw };
            }
            catch (e) {
                console.error('[ERRO STORAGE] Falha ao ler bot_storage.json, iniciando limpo.');
            }
        }
    }
    flagSave() {
        this.pendingSave = true;
    }
    saveSync() {
        try {
            fs_1.default.writeFile(STORAGE_FILE, JSON.stringify(this.data, null, 2), (err) => {
                if (err)
                    console.error('[ERRO STORAGE] Gravação assíncrona:', err.message);
            });
        }
        catch (e) {
            console.error('[ERRO STORAGE]', e.message);
        }
    }
    isBotDisabled(chatId) {
        if (!chatId)
            return false;
        return this.data.botDisabled?.[chatId] === true;
    }
    setBotDisabled(chatId, disabled) {
        if (!this.data.botDisabled)
            this.data.botDisabled = {};
        this.data.botDisabled[chatId] = disabled;
        this.flagSave();
    }
    isGroupClosed(chatId) {
        if (!chatId)
            return false;
        return this.data.closedGroups?.[chatId] === true;
    }
    setGroupClosed(chatId, closed) {
        if (!this.data.closedGroups)
            this.data.closedGroups = {};
        this.data.closedGroups[chatId] = closed;
        this.flagSave();
    }
    isPromoWindowActive(chatId) {
        if (!chatId || !this.data.promoSchedule || !this.data.promoSchedule[chatId])
            return false;
        const promo = this.data.promoSchedule[chatId];
        if (!promo.active || !promo.startTime || !promo.endTime)
            return false;
        const now = new Date();
        const currentHHMM = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false });
        if (promo.startTime <= promo.endTime) {
            return currentHHMM >= promo.startTime && currentHHMM < promo.endTime;
        }
        else {
            return currentHHMM >= promo.startTime || currentHHMM < promo.endTime;
        }
    }
    addMessageToCluster(chatId, authorNum, authorName, text) {
        if (!this.data.memoryCluster)
            this.data.memoryCluster = {};
        if (!this.data.memoryCluster[chatId])
            this.data.memoryCluster[chatId] = [];
        const now = Date.now();
        const THIRTY_MINUTES = 30 * 60 * 1000;
        this.data.memoryCluster[chatId].push({
            authorNum,
            authorName,
            text: text.substring(0, 350),
            timestamp: now
        });
        this.data.memoryCluster[chatId] = this.data.memoryCluster[chatId].filter(m => (now - m.timestamp) <= THIRTY_MINUTES);
        if (!this.data.messageCountSinceLastJarvis)
            this.data.messageCountSinceLastJarvis = {};
        this.data.messageCountSinceLastJarvis[chatId] = (this.data.messageCountSinceLastJarvis[chatId] || 0) + 1;
        this.flagSave();
    }
    purgeExpiredClusters() {
        if (!this.data.memoryCluster)
            return;
        const now = Date.now();
        const THIRTY_MINUTES = 30 * 60 * 1000;
        let modified = false;
        for (const chatId in this.data.memoryCluster) {
            const beforeLen = this.data.memoryCluster[chatId].length;
            this.data.memoryCluster[chatId] = this.data.memoryCluster[chatId].filter(m => (now - m.timestamp) <= THIRTY_MINUTES);
            if (this.data.memoryCluster[chatId].length !== beforeLen)
                modified = true;
        }
        if (modified)
            this.flagSave();
    }
    isFeatureDisabled(chatId, featureKey) {
        if (!chatId || !featureKey)
            return false;
        if (!this.data.disabledFeatures || !this.data.disabledFeatures[chatId])
            return false;
        return this.data.disabledFeatures[chatId][featureKey] === true;
    }
    setFeatureStatus(chatId, featureKey, enabled) {
        if (!this.data.disabledFeatures)
            this.data.disabledFeatures = {};
        if (!this.data.disabledFeatures[chatId])
            this.data.disabledFeatures[chatId] = {};
        this.data.disabledFeatures[chatId][featureKey] = !enabled;
        if (featureKey === 'antilink')
            this.data.antilink[chatId] = enabled;
        if (featureKey === 'antifake')
            this.data.antifake[chatId] = enabled;
        if (featureKey === 'antiflood')
            this.data.antiflood[chatId] = enabled;
        if (featureKey === 'antighost')
            this.data.antighost[chatId] = enabled;
        if (featureKey === 'meme')
            this.data.autoMemes[chatId] = enabled;
        if (featureKey === 'jarvis')
            this.data.jarvisMode[chatId] = enabled;
        if (featureKey === 'auto')
            this.data.autoAnim[chatId] = enabled;
        this.flagSave();
    }
    async applyWarning(sock, chatId, targetJid, reason, limitDefault = 2) {
        const targetNum = targetJid.split('@')[0].split(':')[0].replace(/\D/g, '');
        const targetInfo = (0, user_1.getUserInfo)(targetJid);
        const limit = (this.data.maxWarnings && this.data.maxWarnings[chatId]) || limitDefault;
        if (!this.data.warnings[chatId])
            this.data.warnings[chatId] = {};
        this.data.warnings[chatId][targetNum] = (this.data.warnings[chatId][targetNum] || 0) + 1;
        const currentWarns = this.data.warnings[chatId][targetNum];
        this.flagSave();
        if (currentWarns >= limit) {
            try {
                await sock.groupParticipantsUpdate(chatId, [targetInfo.jid], 'remove');
                delete this.data.warnings[chatId][targetNum];
                this.flagSave();
                await sock.sendMessage(chatId, {
                    text: `🚫 *JARVIS SECURITY (AUTO-BAN):*\n\nO integrante ${targetInfo.mentionTag} (*${targetInfo.pushName}*) atingiu o limite de ${currentWarns}/${limit} advertências e foi removido do grupo.\n📱 *Número:* ${targetInfo.formattedNum}\n📝 *Última infração:* ${reason}`,
                    mentions: [targetInfo.jid]
                });
                return;
            }
            catch (err) {
                console.error('[ERRO AUTO-BAN]', err.message);
            }
        }
        await sock.sendMessage(chatId, {
            text: `⚠️ *ADVERTÊNCIA REGISTRADA (${currentWarns}/${limit})*\n\n` +
                `👤 *Membro:* ${targetInfo.mentionTag} (*${targetInfo.pushName}*)\n` +
                `📱 *Número:* ${targetInfo.formattedNum}\n` +
                `📝 *Motivo:* ${reason}\n\n` +
                `_Jarvis Alerta: Ao atingir ${limit} advertências, o protocolo de remoção automática será acionado._`,
            mentions: [targetInfo.jid]
        });
    }
}
exports.StorageManager = StorageManager;
