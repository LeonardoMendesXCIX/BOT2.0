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

            // Aguarda 1.5 segundo para o WhatsApp sincronizar os metadados do novo integrante
            await new Promise(r => setTimeout(r, 1500));

            const groupMeta = await sock.groupMetadata(chatId).catch(() => null);
            if (groupMeta?.participants) {
                updateLidMapping(groupMeta.participants);
            }

            // Sincroniza o estado de grupo fechado com o status real do WhatsApp
            if (groupMeta) {
                const isActuallyAnnouncement = groupMeta.announce === true;
                if (isActuallyAnnouncement !== storage.isGroupClosed(chatId)) {
                    storage.setGroupClosed(chatId, isActuallyAnnouncement);
                }
            }

            // =================================================================
            // 1. ENTRADA DE NOVO INTEGRANTE NO GRUPO
            // =================================================================
            if (action === 'add') {
                for (const newMemberId of participants) {
                    let realJid = newMemberId;
                    let memberPushName = '';

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

                    if (!memberPushName) {
                        const contacts = (sock as any).contacts || (sock as any).store?.contacts;
                        if (contacts) {
                            memberPushName = contacts[realJid]?.name || contacts[realJid]?.notify || contacts[newMemberId]?.name || contacts[newMemberId]?.notify || '';
                        }
                    }

                    const rawNum = extractRawNumber(realJid);
                    const memberInfo = getUserInfo(realJid, memberPushName);

                    // Validação de número real brasileiro (+55, 12 ou 13 dígitos)
                    const isRealPhoneNumber = rawNum.length >= 10 && rawNum.length <= 13;
                    const isBrazilianPhone = rawNum.startsWith('55') && (rawNum.length === 12 || rawNum.length === 13);
                    const isLidNumber = rawNum.length > 13; // Identificador interno LID criptográfico

                    // A. Filtro Anti-Fake / DDI +55 (Remove números estrangeiros reais não-+55)
                    const isAntiFakeActive = storage.data.antifake?.[chatId] === true || (!storage.isFeatureDisabled(chatId, 'antifake') && storage.data.antifake?.[chatId] !== false);
                    
                    if (isAntiFakeActive && isRealPhoneNumber && !isBrazilianPhone && !isLidNumber) {
                        try {
                            const botNum = sock.user?.id?.split(':')[0].replace(/\D/g, '') || '';
                            const botParticipant = groupMeta?.participants?.find(p => p.id.split('@')[0].replace(/\D/g, '') === botNum || (p.lid && p.lid.split('@')[0].replace(/\D/g, '') === botNum));
                            const isBotAdmin = botParticipant?.admin === 'admin' || botParticipant?.admin === 'superadmin';

                            if (isBotAdmin) {
                                try {
                                    await sock.groupParticipantsUpdate(chatId, [newMemberId], 'remove');
                                } catch (e) {
                                    await sock.groupParticipantsUpdate(chatId, [realJid], 'remove').catch(() => {});
                                }

                                const displayName = memberInfo.nameAndNumber;
                                const ddiDisplay = `+${rawNum}`;

                                await sock.sendMessage(chatId, {
                                    text: `🛡️ *JARVIS SECURITY (ANTI-FAKE / DDI)* 🛡️\n\n` +
                                          `👤 *Infrator:* ${displayName}\n` +
                                          `📱 *Identificação:* ${ddiDisplay}\n` +
                                          `📝 *Motivo:* Entrada bloqueada por possuir DDI estrangeiro não autorizado (apenas números do Brasil +55 são permitidos).`
                                });
                                console.log(`[ANTI-FAKE] Número estrangeiro ${newMemberId} (+${rawNum}) removido do grupo ${chatId}.`);
                                continue;
                            } else {
                                console.log(`[ANTI-FAKE ALERTA] Número estrangeiro +${rawNum} entrou no grupo ${chatId}, mas o bot precisa ser Administrador para removê-lo.`);
                            }
                        } catch (errKick: any) {
                            console.error('[ERRO KICK ANTI-FAKE]', errKick.message);
                        }
                    }

                    // B. Se o grupo estiver fechado para conversas no momento: guarda na fila para envio na reabertura
                    const isGroupActuallyClosed = groupMeta?.announce === true || storage.isGroupClosed(chatId);
                    if (isGroupActuallyClosed) {
                        if (!storage.data.queuedWelcomes) storage.data.queuedWelcomes = {};
                        if (!storage.data.queuedWelcomes[chatId]) storage.data.queuedWelcomes[chatId] = [];
                        if (!storage.data.queuedWelcomes[chatId].includes(realJid)) {
                            storage.data.queuedWelcomes[chatId].push(realJid);
                            storage.flagSave();
                        }
                        console.log(`[GRUPO FECHADO] Novo membro ${memberInfo.nameAndNumber} guardado na fila para abertura.`);
                        continue;
                    }

                    // C. Disparo Imediato da Saudação Automática (!sa) com formato 'Nome - +55...' no final
                    if (!storage.isFeatureDisabled(chatId, 'sa')) {
                        const welcomeConfig = storage.data.welcomeMsgs ? storage.data.welcomeMsgs[chatId] : null;
                        const defaultWelcome = `Seja muito bem-vindo(a) ao grupo!`;
                        let userText = welcomeConfig && welcomeConfig.text ? welcomeConfig.text.trim() : defaultWelcome;

                        const nameAndNum = memberInfo.nameAndNumber;
                        const groupTitle = groupMeta?.subject || 'nosso grupo';
                        let processedText = userText.replace(/\{grupo\}/gi, groupTitle);

                        if (processedText.includes('{membro}')) {
                            processedText = processedText.replace(/\{membro\}/gi, nameAndNum);
                        }
                        if (processedText.includes('{nome}')) {
                            processedText = processedText.replace(/\{nome\}/gi, memberInfo.pushName || memberInfo.formattedNum);
                        }
                        if (processedText.includes('{numero}')) {
                            processedText = processedText.replace(/\{numero\}/gi, memberInfo.formattedNum);
                        }

                        // Garante que SEMPRE no final da mensagem personalizada puxe: Nome - +55...
                        let finalMsg = '';
                        if (processedText.includes(nameAndNum)) {
                            finalMsg = processedText;
                        } else {
                            finalMsg = `${processedText}\n\n👋 ${nameAndNum}`;
                        }

                        const allMentions = Array.from(new Set([memberInfo.jid, newMemberId, realJid])).filter(Boolean);
                        await sock.sendMessage(chatId, { text: finalMsg, mentions: allMentions });
                        console.log(`[SAUDAÇÃO ENVIADA] Mensagem enviada para ${memberInfo.nameAndNumber} no grupo ${chatId}`);
                    }

                    // D. Agendamento do Lembrete de Boas-Vindas (!bv - 15min)
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
                            console.log(`[LEMBRETE BV AGENDADO] Lembrete programado para daqui a 15min para ${memberInfo.nameAndNumber}`);
                        }
                    }
                }
            }

            // =================================================================
            // 2. SAÍDA OU REMOÇÃO DE MEMBRO DO GRUPO
            // =================================================================
            if (action === 'remove') {
                for (const leftMemberId of participants) {
                    const rawNum = extractRawNumber(leftMemberId);
                    const realJid = `${rawNum}@s.whatsapp.net`;
                    const memberInfo = getUserInfo(realJid);

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
                    const nameAndNum = memberInfo.nameAndNumber;
                    const allMentions = Array.from(new Set([memberInfo.jid, leftMemberId, realJid])).filter(Boolean);

                    if (isRemovedByAdmin) {
                        await sock.sendMessage(chatId, {
                            text: `Xiii, acho que o integrante ${nameAndNum} fez algo de errado, pois foi removido!`,
                            mentions: allMentions
                        });
                    } else if (!storage.isFeatureDisabled(chatId, 'exit') && !storage.isGroupClosed(chatId)) {
                        const exitConfig = storage.data.exitMsgs ? storage.data.exitMsgs[chatId] : null;
                        if (exitConfig && exitConfig.text) {
                            let userText = exitConfig.text.trim();
                            let finalMsg = '';

                            if (userText.includes('{membro}')) {
                                finalMsg = userText.replace(/\{membro\}/gi, nameAndNum);
                            } else if (userText.includes('{nome}')) {
                                finalMsg = userText.replace(/\{nome\}/gi, memberInfo.pushName || memberInfo.formattedNum);
                            } else if (userText.includes('{numero}')) {
                                finalMsg = userText.replace(/\{numero\}/gi, memberInfo.formattedNum);
                            } else {
                                finalMsg = `${userText}\n\n👋 ${nameAndNum}`;
                            }

                            await sock.sendMessage(chatId, { text: finalMsg, mentions: allMentions });
                        }
                    }
                }
            }
        } catch (error: any) {
            console.error('[ERRO EVENTO GRUPO]', error.message);
        }
    });
}
