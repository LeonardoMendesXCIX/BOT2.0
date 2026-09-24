import { WASocket } from '@whiskeysockets/baileys';
import { StorageManager } from '../database/storage';
import { getUserInfo, updateLidMapping, extractRawNumber, detectBrazilianNumber } from '../utils/user';
import { checkMatch } from '../config/rbac';
import { sendToN8N } from '../utils/n8n';

const BOT_START_TIME = Date.now();
const EVENT_GRACE_PERIOD_MS = 90000; // 90s: ignora eventos antigos na reconexao
const MAX_WELCOMES_PER_MINUTE = 5; // limite de boas-vindas por minuto

let welcomeCountWindow: number[] = [];

function isFloodWelcome(): boolean {
    const now = Date.now();
    welcomeCountWindow = welcomeCountWindow.filter(t => now - t < 60000);
    if (welcomeCountWindow.length >= MAX_WELCOMES_PER_MINUTE) return true;
    welcomeCountWindow.push(now);
    return false;
}

export function setupGroupEvents(sock: WASocket, storage: StorageManager): void {
    sock.ev.on('group-participants.update', async (event) => {
        try {
            const chatId = event.id;
            const participants = event.participants;
            const action = event.action;
            const author = (event as any).author;

            if (storage.isBotDisabled(chatId)) return;

            await new Promise(r => setTimeout(r, 800));

            let groupMeta = await sock.groupMetadata(chatId).catch(() => null);
            if (!groupMeta) {
                await new Promise(r => setTimeout(r, 1000));
                groupMeta = await sock.groupMetadata(chatId).catch(() => null);
            }
            if (groupMeta?.participants) {
                updateLidMapping(groupMeta.participants);
            }

            if (groupMeta) {
                const isActuallyAnnouncement = groupMeta.announce === true;
                if (isActuallyAnnouncement !== storage.isGroupClosed(chatId)) {
                    storage.setGroupClosed(chatId, isActuallyAnnouncement);
                }
            }

            if (action === 'add') {
                // Ignora eventos que chegaram logo apos o boot (backlog do WhatsApp)
                if (Date.now() - BOT_START_TIME < EVENT_GRACE_PERIOD_MS) {
                    console.log('[EVENTS] Ignorando evento add (dentro do grace period pos-reboot)');
                    return;
                }

                // Ignora se estourou o limite de boas-vindas por minuto (anti-flood)
                if (isFloodWelcome()) {
                    console.log('[EVENTS] Flood de boas-vindas detectado, ignorando novos membros');
                    return;
                }

                for (const newMemberId of participants) {
                    let realJid = newMemberId;
                    let memberPushName = '';

                    if (groupMeta?.participants) {
                        const found = groupMeta.participants.find(p =>
                            p.id === newMemberId ||
                            (p as any).lid === newMemberId ||
                            p.id.split('@')[0] === newMemberId.split('@')[0] ||
                            ((p as any).lid && (p as any).lid.split('@')[0] === newMemberId.split('@')[0])
                        );
                        if (found) {
                            if (found.id && found.id.endsWith('@s.whatsapp.net')) {
                                realJid = found.id;
                            }
                            memberPushName = found.name || (found as any).notify || (found as any).verifiedName || '';
                        }
                    }

                    if (!memberPushName) {
                        const contacts = (sock as any).contacts || (sock as any).store?.contacts;
                        if (contacts) {
                            memberPushName = contacts[realJid]?.name || contacts[realJid]?.notify || contacts[newMemberId]?.name || contacts[newMemberId]?.notify || '';
                        }
                    }

                    const memberInfo = getUserInfo(realJid, memberPushName);
                    const rawNum = extractRawNumber(realJid);

                    void sendToN8N({
                        action: 'group_member_added',
                        chatId,
                        memberId: realJid,
                        memberName: memberInfo.pushName,
                        memberNumber: rawNum,
                        groupName: groupMeta?.subject || '',
                    });

                    const isAntiFakeActive = storage.data.antifake?.[chatId] === true || (!storage.isFeatureDisabled(chatId, 'antifake') && storage.data.antifake?.[chatId] !== false);
                    const joinIsPn = (realJid || '').endsWith('@s.whatsapp.net');
                    const pnDigits = joinIsPn ? extractRawNumber(realJid) : '';
                    
                    // CORREÇÃO 3: Uso da função robusta detectBrazilianNumber
                    const isBr = detectBrazilianNumber(pnDigits);
                    const isForeign = joinIsPn && pnDigits !== '' && !isBr;

                    if (isAntiFakeActive && isForeign) {
                        try {
                            const botNumClean = (sock.user?.id || '').split(':')[0].replace(/\D/g, '');
                            const botPart = groupMeta?.participants?.find((p: any) => ((p.id || '').split(':')[0].replace(/\D/g, '') === botNumClean));
                            if (botPart?.admin === 'admin' || botPart?.admin === 'superadmin') {
                                let removed = false;
                                try {
                                    await sock.groupParticipantsUpdate(chatId, [newMemberId], 'remove');
                                    removed = true;
                                } catch (e) { }
                                if (removed) {
                                    await sock.sendMessage(chatId, { text: '🛡️ *ANTI-FAKE* 🛡️\n\n👤 *Removido:* ' + memberInfo.smartMention + '\n📱 *DDI:* +' + pnDigits.substring(0, 2) + '\n📝 *Motivo:* número estrangeiro (apenas +55).', mentions: [memberInfo.mentionJid, memberInfo.jid, newMemberId, realJid].filter(Boolean) });
                                    continue;
                                }
                            }
                        } catch (e) { }
                    }

                    const isGroupActuallyClosed = groupMeta?.announce === true || storage.isGroupClosed(chatId);
                    if (isGroupActuallyClosed) {
                        if (!storage.data.queuedWelcomes) storage.data.queuedWelcomes = {};
                        if (!storage.data.queuedWelcomes[chatId]) storage.data.queuedWelcomes[chatId] = [];
                        if (!storage.data.queuedWelcomes[chatId].includes(realJid)) {
                            storage.data.queuedWelcomes[chatId].push(realJid);
                            storage.flagSave();
                        }
                        continue;
                    }

                    const bday = storage.data.birthdays?.[chatId]?.[rawNum];
                    if (bday) {
                        const today = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
                        if (bday === today) {
                            await sock.sendMessage(chatId, {
                                text: '🎂🎉 *FELIZ ANIVERSÁRIO!* 🎉\n\nHoje é o dia de ' + memberInfo.smartMention + '! Parabéns! 🥳🎈',
                                mentions: [memberInfo.mentionJid, memberInfo.jid]
                            });
                        }
                    }

                    if (!storage.isFeatureDisabled(chatId, 'sa')) {
                        const savedWelcomeText = storage.data.welcomeMsgs?.[chatId]?.text?.trim();
                        const defaultWelcome = 'Seja muito bem-vindo(a) ao grupo!';
                        let userText = savedWelcomeText || defaultWelcome;

                        const memberName = memberInfo.pushName || memberInfo.formattedNum;
                        const groupTitle = groupMeta?.subject || 'nosso grupo';
                        let processedText = userText.replace(/\{grupo\}/gi, groupTitle);

                        const hasMemberVariable = /\{membro\}/i.test(processedText);
                        processedText = processedText
                            .replace(/\{membro\}/gi, memberInfo.smartMention)
                            .replace(/\{nome\}/gi, memberName)
                            .replace(/\{numero\}/gi, memberInfo.formattedNum);

                        const finalMsg = hasMemberVariable
                            ? processedText
                            : processedText + '\n\n👋 ' + memberInfo.smartMention;
                        const allMentions = Array.from(new Set([memberInfo.mentionJid, memberInfo.jid, newMemberId, realJid])).filter(Boolean);
                        await sock.sendMessage(chatId, { text: finalMsg, mentions: allMentions });
                    }

                    // LEMBRETE BV: agora 5 MINUTOS após a entrada
                    if (!storage.isFeatureDisabled(chatId, 'bv')) {
                        const bvConfig = storage.data.welcomeReminders ? storage.data.welcomeReminders[chatId] : null;
                        if (bvConfig && bvConfig.text) {
                            if (!storage.data.pendingBvReminders) storage.data.pendingBvReminders = [];
                            const runAtTime = Date.now() + 5 * 60 * 1000;

                            storage.data.pendingBvReminders.push({
                                id: Date.now() + '_' + realJid,
                                chatId: chatId,
                                newMemberId: realJid,
                                runAt: runAtTime
                            });
                            storage.flagSave();
                        }
                    }

                    // BLOQUEIO ESTRITO DE LID: se o novo membro entrou como LID sem número
                    // real resolvido e antifake estrito está ativo, remove.
                    const _strictLidOn = storage.data.antifakeStrictLid?.[chatId] !== false;
                    const _antiFakeOn = storage.data.antifake?.[chatId] === true || (!storage.isFeatureDisabled(chatId, 'antifake') && storage.data.antifake?.[chatId] !== false);
                    if (_antiFakeOn && _strictLidOn && (newMemberId || '').endsWith('@lid')) {
                        const _resolved = extractRawNumber(realJid);
                        // CORREÇÃO 3: Uso da função robusta para checar se o número resolvido é brasileiro
                        const _isBr = detectBrazilianNumber(_resolved);
                        if (!_resolved || (!_isBr && _resolved.length > 13)) {
                            const _botNum = (sock.user?.id || '').split(':')[0].replace(/\D/g, '');
                            const _botPart = groupMeta?.participants?.find((pp: any) => ((pp.id || '').split(':')[0].replace(/\D/g, '') === _botNum));
                            if (_botPart?.admin === 'admin' || _botPart?.admin === 'superadmin') {
                                let removed = false;
                                try {
                                    await sock.groupParticipantsUpdate(chatId, [newMemberId], 'remove');
                                    removed = true;
                                    const _remMsg = storage.data.removalMsgs?.[chatId]?.text;
                                    const _info = getUserInfo(newMemberId);
                                    await sock.sendMessage(chatId, {
                                        text: (_remMsg || '🛡️ *ANTI-FAKE (LID ESTRANGEIRO)*\n\n👤 Removido: ' + _info.smartMention + '\n📝 Motivo: identificador oculto.')
                                            .replace(/\{membro\}/gi, _info.smartMention),
                                        mentions: Array.from(new Set([_info.mentionJid, _info.jid, newMemberId, realJid])).filter(Boolean)
                                    });
                                } catch (e) { }
                                if (removed) continue;
                            }
                        }

                        const rawNum = extractRawNumber(realJid);
                        if (storage.data.raidMode?.[chatId] !== false) {
                            const isRaid = storage.detectRaid(chatId);
                            if (isRaid && !storage.isGroupClosed(chatId)) {
                                try {
                                    await sock.groupSettingUpdate(chatId, 'announcement');
                                    storage.setGroupClosed(chatId, true);
                                    await sock.sendMessage(chatId, { text: '🚨 *RAID DETECTADO!* 🚨\n\n5+ entradas em 60 segundos. Grupo trancado automaticamente.\nUse `!abrir` para reabrir manualmente.' });
                                    storage.logAdminAction(chatId, 'BOT', 'RAID-MODE: grupo trancado');
                                } catch (e) { }
                            }
                        }

                        if (storage.data.captcha?.[chatId] === true) {
                            const code = String(Math.floor(1000 + Math.random() * 9000));
                            if (!storage.data.pendingCaptcha) storage.data.pendingCaptcha = {};
                            if (!storage.data.pendingCaptcha[chatId]) storage.data.pendingCaptcha[chatId] = {};
                            storage.data.pendingCaptcha[chatId][rawNum] = { code, expires: Date.now() + 120000 };
                            storage.flagSave();
                            await sock.sendMessage(chatId, {
                                text: '🔐 *VERIFICAÇÃO DE SEGURANÇA*\n\n' + memberInfo.smartMention + ', digite o código abaixo em até 2 minutos para permanecer no grupo:\n\n🔑 *' + code + '*',
                                mentions: [memberInfo.mentionJid, memberInfo.jid]
                            });
                        }

                        storage.logAdminAction(chatId, rawNum, 'ENTROU no grupo');
                    }
                }
            }

            if (action === 'remove') {
                for (const leftMemberId of participants) {
                    const rawNum = extractRawNumber(leftMemberId);
                    const realJid = leftMemberId.includes('@') ? leftMemberId : rawNum + '@s.whatsapp.net';
                    const memberInfo = getUserInfo(leftMemberId);

                    if (storage.data.queuedWelcomes?.[chatId]) {
                        storage.data.queuedWelcomes[chatId] = storage.data.queuedWelcomes[chatId].filter(id => id !== realJid && id !== leftMemberId);
                        storage.flagSave();
                    }

                    if (storage.data.pendingBvReminders) {
                        storage.data.pendingBvReminders = storage.data.pendingBvReminders.filter(
                            r => !(r.chatId === chatId && (r.newMemberId === realJid || r.newMemberId === leftMemberId || checkMatch(r.newMemberId.split('@')[0], rawNum)))
                        );
                        storage.flagSave();
                    }

                    const isRemovedByAdmin = author && author !== leftMemberId && author !== realJid;
                    const allMentions = Array.from(new Set([memberInfo.mentionJid, memberInfo.jid, leftMemberId, realJid])).filter(Boolean);
                    storage.logAdminAction(chatId, extractRawNumber(leftMemberId), isRemovedByAdmin ? 'REMOVIDO por admin' : 'SAIU do grupo');

                    if (isRemovedByAdmin) {
                        // Mensagem de remoção PERSONALIZÁVEL via !msgremoveadm (padrão: Nome - Número)
                        const removalCfg = storage.data.removalMsgs?.[chatId];
                        const removalText = removalCfg && removalCfg.text
                            ? removalCfg.text.replace(/\{membro\}/gi, memberInfo.mention)
                            : 'Xiii, acho que o integrante ' + memberInfo.mention + ' fez algo de errado, pois foi removido!';

                        await sock.sendMessage(chatId, { text: removalText, mentions: [memberInfo.mentionJid] });
                    } else if (!storage.isFeatureDisabled(chatId, 'exit') && !storage.isGroupClosed(chatId)) {
                        const exitConfig = storage.data.exitMsgs ? storage.data.exitMsgs[chatId] : null;
                        if (exitConfig && exitConfig.text) {
                            let userText = exitConfig.text.trim();
                            let finalMsg = '';

                            if (userText.includes('{membro}')) {
                                finalMsg = userText.replace(/\{membro\}/gi, memberInfo.smartMention);
                            } else if (userText.includes('{nome}')) {
                                finalMsg = userText.replace(/\{nome\}/gi, memberInfo.pushName || memberInfo.formattedNum);
                            } else if (userText.includes('{numero}')) {
                                finalMsg = userText.replace(/\{numero\}/gi, memberInfo.formattedNum);
                            } else {
                                finalMsg = userText + '\n\n👋 ' + memberInfo.smartMention;
                            }

                            await sock.sendMessage(chatId, { text: finalMsg, mentions: allMentions.includes(memberInfo.jid) ? allMentions : [...allMentions, memberInfo.jid] });
                        }
                    }
                }
            }
        } catch (error: any) {
            console.error('[ERRO EVENTO GRUPO]', error.message);
        }
    });
}