import { WASocket } from '@whiskeysockets/baileys';
import { Pool } from 'pg';
import { getUserInfo } from '../utils/user';

export interface ClusterMessage {
    authorNum: string;
    authorName: string;
    text: string;
    timestamp: number;
}

export interface PromoSchedule {
    startTime: string;
    endTime: string;
    content: string;
    setBy: string;
    active: boolean;
}

export interface UserStats {
    text: number;
    media: number;
    total: number;
}

export interface AnonMessage {
    id: string;
    chatId: string;
    senderJid: string;
    senderNum: string;
    senderName: string;
    receiverJid: string;
    receiverNum: string;
    receiverName: string;
    text: string;
    timestamp: number;
    type: 'anonimo' | 'resposta';
    replyToId?: string;
}

export interface BotStorage {
    states: Record<string, any>;
    cache: Record<string, any>;
    users: Record<string, string>;
    groupStats: Record<string, Record<string, UserStats>>;
    scheduledMsgs: Array<{
        id: string;
        chatId: string;
        authorId: string;
        authorNum: string;
        text: string;
        hours: number[];
        isReps: boolean;
        lastSent: Record<string, boolean>;
    }>;
    chatHistory: Record<string, Record<string, string[]>>;
    memoryCluster: Record<string, ClusterMessage[]>;
    lastJarvisIntervention: Record<string, number>;
    messageCountSinceLastJarvis: Record<string, number>;
    botDisabled: Record<string, boolean>;
    botMusicDisabled: Record<string, boolean>;
    closedGroups: Record<string, boolean>;
    queuedWelcomes: Record<string, string[]>;
    promoSchedule: Record<string, PromoSchedule>;
    welcomeMsgs: Record<string, { text: string; setBy?: string; date?: string }>;
    welcomeReminders: Record<string, { text: string; setBy?: string; date?: string }>;
    pendingBvReminders: Array<{ id: string; chatId: string; newMemberId: string; runAt: number }>;
    groupSchedules: Record<string, { openTime?: string; closeTime?: string }>;
    exitMsgs: Record<string, { text: string; setBy?: string; date?: string }>;
    removalMsgs: Record<string, { text: string; setBy?: string; date?: string }>;
    inativosMsgs: Record<string, { text: string; setBy?: string; date?: string }>;
    antilink: Record<string, boolean>;
    antifake: Record<string, boolean>;
    antifakeStrictLid: Record<string, boolean>;
    antiflood: Record<string, boolean>;
    mutes: Record<string, Record<string, number>>;
    blacklistWords: Record<string, string[]>;
    antiForward: Record<string, boolean>;
    antiStickerFlood: Record<string, boolean>;
    warnTimestamps: Record<string, Record<string, number[]>>;
    raidMode: Record<string, boolean>;
    raidHistory: Record<string, number[]>;
    captcha: Record<string, boolean>;
    pendingCaptcha: Record<string, Record<string, { code: string; expires: number }>>;
    autoApprove: Record<string, boolean>;
    dailyQuota: Record<string, number>;
    dailyQuotaCount: Record<string, Record<string, { count: number; date: string }>>;
    xp: Record<string, Record<string, number>>;
    coins: Record<string, Record<string, number>>;
    dailyRewardClaimed: Record<string, Record<string, string>>;
    autoReaction: Record<string, Record<string, string>>;
    birthdays: Record<string, Record<string, string>>;
    countdowns: Record<string, Record<string, { name: string; date: string }>>;
    perguntaDia: Record<string, { question: string; date: string }>;
    sorteios: Record<string, { prize: string; participants: string[]; endsAt: number; ended: boolean }>;
    autoRemoveInactive: Record<string, number>;
    autoRemoveWarned: Record<string, string[]>;
    adminLog: Record<string, Array<{ ts: number; admin: string; action: string; target?: string }>>;
    lockMedia: Record<string, boolean>;
    purgeSchedule: Record<string, { hour: number; olderThanHrs: number }>;
    antinsfw: Record<string, boolean>;
    autoTranscribe: Record<string, boolean>;
    antidelete: Record<string, boolean>;
    messageBuffer: Record<string, Record<string, { text: string; sender: string; pushName: string; timestamp: number }>>;
    groupRules: Record<string, string>;
    warnings: Record<string, Record<string, number>>;
    maxWarnings: Record<string, number>;
    activeQuiz: Record<string, { question: string; answer: string; startedBy?: string; date?: number; timeout?: any }>;
    goalAlerts: Record<string, Record<string, { home: string; away: string; lastScore: string }>>;
    reminders: Array<{ id: string; chatId: string; userJid: string; text: string; runAt: number }>;
    faqEnabled: Record<string, boolean>;
    lastFaqAnswer: Record<string, number>;
    businessHours: { open: string; close: string; msg: string } | null;
    activeTicket: { userJid: string; openedAt: number } | null;
    hangman: Record<string, { word: string; guessed: string[]; misses: number; by: string }>;
    tictactoe: Record<string, { board: string[]; turn: string; p1: string; p2: string }>;
    marriages: Record<string, Record<string, string>>;
    firstMsgSeen: Record<string, Record<string, boolean>>;
    bjHands: Record<string, Record<string, { player: number[]; bot: number[]; bet: number; done: boolean }>>;
    autoAnim: Record<string, boolean>;
    lastGroupActivity: Record<string, number>;
    autoAnimSent: Record<string, boolean>;
    disabledFeatures: Record<string, Record<string, boolean>>;
    anonMsgs: AnonMessage[];
    anonCounter: number;
    maintenance: boolean;
}

const storagePool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'bot2',
});

export class StorageManager {
    public data: BotStorage;
    private pendingSave = false;
    public readonly ready: Promise<void>;

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
        this.ready = this.load();

        setInterval(() => {
            if (this.pendingSave) {
                this.saveSync();
            }
        }, 15000);
    }

    private async load(): Promise<void> {
        try {
            await storagePool.query(`CREATE TABLE IF NOT EXISTS bot_storage (key TEXT PRIMARY KEY, value JSONB NOT NULL)`);
            const result = await storagePool.query<{ key: string; value: BotStorage[keyof BotStorage] }>('SELECT key, value FROM bot_storage');
            for (const row of result.rows) {
                if (row.key in this.data) {
                    (this.data as any)[row.key] = row.value;
                }
            }
        } catch (e: any) {
            console.error('[ERRO STORAGE] Falha ao carregar PostgreSQL:', e.message);
        }
    }

    public flagSave(): void {
        this.pendingSave = true;
    }

    public saveSync(): void {
        void this.save();
    }

    private async save(): Promise<void> {
        if (!this.pendingSave) return;
        try {
            await this.ready;
            const client = await storagePool.connect();
            try {
                await client.query('BEGIN');
                for (const [key, value] of Object.entries(this.data)) {
                    await client.query(
                        'INSERT INTO bot_storage (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
                        [key, JSON.stringify(value)],
                    );
                }
                await client.query('COMMIT');
                this.pendingSave = false;
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            } finally {
                client.release();
            }
        } catch (e: any) {
            console.error('[ERRO STORAGE] Falha ao salvar PostgreSQL:', e.message);
        }
    }

    public async shutdown(): Promise<void> {
        await this.ready;
        await this.save();
        await storagePool.end();
    }

    public getData<T = any>(key: keyof BotStorage): T {
        return (this.data as any)[key] as T;
    }

    public setData<K extends keyof BotStorage>(key: K, value: BotStorage[K]): void {
        this.data[key] = value;
        this.flagSave();
    }

    public pruneStorage(): void {
        const now = Date.now();
        const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
        const FIFTEEN_MIN = 15 * 60 * 1000;

        if (this.data.chatHistory) {
            for (const chatId in this.data.chatHistory) {
                const days = this.data.chatHistory[chatId];
                for (const dateKey in days) {
                    const [d, m, y] = dateKey.split('/').map((n: string) => parseInt(n, 10));
                    const t = new Date(y || 2026, (m || 1) - 1, d || 1).getTime();
                    if (now - t > SEVEN_DAYS) delete days[dateKey];
                }
            }
        }

        if (this.data.messageBuffer) {
            for (const chatId in this.data.messageBuffer) {
                const buf = this.data.messageBuffer[chatId];
                for (const msgId in buf) {
                    if (now - (buf[msgId].timestamp || 0) > FIFTEEN_MIN) delete buf[msgId];
                }
            }
        }

        if (this.data.anonMsgs && this.data.anonMsgs.length > 500) {
            this.data.anonMsgs = this.data.anonMsgs.slice(-500);
        }

        this.flagSave();
    }

    public addXp(chatId: string, num: string, amount: number): number {
        if (!this.data.xp) this.data.xp = {};
        if (!this.data.xp[chatId]) this.data.xp[chatId] = {};
        this.data.xp[chatId][num] = (this.data.xp[chatId][num] || 0) + amount;
        this.flagSave();
        return this.data.xp[chatId][num];
    }

    public getLevel(xp: number): number { return Math.floor(Math.sqrt(xp / 50)) + 1; }

    public getRoleByLevel(level: number): string {
        if (level >= 20) return '👑 Lenda';
        if (level >= 15) return '💎 Diamante';
        if (level >= 10) return '🥇 Ouro';
        if (level >= 5) return '🥈 Prata';
        if (level >= 2) return '🥉 Bronze';
        return '🌱 Iniciante';
    }

    public addCoins(chatId: string, num: string, amount: number): number {
        if (!this.data.coins) this.data.coins = {};
        if (!this.data.coins[chatId]) this.data.coins[chatId] = {};
        this.data.coins[chatId][num] = (this.data.coins[chatId][num] || 0) + amount;
        this.flagSave();
        return this.data.coins[chatId][num];
    }

    public isBotDisabled(chatId: string): boolean {
        if (!chatId) return false;
        return this.data.botDisabled?.[chatId] === true;
    }

    public setBotDisabled(chatId: string, disabled: boolean): void {
        if (!this.data.botDisabled) this.data.botDisabled = {};
        this.data.botDisabled[chatId] = disabled;
        this.flagSave();
    }

    public isMusicDisabled(chatId: string): boolean {
        return this.data.botMusicDisabled?.[chatId] === true;
    }

    public setMusicDisabled(chatId: string, disabled: boolean): void {
        if (!this.data.botMusicDisabled) this.data.botMusicDisabled = {};
        this.data.botMusicDisabled[chatId] = disabled;
        this.flagSave();
    }

    public isGroupClosed(chatId: string): boolean {
        if (!chatId) return false;
        return this.data.closedGroups?.[chatId] === true;
    }

    public setGroupClosed(chatId: string, closed: boolean): void {
        if (!this.data.closedGroups) this.data.closedGroups = {};
        this.data.closedGroups[chatId] = closed;
        this.flagSave();
    }

    public isMuted(chatId: string, num: string): boolean {
        const until = this.data.mutes?.[chatId]?.[num];
        return !!until && until > Date.now();
    }

    public setMute(chatId: string, num: string, ms: number): void {
        if (!this.data.mutes) this.data.mutes = {};
        if (!this.data.mutes[chatId]) this.data.mutes[chatId] = {};
        this.data.mutes[chatId][num] = Date.now() + ms;
        this.flagSave();
    }

    public clearMute(chatId: string, num: string): void {
        if (this.data.mutes?.[chatId]) { delete this.data.mutes[chatId][num]; this.flagSave(); }
    }

    public logAdminAction(chatId: string, adminNum: string, action: string, target?: string): void {
        if (!this.data.adminLog) this.data.adminLog = {};
        if (!this.data.adminLog[chatId]) this.data.adminLog[chatId] = [];
        this.data.adminLog[chatId].push({ ts: Date.now(), admin: adminNum, action, target });
        if (this.data.adminLog[chatId].length > 100) this.data.adminLog[chatId] = this.data.adminLog[chatId].slice(-100);
        this.flagSave();
    }

    public checkDailyQuota(chatId: string, userNum: string): { allowed: boolean; limit: number; used: number } {
        const limit = this.data.dailyQuota?.[chatId] || 0;
        if (!limit) return { allowed: true, limit: 0, used: 0 };
        if (!this.data.dailyQuotaCount) this.data.dailyQuotaCount = {};
        if (!this.data.dailyQuotaCount[chatId]) this.data.dailyQuotaCount[chatId] = {};
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

    public detectRaid(chatId: string): boolean {
        if (!this.data.raidHistory) this.data.raidHistory = {};
        if (!this.data.raidHistory[chatId]) this.data.raidHistory[chatId] = [];
        const now = Date.now();
        this.data.raidHistory[chatId].push(now);
        this.data.raidHistory[chatId] = this.data.raidHistory[chatId].filter(t => now - t < 60000);
        this.flagSave();
        return this.data.raidHistory[chatId].length >= 5;
    }

    public isPromoWindowActive(chatId: string): boolean {
        if (!chatId || !this.data.promoSchedule || !this.data.promoSchedule[chatId]) return false;
        const promo = this.data.promoSchedule[chatId];
        if (!promo.active || !promo.startTime || !promo.endTime) return false;

        const now = new Date();
        const currentHHMM = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false });

        if (promo.startTime <= promo.endTime) {
            return currentHHMM >= promo.startTime && currentHHMM < promo.endTime;
        } else {
            return currentHHMM >= promo.startTime || currentHHMM < promo.endTime;
        }
    }

    public addMessageToCluster(chatId: string, authorNum: string, authorName: string, text: string): void {
        if (!this.data.memoryCluster) this.data.memoryCluster = {};
        if (!this.data.memoryCluster[chatId]) this.data.memoryCluster[chatId] = [];

        const now = Date.now();
        const THIRTY_MINUTES = 30 * 60 * 1000;

        this.data.memoryCluster[chatId].push({
            authorNum,
            authorName,
            text: text.substring(0, 350),
            timestamp: now
        });

        this.data.memoryCluster[chatId] = this.data.memoryCluster[chatId].filter(
            m => (now - m.timestamp) <= THIRTY_MINUTES
        );

        if (!this.data.messageCountSinceLastJarvis) this.data.messageCountSinceLastJarvis = {};
        this.data.messageCountSinceLastJarvis[chatId] = (this.data.messageCountSinceLastJarvis[chatId] || 0) + 1;
        this.flagSave();
    }

    public purgeExpiredClusters(): void {
        if (!this.data.memoryCluster) return;
        const now = Date.now();
        const THIRTY_MINUTES = 30 * 60 * 1000;
        let modified = false;

        for (const chatId in this.data.memoryCluster) {
            const beforeLen = this.data.memoryCluster[chatId].length;
            this.data.memoryCluster[chatId] = this.data.memoryCluster[chatId].filter(
                m => (now - m.timestamp) <= THIRTY_MINUTES
            );
            if (this.data.memoryCluster[chatId].length !== beforeLen) modified = true;
        }
        if (modified) this.flagSave();
    }

    public isFeatureDisabled(chatId: string, featureKey: string): boolean {
        if (!chatId || !featureKey) return false;
        if (!this.data.disabledFeatures || !this.data.disabledFeatures[chatId]) return false;
        return this.data.disabledFeatures[chatId][featureKey] === true;
    }

    public setFeatureStatus(chatId: string, featureKey: string, enabled: boolean): void {
        if (!this.data.disabledFeatures) this.data.disabledFeatures = {};
        if (!this.data.disabledFeatures[chatId]) this.data.disabledFeatures[chatId] = {};
        this.data.disabledFeatures[chatId][featureKey] = !enabled;

        if (featureKey === 'antilink') this.data.antilink[chatId] = enabled;
        if (featureKey === 'antifake') this.data.antifake[chatId] = enabled;
        if (featureKey === 'antiflood') this.data.antiflood[chatId] = enabled;
        if (featureKey === 'antinsfw') this.data.antinsfw[chatId] = enabled;
        if (featureKey === 'audio_transcribe') this.data.autoTranscribe[chatId] = enabled;
        if (featureKey === 'antidelete') this.data.antidelete[chatId] = enabled;
        if (featureKey === 'auto') this.data.autoAnim[chatId] = enabled;
        if (featureKey === 'raidmode') this.data.raidMode[chatId] = enabled;
        if (featureKey === 'captcha') this.data.captcha[chatId] = enabled;
        if (featureKey === 'autoaprovar') this.data.autoApprove[chatId] = enabled;
        if (featureKey === 'lockmedia') this.data.lockMedia[chatId] = enabled;

        this.flagSave();
    }

    public generateAnonId(): string {
        if (!this.data.anonCounter) this.data.anonCounter = 1000;
        this.data.anonCounter++;
        this.flagSave();
        return 'A' + this.data.anonCounter;
    }

    // ADVERTÊNCIAS: 3 advertências = remoção SILENCIOSA (sem aviso público da política)
    public async applyWarning(
        sock: WASocket,
        chatId: string,
        targetJid: string,
        reason: string,
        limitDefault: number = 3
    ): Promise<void> {
        const targetNum = targetJid.split('@')[0].split(':')[0].replace(/\D/g, '');
        const targetInfo = getUserInfo(targetJid);
        const limit = (this.data.maxWarnings && this.data.maxWarnings[chatId]) || limitDefault;

        if (!this.data.warnings[chatId]) this.data.warnings[chatId] = {};
        if (!this.data.warnTimestamps) this.data.warnTimestamps = {};
        if (!this.data.warnTimestamps[chatId]) this.data.warnTimestamps[chatId] = {};
        if (!this.data.warnTimestamps[chatId][targetNum]) this.data.warnTimestamps[chatId][targetNum] = [];
        const SEVEN = 7 * 24 * 60 * 60 * 1000;
        this.data.warnTimestamps[chatId][targetNum] = this.data.warnTimestamps[chatId][targetNum].filter(t => Date.now() - t < SEVEN);
        if (this.data.warnTimestamps[chatId][targetNum].length === 0) this.data.warnings[chatId][targetNum] = 0;
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
            } catch (e: any) {
                console.error('[ERRO AUTO-REMOVE WARN]', e.message);
            }
        }
    }
}
