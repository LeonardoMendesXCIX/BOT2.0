import fs from 'fs';
import path from 'path';
import { WASocket } from '@whiskeysockets/baileys';
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
    antiflood: Record<string, boolean>;
    antinsfw: Record<string, boolean>;
    autoTranscribe: Record<string, boolean>;
    antidelete: Record<string, boolean>;
    messageBuffer: Record<string, Record<string, { text: string; sender: string; pushName: string; timestamp: number }>>;
    bannedWords: Record<string, string[]>;
    groupRules: Record<string, string>;
    warnings: Record<string, Record<string, number>>;
    maxWarnings: Record<string, number>;
    activeQuiz: Record<string, { question: string; answer: string; startedBy?: string; date?: number; timeout?: any }>;
    autoAnim: Record<string, boolean>;
    lastGroupActivity: Record<string, number>;
    autoAnimSent: Record<string, boolean>;
    disabledFeatures: Record<string, Record<string, boolean>>;
    anonMsgs: AnonMessage[];
    anonCounter: number;
    maintenance: boolean;
}

const STORAGE_FILE = path.join(__dirname, '..', '..', 'bot_storage.json');

export class StorageManager {
    public data: BotStorage;
    private pendingSave = false;

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
            antiflood: {},
            antinsfw: {},
            autoTranscribe: {},
            antidelete: {},
            messageBuffer: {},
            bannedWords: {},
            groupRules: {},
            warnings: {},
            maxWarnings: {},
            activeQuiz: {},
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

    private load(): void {
        if (fs.existsSync(STORAGE_FILE)) {
            try {
                const raw = JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf8'));
                this.data = { ...this.data, ...raw };
            } catch (e) {
                console.error('[ERRO STORAGE] Falha ao ler bot_storage.json, iniciando limpo.');
            }
        }
    }

    public flagSave(): void {
        this.pendingSave = true;
    }

    public saveSync(): void {
        try {
            const tmpFile = STORAGE_FILE + '.tmp';
            fs.writeFileSync(tmpFile, JSON.stringify(this.data, null, 2));
            try {
                fs.renameSync(tmpFile, STORAGE_FILE);
                this.pendingSave = false;
            } catch (renameErr: any) {
                setTimeout(() => {
                    try {
                        if (fs.existsSync(tmpFile)) fs.renameSync(tmpFile, STORAGE_FILE);
                        this.pendingSave = false;
                    } catch (e2: any) {
                        console.error('[ERRO STORAGE] Renomeação após retry:', e2.message);
                    }
                }, 500);
            }
        } catch (e: any) {
            console.error('[ERRO STORAGE]', e.message);
        }
    }

    public shutdown(): void {
        try {
            this.saveSync();
            console.log('[STORAGE] Dados salvos no encerramento.');
        } catch (e) { }
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
        console.log('[STORAGE] Poda de dados concluída.');
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

    public isGroupClosed(chatId: string): boolean {
        if (!chatId) return false;
        return this.data.closedGroups?.[chatId] === true;
    }

    public setGroupClosed(chatId: string, closed: boolean): void {
        if (!this.data.closedGroups) this.data.closedGroups = {};
        this.data.closedGroups[chatId] = closed;
        this.flagSave();
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
        this.data.warnings[chatId][targetNum] = (this.data.warnings[chatId][targetNum] || 0) + 1;

        const currentWarns = this.data.warnings[chatId][targetNum];
        this.flagSave();

        // Mensagem pública SEM mencionar a política de remoção
        await sock.sendMessage(chatId, {
            text: '⚠️ *ADVERTÊNCIA REGISTRADA (' + currentWarns + '/' + limit + ')*\n\n' +
                '👤 *Membro:* ' + targetInfo.nameAndNumber + '\n' +
                '📝 *Motivo:* ' + reason,
            mentions: [targetInfo.jid]
        });

        // 3ª advertência: remoção automática silenciosa
        if (currentWarns >= limit) {
            try {
                await sock.groupParticipantsUpdate(chatId, [targetInfo.jid], 'remove');
                delete this.data.warnings[chatId][targetNum];
                this.flagSave();

                const removalCfg = this.data.removalMsgs?.[chatId];
                const removalText = removalCfg && removalCfg.text
                    ? removalCfg.text.replace(/\{membro\}/gi, targetInfo.nameAndNumber)
                    : 'Xiii, acho que o integrante ' + targetInfo.nameAndNumber + ' fez algo de errado, pois foi removido!';

                await sock.sendMessage(chatId, { text: removalText, mentions: [targetInfo.jid] });
                console.log('[WARN AUTO-REMOVE] ' + targetInfo.nameAndNumber + ' removido após ' + currentWarns + ' advertências.');
            } catch (e: any) {
                console.error('[ERRO AUTO-REMOVE WARN]', e.message);
            }
        }
    }
}
