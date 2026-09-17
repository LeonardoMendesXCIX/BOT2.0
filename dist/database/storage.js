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
            botMusicDisabled: {},
            closedGroups: {},
            queuedWelcomes: {},
            promoSchedule: {},
            welcomeMsgs: {},
            welcomeReminders: {},
            pendingBvReminders: [],
            groupSchedules: {},
            exitMsgs: {},
            removalMsgs: {},
            inativosMsgs: {},
            antilink: {},
            antifake: {},
            antifakeStrictLid: {},
            antiflood: {},
            mutes: {},
            blacklistWords: {},
            antiForward: {},
            antiStickerFlood: {},
            warnTimestamps: {},
            raidMode: {},
            raidHistory: {},
            captcha: {},
            pendingCaptcha: {},
            autoApprove: {},
            dailyQuota: {},
            dailyQuotaCount: {},
            xp: {},
            coins: {},
            dailyRewardClaimed: {},
            autoReaction: {},
            birthdays: {},
            countdowns: {},
            perguntaDia: {},
            sorteios: {},
            autoRemoveInactive: {},
            autoRemoveWarned: {},
            adminLog: {},
            lockMedia: {},
            purgeSchedule: {},
            antinsfw: {},
            autoTranscribe: {},
            antidelete: {},
            messageBuffer: {},
            groupRules: {},
            warnings: {},
            maxWarnings: {},
            activeQuiz: {},
            goalAlerts: {},
            reminders: [],
            faqEnabled: {},
            lastFaqAnswer: {},
            businessHours: null,
            activeTicket: null,
            hangman: {},
            tictactoe: {},
            marriages: {},
            firstMsgSeen: {},
            bjHands: {},
            autoAnim: {},
            lastGroupActivity: {},
            autoAnimSent: {},
            disabledFeatures: {},
            anonMsgs: [],
            anonCounter: 1000,
            maintenance: false
        };
        this.load();
        setInterval(() => {
            if (this.pendingSave) {
                this.saveSync();
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
            const tmpFile = STORAGE_FILE + '.tmp';
            fs_1.default.writeFileSync(tmpFile, JSON.stringify(this.data, null, 2));
            try {
                fs_1.default.renameSync(tmpFile, STORAGE_FILE);
                this.pendingSave = false;
            }
            catch (renameErr) {
                setTimeout(() => {
                    try {
                        if (fs_1.default.existsSync(tmpFile))
                            fs_1.default.renameSync(tmpFile, STORAGE_FILE);
                        this.pendingSave = false;
                    }
                    catch (e2) {
                        console.error('[ERRO STORAGE] Renomeação após retry:', e2.message);
                    }
                }, 500);
            }
        }
        catch (e) {
            console.error('[ERRO STORAGE]', e.message);
        }
    }
    shutdown() {
        try {
            this.saveSync();
        }
        catch (e) { }
    }
    pruneStorage() {
        const now = Date.now();
        const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
        const FIFTEEN_MIN = 15 * 60 * 1000;
        if (this.data.chatHistory) {
            for (const chatId in this.data.chatHistory) {
                const days = this.data.chatHistory[chatId];
                for (const dateKey in days) {
                    const [d, m, y] = dateKey.split('/').map((n) => parseInt(n, 10));
                    const t = new Date(y || 2026, (m || 1) - 1, d || 1).getTime();
                    if (now - t > SEVEN_DAYS)
                        delete days[dateKey];
                }
            }
        }
        if (this.data.messageBuffer) {
            for (const chatId in this.data.messageBuffer) {
                const buf = this.data.messageBuffer[chatId];
                for (const msgId in buf) {
                    if (now - (buf[msgId].timestamp || 0) > FIFTEEN_MIN)
                        delete buf[msgId];
                }
            }
        }
        if (this.data.anonMsgs && this.data.anonMsgs.length > 500) {
            this.data.anonMsgs = this.data.anonMsgs.slice(-500);
        }
        this.flagSave();
    }
    addXp(chatId, num, amount) {
        if (!this.data.xp)
            this.data.xp = {};
        if (!this.data.xp[chatId])
            this.data.xp[chatId] = {};
        this.data.xp[chatId][num] = (this.data.xp[chatId][num] || 0) + amount;
        this.flagSave();
        return this.data.xp[chatId][num];
    }
    getLevel(xp) { return Math.floor(Math.sqrt(xp / 50)) + 1; }
    getRoleByLevel(level) {
        if (level >= 20)
            return '👑 Lenda';
        if (level >= 15)
            return '💎 Diamante';
        if (level >= 10)
            return '🥇 Ouro';
        if (level >= 5)
            return '🥈 Prata';
        if (level >= 2)
            return '🥉 Bronze';
        return '🌱 Iniciante';
    }
    addCoins(chatId, num, amount) {
        if (!this.data.coins)
            this.data.coins = {};
        if (!this.data.coins[chatId])
            this.data.coins[chatId] = {};
        this.data.coins[chatId][num] = (this.data.coins[chatId][num] || 0) + amount;
        this.flagSave();
        return this.data.coins[chatId][num];
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
    isMusicDisabled(chatId) {
        return this.data.botMusicDisabled?.[chatId] === true;
    }
    setMusicDisabled(chatId, disabled) {
        if (!this.data.botMusicDisabled)
            this.data.botMusicDisabled = {};
        this.data.botMusicDisabled[chatId] = disabled;
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
    isMuted(chatId, num) {
        const until = this.data.mutes?.[chatId]?.[num];
        return !!until && until > Date.now();
    }
    setMute(chatId, num, ms) {
        if (!this.data.mutes)
            this.data.mutes = {};
        if (!this.data.mutes[chatId])
            this.data.mutes[chatId] = {};
        this.data.mutes[chatId][num] = Date.now() + ms;
        this.flagSave();
    }
    clearMute(chatId, num) {
        if (this.data.mutes?.[chatId]) {
            delete this.data.mutes[chatId][num];
            this.flagSave();
        }
    }
    logAdminAction(chatId, adminNum, action, target) {
        if (!this.data.adminLog)
            this.data.adminLog = {};
        if (!this.data.adminLog[chatId])
            this.data.adminLog[chatId] = [];
        this.data.adminLog[chatId].push({ ts: Date.now(), admin: adminNum, action, target });
        if (this.data.adminLog[chatId].length > 100)
            this.data.adminLog[chatId] = this.data.adminLog[chatId].slice(-100);
        this.flagSave();
    }
    checkDailyQuota(chatId, userNum) {
        const limit = this.data.dailyQuota?.[chatId] || 0;
        if (!limit)
            return { allowed: true, limit: 0, used: 0 };
        if (!this.data.dailyQuotaCount)
            this.data.dailyQuotaCount = {};
        if (!this.data.dailyQuotaCount[chatId])
            this.data.dailyQuotaCount[chatId] = {};
        const today = new Date().toLocaleDateString('pt-BR');
        const entry = this.data.dailyQuotaCount[chatId][userNum];
        if (!entry || entry.date !== today) {
            this.data.dailyQuotaCount[chatId][userNum] = { count: 1, date: today };
            this.flagSave();
            return { allowed: true, limit, used: 1 };
        }
        entry.count++;
        this.flagSave();
        return { allowed: entry.count <= limit, limit, used: entry.count };
    }
    detectRaid(chatId) {
        if (!this.data.raidHistory)
            this.data.raidHistory = {};
        if (!this.data.raidHistory[chatId])
            this.data.raidHistory[chatId] = [];
        const now = Date.now();
        this.data.raidHistory[chatId].push(now);
        this.data.raidHistory[chatId] = this.data.raidHistory[chatId].filter(t => now - t < 60000);
        this.flagSave();
        return this.data.raidHistory[chatId].length >= 5;
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
        if (featureKey === 'antinsfw')
            this.data.antinsfw[chatId] = enabled;
        if (featureKey === 'audio_transcribe')
            this.data.autoTranscribe[chatId] = enabled;
        if (featureKey === 'antidelete')
            this.data.antidelete[chatId] = enabled;
        if (featureKey === 'auto')
            this.data.autoAnim[chatId] = enabled;
        if (featureKey === 'raidmode')
            this.data.raidMode[chatId] = enabled;
        if (featureKey === 'captcha')
            this.data.captcha[chatId] = enabled;
        if (featureKey === 'autoaprovar')
            this.data.autoApprove[chatId] = enabled;
        if (featureKey === 'lockmedia')
            this.data.lockMedia[chatId] = enabled;
        this.flagSave();
    }
    generateAnonId() {
        if (!this.data.anonCounter)
            this.data.anonCounter = 1000;
        this.data.anonCounter++;
        this.flagSave();
        return 'A' + this.data.anonCounter;
    }
    // ADVERTÊNCIAS: 3 advertências = remoção SILENCIOSA (sem aviso público da política)
    async applyWarning(sock, chatId, targetJid, reason, limitDefault = 3) {
        const targetNum = targetJid.split('@')[0].split(':')[0].replace(/\D/g, '');
        const targetInfo = (0, user_1.getUserInfo)(targetJid);
        const limit = (this.data.maxWarnings && this.data.maxWarnings[chatId]) || limitDefault;
        if (!this.data.warnings[chatId])
            this.data.warnings[chatId] = {};
        if (!this.data.warnTimestamps)
            this.data.warnTimestamps = {};
        if (!this.data.warnTimestamps[chatId])
            this.data.warnTimestamps[chatId] = {};
        if (!this.data.warnTimestamps[chatId][targetNum])
            this.data.warnTimestamps[chatId][targetNum] = [];
        const SEVEN = 7 * 24 * 60 * 60 * 1000;
        this.data.warnTimestamps[chatId][targetNum] = this.data.warnTimestamps[chatId][targetNum].filter(t => Date.now() - t < SEVEN);
        if (this.data.warnTimestamps[chatId][targetNum].length === 0)
            this.data.warnings[chatId][targetNum] = 0;
        this.data.warnings[chatId][targetNum] = (this.data.warnings[chatId][targetNum] || 0) + 1;
        this.data.warnTimestamps[chatId][targetNum].push(Date.now());
        const currentWarns = this.data.warnings[chatId][targetNum];
        this.flagSave();
        // Mensagem pública SEM mencionar a política de remoção
        await sock.sendMessage(chatId, {
            text: '⚠️ *ADVERTÊNCIA REGISTRADA (' + currentWarns + '/' + limit + ')*\n\n' +
                '👤 *Membro:* ' + targetInfo.smartMention + '\n' +
                '📝 *Motivo:* ' + reason,
            mentions: [targetInfo.mentionJid, targetInfo.jid]
        });
        // 3ª advertência: remoção automática silenciosa
        if (currentWarns >= limit) {
            try {
                await sock.groupParticipantsUpdate(chatId, [targetInfo.jid], 'remove');
                delete this.data.warnings[chatId][targetNum];
                this.flagSave();
                const removalCfg = this.data.removalMsgs?.[chatId];
                const removalText = removalCfg && removalCfg.text
                    ? removalCfg.text.replace(/\{membro\}/gi, targetInfo.smartMention)
                    : 'Xiii, acho que o integrante ' + targetInfo.smartMention + ' fez algo de errado, pois foi removido!';
                await sock.sendMessage(chatId, { text: removalText, mentions: [targetInfo.mentionJid, targetInfo.jid] });
            }
            catch (e) {
                console.error('[ERRO AUTO-REMOVE WARN]', e.message);
            }
        }
    }
}
exports.StorageManager = StorageManager;
