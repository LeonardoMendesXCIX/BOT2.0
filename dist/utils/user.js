"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.lidMap = void 0;
exports.updateLidMapping = updateLidMapping;
exports.extractRawNumber = extractRawNumber;
exports.getUserInfo = getUserInfo;
const contactCache = {};
exports.lidMap = {};
function updateLidMapping(participants) {
    if (!participants)
        return;
    for (const p of participants) {
        if (p.id && p.lid) {
            const cleanId = p.id.split('@')[0].split(':')[0].replace(/\D/g, '');
            const cleanLid = p.lid.split('@')[0].split(':')[0].replace(/\D/g, '');
            if (cleanId && cleanLid) {
                exports.lidMap[cleanLid] = cleanId;
            }
        }
        if (p.id && (p.name || p.notify || p.verifiedName)) {
            const cleanId = p.id.split('@')[0].split(':')[0].replace(/\D/g, '');
            const name = p.name || p.notify || p.verifiedName;
            if (cleanId && name) {
                contactCache[cleanId] = { name: name.trim(), time: Date.now() };
            }
        }
    }
}
function extractRawNumber(userIdOrMention) {
    if (!userIdOrMention)
        return '';
    const part = userIdOrMention.split('@')[0].split(':')[0];
    let digits = part.replace(/\D/g, '');
    if (exports.lidMap[digits]) {
        digits = exports.lidMap[digits];
    }
    return digits;
}
function getUserInfo(userIdOrMention, pushNameHint = '') {
    if (!userIdOrMention) {
        return {
            jid: '',
            number: 'Desconhecido',
            formattedNum: '@Desconhecido',
            pushName: 'Usuário',
            fullDisplay: '@Desconhecido',
            nameAndNumber: 'Usuário (@Desconhecido)',
            mentionTag: '@Desconhecido'
        };
    }
    const rawNum = extractRawNumber(userIdOrMention);
    const cleanJid = `${rawNum}@s.whatsapp.net`;
    const mentionTag = `@${rawNum}`;
    const formattedNum = `@+${rawNum}`;
    const isCreator = rawNum === '5511927018683' || rawNum === '54259127210155';
    let pushName = '';
    if (isCreator) {
        pushName = 'Leandro';
    }
    else {
        pushName = pushNameHint ? pushNameHint.trim() : '';
        if (!pushName && contactCache[rawNum] && (Date.now() - contactCache[rawNum].time < 86400000)) {
            pushName = contactCache[rawNum].name;
        }
        if (pushName) {
            contactCache[rawNum] = { name: pushName, time: Date.now() };
        }
    }
    const finalName = pushName ? pushName : mentionTag;
    const fullDisplay = pushName && pushName !== mentionTag ? `*${finalName}* (${mentionTag})` : mentionTag;
    const nameAndNumber = pushName && pushName !== mentionTag ? `*${finalName}* (${formattedNum})` : formattedNum;
    return {
        jid: cleanJid,
        number: rawNum,
        formattedNum,
        pushName: finalName,
        fullDisplay,
        nameAndNumber,
        mentionTag
    };
}
