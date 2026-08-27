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
    pendingPresentations: Array<{ id: string; chatId: string; memberId: string; memberNum: string; memberName: string; deadline: number }>;
    groupSchedules: Record<string, { openTime?: string; closeTime?: string }>;
    exitMsgs: Record<string, { text: string; setBy?: string; date?: string }>;
    // NOVO: mensagens personalizadas de remoção por admin (!msgradm)
    removalMsgs: Record<string, { text: string; setBy?: string; date?: string }>;
    inativosMsgs: Record<string, { text: string; setBy?: string; date?: string }>;
    antilink: Record<string, boolean>;
    antifake: Record<string, boolean>;
    antiflood: Record<string, boolean>;
    antighost: Record<string, boolean>;
    antinsfw: Record<string, boolean>;
    autoTranscribe: Record<string, boolean>;
    antidelete: Record<string, boolean>;
    messageBuffer: Record<string, Record<string, { text: string; sender: string; pushName: string; timestamp: number }>>;
    jarvisMode: Record<string, boolean>;
    bannedWords: Record<string, string[]>;
    groupRules: Record<string, string>;
    warnings: Record<string, Record<string, number>>;
    maxWarnings: Record<string, number>;
    activeQuiz: Record<string, { question: string; answer: string; startedBy?: string; date?: number; timeout?: any }>;
    autoAnim: Record<string, boolean>;
    lastGroupActivity: Record<string, number>;
    autoAnimSent: Record<string, boolean>;
    disabledFeatures: Record<string, Record<string, boolean>>;
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
            pendingPresentations: [],
            groupSchedules: {},
            exitMsgs: {},
            removalMsgs: {},
            inativosMsgs: {},
            antilink: {},
            antifake: {},
            antiflood: {},
            antighost: {},
            antinsfw: {},
            autoTranscribe: {},
            antidelete: {},
            messageBuffer: {},
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
            const tmpFile = `${STORAGE_FILE}.tmp`;
            fs.writeFile(tmpFile, JSON.stringify(this.data, null, 2), (err) => {
                if (err) {
                    console.error('[ERRO STORAGE] Gravação temporária:', err.message);
                    return;
                }
                fs.rename(tmpFile, STORAGE_FILE, (renameErr) => {
                    if (renameErr) console.error('[ERRO STORAGE] Renomeação atômica:', renameErr.message);
                });
            });
        } catch (e: any) {
            console.error('[ERRO STORAGE]', e.message);
        }
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
        if (featureKey === 'antighost') this.data.antighost[chatId] = enabled;
        if (featureKey === 'antinsfw') this.data.antinsfw[chatId] = enabled;
        if (featureKey === 'audio_transcribe') this.data.autoTranscribe[chatId] = enabled;
        if (featureKey === 'antidelete') this.data.antidelete[chatId] = enabled;
        if (featureKey === 'jarvis') this.data.jarvisMode[chatId] = enabled;
        if (featureKey === 'auto') this.data.autoAnim[chatId] = enabled;

        this.flagSave();
    }

    // CORREÇÃO: Advertências SEM auto-ban - a remoção é decisão exclusiva dos administradores
    public async applyWarning(
        sock: WASocket,
        chatId: string,
        targetJid: string,
        reason: string,
        limitDefault: number = 2
    ): Promise<void> {
        const targetNum = targetJid.split('@')[0].split(':')[0].replace(/\D/g, '');
        const targetInfo = getUserInfo(targetJid);
        const limit = (this.data.maxWarnings && this.data.maxWarnings[chatId]) || limitDefault;

        if (!this.data.warnings[chatId]) this.data.warnings[chatId] = {};
        this.data.warnings[chatId][targetNum] = (this.data.warnings[chatId][targetNum] || 0) + 1;

        const currentWarns = this.data.warnings[chatId][targetNum];
        this.flagSave();

        await sock.sendMessage(chatId, {
            text: `⚠️ *ADVERTÊNCIA REGISTRADA (${currentWarns}/${limit})*\n\n` +
                `👤 *Membro:* ${targetInfo.mentionTag} (*${targetInfo.pushName}*)\n` +
                `📱 *Número:* ${targetInfo.formattedNum}\n` +
                `📝 *Motivo:* ${reason}\n\n` +
                `_Advertência registrada no sistema. A decisão de remover um integrante é exclusiva dos administradores do grupo._`,
            mentions: [targetInfo.jid]
        });
    }
}