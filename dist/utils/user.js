"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.profilesDB = exports.lidMap = exports.contactCache = void 0;
exports.setContactsLookup = setContactsLookup;
exports.rememberProfile = rememberProfile;
exports.updateLidMapping = updateLidMapping;
exports.formatPhoneNumber = formatPhoneNumber;
exports.extractRawNumber = extractRawNumber;
exports.getUserInfo = getUserInfo;
exports.contactCache = {};
exports.lidMap = {};
exports.profilesDB = {};
let contactsLookup = null;
function setContactsLookup(fn) { contactsLookup = fn; }
function rememberProfile(jidOrNum, name, realNum) {
    const key = (jidOrNum || '').split('@')[0].split(':')[0].replace(/\D/g, '');
    if (!key)
        return;
    if (!exports.profilesDB[key])
        exports.profilesDB[key] = {};
    if (name && name.trim() && name.trim() !== 'Membro')
        exports.profilesDB[key].name = name.trim();
    if (realNum) {
        const rn = String(realNum).replace(/\D/g, '');
        if (rn && rn.length <= 15)
            exports.profilesDB[key].num = rn;
    }
}
function updateLidMapping(participants) {
    if (!participants)
        return;
    for (const p of participants) {
        if (!p.id)
            continue;
        const cleanId = p.id.split('@')[0].split(':')[0].replace(/\D/g, '');
        const cleanLid = p.lid ? p.lid.split('@')[0].split(':')[0].replace(/\D/g, '') : '';
        if (cleanLid && cleanId && cleanLid !== cleanId)
            exports.lidMap[cleanLid] = cleanId;
        const name = p.name || p.notify || p.verifiedName;
        if (name) {
            exports.contactCache[cleanId] = { name, time: Date.now() };
            rememberProfile(cleanId, name);
            if (cleanLid) {
                exports.contactCache[cleanLid] = { name, time: Date.now() };
                rememberProfile(cleanLid, name, cleanId);
            }
        }
    }
}
function formatPhoneNumber(rawNum) {
    if (!rawNum)
        return '';
    const num = rawNum.replace(/\D/g, '');
    if (num.length > 15)
        return '';
    if (num.startsWith('55')) {
        const ddd = num.slice(2, 4);
        const rest = num.slice(4);
        if (rest.length === 9)
            return '+55 (' + ddd + ') ' + rest.slice(0, 5) + '-' + rest.slice(5);
        if (rest.length === 8)
            return '+55 (' + ddd + ') ' + rest.slice(0, 4) + '-' + rest.slice(4);
    }
    return '+' + num;
}
function extractRawNumber(userIdOrMention) {
    if (!userIdOrMention)
        return '';
    const part = userIdOrMention.split('@')[0].split(':')[0];
    let digits = part.replace(/\D/g, '');
    if (exports.lidMap[digits])
        digits = exports.lidMap[digits];
    if (digits.length > 15 && exports.profilesDB[digits] && exports.profilesDB[digits].num)
        digits = exports.profilesDB[digits].num;
    return digits;
}
function getUserInfo(userIdOrMention, pushNameHint = '') {
    const empty = { jid: '', number: '', formattedNum: '', pushName: 'Membro', fullDisplay: 'Membro', nameAndNumber: 'Membro', mentionTag: 'Membro', mention: 'Membro', mentionJid: '', smartMention: 'Membro', isLid: false };
    if (!userIdOrMention)
        return empty;
    const inputJid = userIdOrMention.includes('@') ? userIdOrMention : userIdOrMention + '@s.whatsapp.net';
    const inputLocal = inputJid.split('@')[0].split(':')[0];
    const inputIsLid = inputJid.endsWith('@lid');
    // DECISÃO PELO DOMÍNIO (não pelo comprimento):
    const mappedLid = inputIsLid ? (exports.lidMap[inputLocal] || (exports.profilesDB[inputLocal] && exports.profilesDB[inputLocal].num) || '') : '';
    const resolvedAll = extractRawNumber(userIdOrMention);
    const looksPhone = !!resolvedAll && resolvedAll.length >= 8 && resolvedAll.length <= 15;
    const isPhone = inputIsLid ? (!!mappedLid && mappedLid.length >= 8 && mappedLid.length <= 15) : looksPhone;
    const realNum = isPhone ? (inputIsLid ? mappedLid : resolvedAll) : '';
    const jid = isPhone ? realNum + '@s.whatsapp.net' : inputJid;
    const formattedNum = realNum ? formatPhoneNumber(realNum) : '';
    if (realNum === '5511927018683' || realNum === '54259127210155') {
        const cd = '@5511927018683';
        return { jid: '5511927018683@s.whatsapp.net', number: '5511927018683', formattedNum: '+55 (11) 92701-8683', pushName: 'Leandro', fullDisplay: cd, nameAndNumber: cd, mentionTag: cd, mention: cd, mentionJid: '5511927018683@s.whatsapp.net', smartMention: cd, isLid: false };
    }
    const cacheKey = realNum || inputLocal;
    let pushName = (pushNameHint || '').trim();
    if (!pushName)
        pushName = (exports.contactCache[cacheKey] && exports.contactCache[cacheKey].name) || '';
    if (!pushName)
        pushName = (exports.profilesDB[cacheKey] && exports.profilesDB[cacheKey].name) || '';
    if (!pushName)
        pushName = (exports.profilesDB[inputLocal] && exports.profilesDB[inputLocal].name) || '';
    if (!pushName && contactsLookup) {
        const r = contactsLookup(inputJid);
        if (r && r.name)
            pushName = r.name;
    }
    if (pushName) {
        exports.contactCache[cacheKey] = { name: pushName, time: Date.now() };
        rememberProfile(cacheKey, pushName, realNum || undefined);
    }
    if (pushName.startsWith('@') || pushName === cacheKey)
        pushName = '';
    let display;
    if (isPhone && realNum.startsWith('55'))
        display = '@' + realNum; // BR: clicável
    else if (isPhone)
        display = pushName ? pushName + ' - ' + formattedNum : formattedNum; // estrangeiro: texto limpo
    else
        display = '@' + inputLocal; // LID: clicável
    return { jid, number: realNum || inputLocal, formattedNum, pushName, fullDisplay: display, nameAndNumber: display, mentionTag: display, mention: display, mentionJid: jid, smartMention: display, isLid: inputIsLid && !isPhone };
}
