import { WASocket } from '@whiskeysockets/baileys';
import { StorageManager } from '../database/storage';
import { getUserInfo, updateLidMapping, extractRawNumber } from '../utils/user';
import { checkMatch } from '../config/rbac';

export function setupGroupEvents(sock: WASocket, storage: StorageManager): void {
    sock.ev.on('group-participants.update', async (event) => {
        try {
            const chatId = event.id;
            const participants = event.participants;
            const action = event.action;
            const author = (event as any).author;

            if (storage.isBotDisabled(chatId)) return;

            await new Promise(r => setTimeout(r, 1500));

            const groupMeta = await sock.groupMetadata(chatId).catch(() => null);
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

                    const isAntiFakeActive = storage.data.antifake?.[chatId] === true || (!storage.isFeatureDisabled(chatId, 'antifake') && storage.data.antifake?.[chatId] !== false);
                    const joinIsPn = (realJid || '').endsWith('@s.whatsapp.net');
                    const pnDigits = joinIsPn ? extractRawNumber(realJid) : '';
                    const isBr = pnDigits.startsWith('55') && (pnDigits.length === 12 || pnDigits.length === 13);
                    const isForeign = joinIsPn && pnDigits !== '' && !isBr;
                    if (isAntiFakeActive && isForeign) {
                        try {
                            const botNumClean = (sock.user?.id || '').split(':')[0].replace(/\D/g, '');
                            const botPart = groupMeta?.participants?.find((p: any) => ((p.id || '').split(':')[0].replace(/\D/g, '') === botNumClean));
                            if (botPart?.admin === 'admin' || botPart?.admin === 'superadmin') {
                                await sock.groupParticipantsUpdate(chatId, [newMemberId], 'remove').catch(() => {});
                                await sock.sendMessage(chatId, { text: '🛡️ *ANTI-FAKE* 🛡️\n\n👤 *Removido:* ' + memberInfo.nameAndNumber + '\n📱 *DDI:* +' + pnDigits + '\n📝 *Motivo:* número estrangeiro (apenas +55).', mentions: [memberInfo.jid] });
                                continue;
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

                    if (!storage.isFeatureDisabled(chatId, 'sa')) {
                        const savedWelcomeText = storage.data.welcomeMsgs?.[chatId]?.text?.trim();
                        const defaultWelcome = 'Seja muito bem-vindo(a) ao grupo!';
                        let userText = savedWelcomeText || defaultWelcome;

                        const numeroReal = extractRawNumber(realJid);
                        const memberMentionJid = numeroReal + '@s.whatsapp.net';
                        const memberName = memberInfo.pushName || memberInfo.formattedNum;
                        const groupTitle = groupMeta?.subject || 'nosso grupo';
                        let processedText = userText.replace(/\{grupo\}/gi, groupTitle);

                        const hasMemberVariable = /\{membro\}/i.test(processedText);
                        processedText = processedText
                            .replace(/\{membro\}/gi, '@' + numeroReal)
                            .replace(/\{nome\}/gi, memberName)
                            .replace(/\{numero\}/gi, memberInfo.formattedNum);

                        const finalMsg = hasMemberVariable
                            ? processedText
                            : processedText + '\n\n👋 @' + numeroReal;
                        const allMentions = Array.from(new Set([memberMentionJid, memberInfo.jid, newMemberId, realJid])).filter(Boolean);
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
                        if (!_resolved || _resolved.length > 13) {
                            const _botNum = (sock.user?.id || '').split(':')[0].replace(/\D/g, '');
                            const _botPart = groupMeta?.participants?.find((pp: any) => ((pp.id || '').split(':')[0].replace(/\D/g, '') === _botNum));
                            if (_botPart?.admin === 'admin' || _botPart?.admin === 'superadmin') {
                                try {
                                    await sock.groupParticipantsUpdate(chatId, [newMemberId], 'remove').catch(() => {});
                                    const _remMsg = storage.data.removalMsgs?.[chatId]?.text;
                                    const _info = getUserInfo(newMemberId);
                                    await sock.sendMessage(chatId, {
                                        text: (_remMsg || '🛡️ *ANTI-FAKE (LID ESTRANGEIRO)*\n\n👤 Removido: ' + _info.nameAndNumber + '\n📝 Motivo: identificador oculto.')
                                            .replace(/\{membro\}/gi, _info.nameAndNumber),
                                        mentions: [_info.jid]
                                    });
                                } catch (e) { }
                                continue;
                            }
                        }
                    }
                }
            }

            if (action === 'remove') {
                for (const leftMemberId of participants) {
                    const rawNum = extractRawNumber(leftMemberId);
                    const realJid = rawNum + '@s.whatsapp.net';
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
                    const nameAndNum = memberInfo.mention;
                    const allMentions = Array.from(new Set([memberInfo.jid, leftMemberId, realJid])).filter(Boolean);

                    if (isRemovedByAdmin) {
                        // Mensagem de remoção PERSONALIZÁVEL via !msgremoveadm (padrão: Nome - Número)
                        const removalCfg = storage.data.removalMsgs?.[chatId];
                        const removalText = removalCfg && removalCfg.text
                            ? removalCfg.text.replace(/\{membro\}/gi, memberInfo.mention)
                            : 'Xiii, acho que o integrante ' + memberInfo.nameAndNumber + ' fez algo de errado, pois foi removido!';

                        await sock.sendMessage(chatId, { text: removalText, mentions: allMentions.includes(memberInfo.jid) ? allMentions : [...allMentions, memberInfo.jid] });
                    } else if (!storage.isFeatureDisabled(chatId, 'exit') && !storage.isGroupClosed(chatId)) {
                        const exitConfig = storage.data.exitMsgs ? storage.data.exitMsgs[chatId] : null;
                        if (exitConfig && exitConfig.text) {
                            let userText = exitConfig.text.trim();
                            let finalMsg = '';

                            if (userText.includes('{membro}')) {
                                finalMsg = userText.replace(/\{membro\}/gi, memberInfo.mention);
                            } else if (userText.includes('{nome}')) {
                                finalMsg = userText.replace(/\{nome\}/gi, memberInfo.pushName || memberInfo.formattedNum);
                            } else if (userText.includes('{numero}')) {
                                finalMsg = userText.replace(/\{numero\}/gi, memberInfo.formattedNum);
                            } else {
                                finalMsg = userText + '\n\n👋 ' + memberInfo.mention;
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
