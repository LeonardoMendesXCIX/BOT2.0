import { WASocket } from '@whiskeysockets/baileys';
import { StorageManager } from '../database/storage';
import { getUserInfo, updateLidMapping, extractRawNumber } from '../utils/user';

export function setupGroupEvents(sock: WASocket, storage: StorageManager): void {
    sock.ev.on('group-participants.update', async (event) => {
        try {
            const chatId = event.id;
            const participants = event.participants;
            const action = event.action;
            const author = (event as any).author;

            if (storage.isBotDisabled(chatId)) return;

            const groupMeta = await sock.groupMetadata(chatId).catch(() => null);
            if (groupMeta?.participants) {
                updateLidMapping(groupMeta.participants);
            }

            // 1. ENTRADA DE NOVO MEMBRO
            if (action === 'add') {
                for (const newMemberId of participants) {
                    let realJid = newMemberId;
                    let memberPushName = '';

                    // Busca o participante e seu nome no groupMetadata
                    if (groupMeta?.participants) {
                        const found = groupMeta.participants.find(p => 
                            p.id === newMemberId || 
                            p.lid === newMemberId || 
                            p.id.split('@')[0] === newMemberId.split('@')[0] ||
                            (p.lid && p.lid.split('@')[0] === newMemberId.split('@')[0])
                        );
                        if (found) {
                            if (found.id && found.id.endsWith('@s.whatsapp.net')) {
                                realJid = found.id;
                            }
                            memberPushName = found.name || (found as any).notify || (found as any).verifiedName || '';
                        }
                    }

                    const rawNum = extractRawNumber(realJid);
                    const memberInfo = getUserInfo(realJid, memberPushName);

                    // A. Filtro Anti-Fake / DDI +55 (Requer que o bot seja Administrador do grupo)
                    const isAntiFakeActive = storage.data.antifake?.[chatId] === true || (!storage.isFeatureDisabled(chatId, 'antifake') && storage.data.antifake?.[chatId] !== false);
                    
                    if (isAntiFakeActive && !rawNum.startsWith('55')) {
                        try {
                            const botNum = sock.user?.id?.split(':')[0].replace(/\D/g, '') || '';
                            const botParticipant = groupMeta?.participants?.find(p => p.id.split('@')[0].replace(/\D/g, '') === botNum);
                            const isBotAdmin = botParticipant?.admin === 'admin' || botParticipant?.admin === 'superadmin';

                            if (isBotAdmin) {
                                await sock.groupParticipantsUpdate(chatId, [realJid], 'remove');
                                await sock.sendMessage(chatId, {
                                    text: `🛡️ *JARVIS SECURITY (ANTI-FAKE):*\n\nO número estrangeiro *+${rawNum}* (${memberInfo.pushName}) foi removido automaticamente por não possuir DDI do Brasil (+55).`
                                });
                                console.log(`[ANTI-FAKE] Número estrangeiro +${rawNum} removido do grupo.`);
                                continue;
                            } else {
                                console.log(`[ANTI-FAKE ALERTA] Para remover números estrangeiros, promova o bot a Administrador no grupo.`);
                            }
                        } catch (errKick: any) {
                            console.log('[ANTI-FAKE] Não foi possível remover o participante. Verifique se o bot é Administrador do grupo.');
                        }
                    }

                    // B. Anti-Ghost (Prazo de 10 min para apresentação)
                    const isAntiGhostActive = !storage.isFeatureDisabled(chatId, 'antighost') && storage.data.antighost?.[chatId] !== false;
                    if (isAntiGhostActive) {
                        if (!storage.data.pendingPresentations) storage.data.pendingPresentations = [];
                        const deadlineTime = Date.now() + 10 * 60 * 1000;
                        storage.data.pendingPresentations.push({
                            id: `${Date.now()}_${realJid}`,
                            chatId: chatId,
                            memberId: realJid,
                            memberNum: rawNum,
                            memberName: memberInfo.pushName,
                            deadline: deadlineTime
                        });
                        storage.flagSave();
                    }

                    // C. Saudação Imediata (!sa) - Formatação limpa: Nome primeiro e @número na frente
                    if (!storage.isFeatureDisabled(chatId, 'sa')) {
                        const welcomeConfig = storage.data.welcomeMsgs ? storage.data.welcomeMsgs[chatId] : null;
                        const defaultWelcome = `Seja muito bem-vindo(a) ao grupo!`;
                        let userText = welcomeConfig && welcomeConfig.text ? welcomeConfig.text.trim() : defaultWelcome;

                        let nameAndTag = '';
                        if (memberInfo.pushName && memberInfo.pushName !== memberInfo.mentionTag && !memberInfo.pushName.startsWith('@')) {
                            nameAndTag = `*${memberInfo.pushName}* (${memberInfo.mentionTag})`;
                        } else {
                            nameAndTag = `${memberInfo.mentionTag}`;
                        }

                        let finalMsg = '';
                        const groupTitle = groupMeta?.subject || 'nosso grupo';
                        let processedText = userText.replace(/\{grupo\}/gi, groupTitle);

                        if (processedText.includes('{membro}')) {
                            finalMsg = processedText.replace(/\{membro\}/gi, nameAndTag);
                        } else if (processedText.includes('{nome}')) {
                            finalMsg = processedText.replace(/\{nome\}/gi, memberInfo.pushName);
                        } else if (processedText.includes('{numero}')) {
                            finalMsg = processedText.replace(/\{numero\}/gi, memberInfo.mentionTag);
                        } else {
                            finalMsg = `${processedText}\n\n👋 ${nameAndTag}`;
                        }

                        if (isAntiGhostActive) {
                            finalMsg += `\n\n⏳ *PROTOCOLO DE APRESENTAÇÃO:*\nVocê tem exatamente *10 minutos* para se apresentar e enviar sua 1ª mensagem no chat, caso contrário nosso sistema efetuará a *remoção automática* para manter o grupo ativo.`;
                        }

                        await sock.sendMessage(chatId, { text: finalMsg, mentions: [memberInfo.jid] });
                    }

                    // D. Lembrete de Boas-Vindas (!bv - 15min)
                    if (!storage.isFeatureDisabled(chatId, 'bv')) {
                        const bvConfig = storage.data.welcomeReminders ? storage.data.welcomeReminders[chatId] : null;
                        if (bvConfig && bvConfig.text) {
                            if (!storage.data.pendingBvReminders) storage.data.pendingBvReminders = [];
                            const runAtTime = Date.now() + 15 * 60 * 1000;

                            storage.data.pendingBvReminders.push({
                                id: `${Date.now()}_${realJid}`,
                                chatId: chatId,
                                newMemberId: realJid,
                                runAt: runAtTime
                            });
                            storage.flagSave();
                        }
                    }
                }
            }

            // 2. SAÍDA OU REMOÇÃO DE MEMBRO
            if (action === 'remove') {
                for (const leftMemberId of participants) {
                    const rawNum = extractRawNumber(leftMemberId);
                    const realJid = `${rawNum}@s.whatsapp.net`;
                    const memberInfo = getUserInfo(realJid);

                    if (storage.data.pendingPresentations) {
                        storage.data.pendingPresentations = storage.data.pendingPresentations.filter(p => p.memberId !== realJid && p.memberNum !== rawNum);
                        storage.flagSave();
                    }

                    const isRemovedByAdmin = author && author !== leftMemberId && author !== realJid;

                    let nameAndTag = '';
                    if (memberInfo.pushName && memberInfo.pushName !== memberInfo.mentionTag && !memberInfo.pushName.startsWith('@')) {
                        nameAndTag = `*${memberInfo.pushName}* (${memberInfo.mentionTag})`;
                    } else {
                        nameAndTag = `${memberInfo.mentionTag}`;
                    }

                    if (isRemovedByAdmin) {
                        await sock.sendMessage(chatId, {
                            text: `Xiii, acho que o integrante ${nameAndTag} fez algo de errado, pois foi removido!`,
                            mentions: [memberInfo.jid]
                        });
                    } else if (!storage.isFeatureDisabled(chatId, 'exit')) {
                        const exitConfig = storage.data.exitMsgs ? storage.data.exitMsgs[chatId] : null;
                        if (exitConfig && exitConfig.text) {
                            let userText = exitConfig.text.trim();
                            let finalMsg = '';

                            if (userText.includes('{membro}')) {
                                finalMsg = userText.replace(/\{membro\}/gi, nameAndTag);
                            } else if (userText.includes('{nome}')) {
                                finalMsg = userText.replace(/\{nome\}/gi, memberInfo.pushName);
                            } else if (userText.includes('{numero}')) {
                                finalMsg = userText.replace(/\{numero\}/gi, memberInfo.mentionTag);
                            } else {
                                finalMsg = `${userText}\n\n👋 ${nameAndTag}`;
                            }

                            await sock.sendMessage(chatId, { text: finalMsg, mentions: [memberInfo.jid] });
                        }
                    }
                }
            }
        } catch (error: any) {
            console.error('[ERRO EVENTO GRUPO]', error.message);
        }
    });
}
