"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupGroupEvents = setupGroupEvents;
const user_1 = require("../utils/user");
const rbac_1 = require("../config/rbac");
const n8n_1 = require("../utils/n8n");
function setupGroupEvents(sock, storage) {
    sock.ev.on('group-participants.update', async (event) => {
        try {
            const chatId = event.id;
            const participants = event.participants;
            const action = event.action;
            const author = event.author;
            if (storage.isBotDisabled(chatId))
                return;
            await new Promise(r => setTimeout(r, 800));
            let groupMeta = await sock.groupMetadata(chatId).catch(() => null);
            if (!groupMeta) {
                await new Promise(r => setTimeout(r, 1000));
                groupMeta = await sock.groupMetadata(chatId).catch(() => null);
            }
            if (groupMeta?.participants) {
                (0, user_1.updateLidMapping)(groupMeta.participants);
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
                        const found = groupMeta.participants.find(p => p.id === newMemberId ||
                            p.lid === newMemberId ||
                            p.id.split('@')[0] === newMemberId.split('@')[0] ||
                            (p.lid && p.lid.split('@')[0] === newMemberId.split('@')[0]));
                        if (found) {
                            if (found.id && found.id.endsWith('@s.whatsapp.net')) {
                                realJid = found.id;
                            }
                            memberPushName = found.name || found.notify || found.verifiedName || '';
                        }
                    }
                    if (!memberPushName) {
                        const contacts = sock.contacts || sock.store?.contacts;
                        if (contacts) {
                            memberPushName = contacts[realJid]?.name || contacts[realJid]?.notify || contacts[newMemberId]?.name || contacts[newMemberId]?.notify || '';
                        }
                    }
                    const memberInfo = (0, user_1.getUserInfo)(realJid, memberPushName);
                    const rawNum = (0, user_1.extractRawNumber)(realJid);
                    void (0, n8n_1.sendToN8N)({
                        action: 'group_member_added',
                        chatId,
                        memberId: realJid,
                        memberName: memberInfo.pushName,
                        memberNumber: rawNum,
                        groupName: groupMeta?.subject || '',
                    });
                    const isAntiFakeActive = storage.data.antifake?.[chatId] === true || (!storage.isFeatureDisabled(chatId, 'antifake') && storage.data.antifake?.[chatId] !== false);
                    const joinIsPn = (realJid || '').endsWith('@s.whatsapp.net');
                    const pnDigits = joinIsPn ? (0, user_1.extractRawNumber)(realJid) : '';
                    // CORREÇÃO 3: Uso da função robusta detectBrazilianNumber
                    const isBr = (0, user_1.detectBrazilianNumber)(pnDigits);
                    const isForeign = joinIsPn && pnDigits !== '' && !isBr;
                    if (isAntiFakeActive && isForeign) {
                        try {
                            const botNumClean = (sock.user?.id || '').split(':')[0].replace(/\D/g, '');
                            const botPart = groupMeta?.participants?.find((p) => ((p.id || '').split(':')[0].replace(/\D/g, '') === botNumClean));
                            if (botPart?.admin === 'admin' || botPart?.admin === 'superadmin') {
                                let removed = false;
                                try {
                                    await sock.groupParticipantsUpdate(chatId, [newMemberId], 'remove');
                                    removed = true;
                                }
                                catch (e) { }
                                if (removed) {
                                    await sock.sendMessage(chatId, { text: '🛡️ *ANTI-FAKE* 🛡️\n\n👤 *Removido:* ' + memberInfo.smartMention + '\n📱 *DDI:* +' + pnDigits.substring(0, 2) + '\n📝 *Motivo:* número estrangeiro (apenas +55).', mentions: [memberInfo.mentionJid, memberInfo.jid, newMemberId, realJid].filter(Boolean) });
                                    continue;
                                }
                            }
                        }
                        catch (e) { }
                    }
                    const isGroupActuallyClosed = groupMeta?.announce === true || storage.isGroupClosed(chatId);
                    if (isGroupActuallyClosed) {
                        if (!storage.data.queuedWelcomes)
                            storage.data.queuedWelcomes = {};
                        if (!storage.data.queuedWelcomes[chatId])
                            storage.data.queuedWelcomes[chatId] = [];
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
                            if (!storage.data.pendingBvReminders)
                                storage.data.pendingBvReminders = [];
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
                        const _resolved = (0, user_1.extractRawNumber)(realJid);
                        // CORREÇÃO 3: Uso da função robusta para checar se o número resolvido é brasileiro
                        const _isBr = (0, user_1.detectBrazilianNumber)(_resolved);
                        if (!_resolved || (!_isBr && _resolved.length > 13)) {
                            const _botNum = (sock.user?.id || '').split(':')[0].replace(/\D/g, '');
                            const _botPart = groupMeta?.participants?.find((pp) => ((pp.id || '').split(':')[0].replace(/\D/g, '') === _botNum));
                            if (_botPart?.admin === 'admin' || _botPart?.admin === 'superadmin') {
                                let removed = false;
                                try {
                                    await sock.groupParticipantsUpdate(chatId, [newMemberId], 'remove');
                                    removed = true;
                                    const _remMsg = storage.data.removalMsgs?.[chatId]?.text;
                                    const _info = (0, user_1.getUserInfo)(newMemberId);
                                    await sock.sendMessage(chatId, {
                                        text: (_remMsg || '🛡️ *ANTI-FAKE (LID ESTRANGEIRO)*\n\n👤 Removido: ' + _info.smartMention + '\n📝 Motivo: identificador oculto.')
                                            .replace(/\{membro\}/gi, _info.smartMention),
                                        mentions: Array.from(new Set([_info.mentionJid, _info.jid, newMemberId, realJid])).filter(Boolean)
                                    });
                                }
                                catch (e) { }
                                if (removed)
                                    continue;
                            }
                        }
                        const rawNum = (0, user_1.extractRawNumber)(realJid);
                        if (storage.data.raidMode?.[chatId] !== false) {
                            const isRaid = storage.detectRaid(chatId);
                            if (isRaid && !storage.isGroupClosed(chatId)) {
                                try {
                                    await sock.groupSettingUpdate(chatId, 'announcement');
                                    storage.setGroupClosed(chatId, true);
                                    await sock.sendMessage(chatId, { text: '🚨 *RAID DETECTADO!* 🚨\n\n5+ entradas em 60 segundos. Grupo trancado automaticamente.\nUse `!abrir` para reabrir manualmente.' });
                                    storage.logAdminAction(chatId, 'BOT', 'RAID-MODE: grupo trancado');
                                }
                                catch (e) { }
                            }
                        }
                        if (storage.data.captcha?.[chatId] === true) {
                            const code = String(Math.floor(1000 + Math.random() * 9000));
                            if (!storage.data.pendingCaptcha)
                                storage.data.pendingCaptcha = {};
                            if (!storage.data.pendingCaptcha[chatId])
                                storage.data.pendingCaptcha[chatId] = {};
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
                    const rawNum = (0, user_1.extractRawNumber)(leftMemberId);
                    const realJid = leftMemberId.includes('@') ? leftMemberId : rawNum + '@s.whatsapp.net';
                    const memberInfo = (0, user_1.getUserInfo)(leftMemberId);
                    if (storage.data.queuedWelcomes?.[chatId]) {
                        storage.data.queuedWelcomes[chatId] = storage.data.queuedWelcomes[chatId].filter(id => id !== realJid && id !== leftMemberId);
                        storage.flagSave();
                    }
                    if (storage.data.pendingBvReminders) {
                        storage.data.pendingBvReminders = storage.data.pendingBvReminders.filter(r => !(r.chatId === chatId && (r.newMemberId === realJid || r.newMemberId === leftMemberId || (0, rbac_1.checkMatch)(r.newMemberId.split('@')[0], rawNum))));
                        storage.flagSave();
                    }
                    const isRemovedByAdmin = author && author !== leftMemberId && author !== realJid;
                    const allMentions = Array.from(new Set([memberInfo.mentionJid, memberInfo.jid, leftMemberId, realJid])).filter(Boolean);
                    storage.logAdminAction(chatId, (0, user_1.extractRawNumber)(leftMemberId), isRemovedByAdmin ? 'REMOVIDO por admin' : 'SAIU do grupo');
                    if (isRemovedByAdmin) {
                        // Mensagem de remoção PERSONALIZÁVEL via !msgremoveadm (padrão: Nome - Número)
                        const removalCfg = storage.data.removalMsgs?.[chatId];
                        const removalText = removalCfg && removalCfg.text
                            ? removalCfg.text.replace(/\{membro\}/gi, memberInfo.mention)
                            : 'Xiii, acho que o integrante ' + memberInfo.mention + ' fez algo de errado, pois foi removido!';
                        await sock.sendMessage(chatId, { text: removalText, mentions: [memberInfo.mentionJid] });
                    }
                    else if (!storage.isFeatureDisabled(chatId, 'exit') && !storage.isGroupClosed(chatId)) {
                        const exitConfig = storage.data.exitMsgs ? storage.data.exitMsgs[chatId] : null;
                        if (exitConfig && exitConfig.text) {
                            let userText = exitConfig.text.trim();
                            let finalMsg = '';
                            if (userText.includes('{membro}')) {
                                finalMsg = userText.replace(/\{membro\}/gi, memberInfo.smartMention);
                            }
                            else if (userText.includes('{nome}')) {
                                finalMsg = userText.replace(/\{nome\}/gi, memberInfo.pushName || memberInfo.formattedNum);
                            }
                            else if (userText.includes('{numero}')) {
                                finalMsg = userText.replace(/\{numero\}/gi, memberInfo.formattedNum);
                            }
                            else {
                                finalMsg = userText + '\n\n👋 ' + memberInfo.smartMention;
                            }
                            await sock.sendMessage(chatId, { text: finalMsg, mentions: allMentions.includes(memberInfo.jid) ? allMentions : [...allMentions, memberInfo.jid] });
                        }
                    }
                }
            }
        }
        catch (error) {
            console.error('[ERRO EVENTO GRUPO]', error.message);
        }
    });
}
