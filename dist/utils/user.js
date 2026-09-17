"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.profilesDB = exports.lidMap = exports.contactCache = void 0;
exports.setContactsLookup = setContactsLookup;
exports.rememberProfile = rememberProfile;
exports.updateLidMapping = updateLidMapping;
exports.formatPhoneNumber = formatPhoneNumber;
exports.detectBrazilianNumber = detectBrazilianNumber;
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
const BRAZILIAN_AREA_CODES = new Set([
    11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28,
    31, 32, 33, 34, 35, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48,
    49, 51, 53, 54, 55, 61, 62, 63, 64, 65, 66, 67, 68, 69, 71,
    73, 74, 75, 77, 79, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91,
    92, 93, 94, 95, 96, 97, 98, 99
]);
function detectBrazilianNumber(num) {
    if (!num)
        return false;
    const cleanNum = num.replace(/\D/g, '');
    const nationalNumber = cleanNum.startsWith('55') && (cleanNum.length === 12 || cleanNum.length === 13)
        ? cleanNum.slice(2)
        : cleanNum;
    if (nationalNumber.length !== 10 && nationalNumber.length !== 11)
        return false;
    const areaCode = Number(nationalNumber.slice(0, 2));
    if (!BRAZILIAN_AREA_CODES.has(areaCode))
        return false;
    const subscriber = nationalNumber.slice(2);
    if (subscriber.length === 9)
        return subscriber.startsWith('9');
    return subscriber.length === 8 && !subscriber.startsWith('0');
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
    const mappedLid = inputIsLid ? (exports.lidMap[inputLocal] || (exports.profilesDB[inputLocal] && exports.profilesDB[inputLocal].num) || '') : '';
    const resolvedAll = extractRawNumber(userIdOrMention);
    const looksPhone = !!resolvedAll && resolvedAll.length >= 8 && resolvedAll.length <= 15;
    const isPhone = inputIsLid ? (!!mappedLid && mappedLid.length >= 8 && mappedLid.length <= 15) : looksPhone;
    const detectedNum = isPhone ? (inputIsLid ? mappedLid : resolvedAll) : '';
    const realNum = detectedNum && detectBrazilianNumber(detectedNum) && !detectedNum.startsWith('55')
        ? '55' + detectedNum
        : detectedNum;
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
    let smartDisplay;
    let humanDisplay;
    if (isPhone) {
        // SEMPRE usar @numero para ser clicável, independente de ser BR ou estrangeiro
        smartDisplay = '@' + realNum;
        humanDisplay = pushName ? pushName + ' - ' + formattedNum : formattedNum;
    }
    else {
        // LID: clicável
        smartDisplay = '@' + inputLocal;
        humanDisplay = pushName ? pushName + ' - LID' : 'LID';
    }
    return {
        jid,
        number: realNum || inputLocal,
        formattedNum,
        pushName,
        fullDisplay: humanDisplay,
        nameAndNumber: humanDisplay,
        mentionTag: smartDisplay,
        mention: smartDisplay,
        mentionJid: jid,
        smartMention: smartDisplay,
        isLid: inputIsLid && !isPhone
    };
}
