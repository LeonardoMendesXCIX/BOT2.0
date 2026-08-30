export interface UserDisplayInfo {
    jid: string;
    number: string;
    formattedNum: string;
    pushName: string;
    fullDisplay: string;
    nameAndNumber: string;
    mentionTag: string;
}

export const contactCache: Record<string, { name: string; time: number }> = {};
export const lidMap: Record<string, string> = {};
// NOVO: banco de perfis (chave = números do jid) -> nome + número real
export const profilesDB: Record<string, { name?: string; num?: string }> = {};

let contactsLookup: ((jid: string) => { name?: string; num?: string } | null) | null = null;
export function setContactsLookup(fn: typeof contactsLookup) { contactsLookup = fn; }

// NOVO: registra nome/número vindos de qualquer fonte
export function rememberProfile(jidOrNum: string, name?: string, realNum?: string) {
    const key = (jidOrNum || '').split('@')[0].split(':')[0].replace(/\D/g, '');
    if (!key) return;
    if (!profilesDB[key]) profilesDB[key] = {};
    if (name && name.trim() && name.trim() !== 'Membro') profilesDB[key].name = name.trim();
    if (realNum) {
        const rn = String(realNum).replace(/\D/g, '');
        if (rn && rn.length <= 13) profilesDB[key].num = rn;
    }
}

export function updateLidMapping(participants: any[]): void {
    if (!participants) return;
    for (const p of participants) {
        if (!p.id) continue;
        const cleanId = p.id.split('@')[0].split(':')[0].replace(/\D/g, '');
        const cleanLid = p.lid ? p.lid.split('@')[0].split(':')[0].replace(/\D/g, '') : '';
        if (cleanLid && cleanId && cleanLid !== cleanId) lidMap[cleanLid] = cleanId;
        const name = p.name || p.notify || p.verifiedName;
        if (name) {
            contactCache[cleanId] = { name, time: Date.now() };
            rememberProfile(cleanId, name);
            if (cleanLid) {
                contactCache[cleanLid] = { name, time: Date.now() };
                rememberProfile(cleanLid, name, cleanId);
            }
        }
    }
}

export function formatPhoneNumber(rawNum: string): string {
    if (!rawNum) return '';
    const num = rawNum.replace(/\D/g, '');
    if (num.startsWith('55')) {
        const ddd = num.slice(2, 4);
        const rest = num.slice(4);
        if (rest.length === 9) {
            return '+55 (' + ddd + ') ' + rest.slice(0, 5) + '-' + rest.slice(5);
        } else if (rest.length === 8) {
            return '+55 (' + ddd + ') ' + rest.slice(0, 4) + '-' + rest.slice(4);
        }
    }
    if (num.length > 13) {
        return '';
    }
    return '+' + num;
}

export function extractRawNumber(userIdOrMention: string): string {
    if (!userIdOrMention) return '';
    const part = userIdOrMention.split('@')[0].split(':')[0];
    let digits = part.replace(/\D/g, '');
    if (lidMap[digits]) digits = lidMap[digits];
    if (digits.length > 13 && profilesDB[digits] && profilesDB[digits].num) digits = profilesDB[digits].num!;
    return digits;
}

export function getUserInfo(userIdOrMention: string, pushNameHint: string = ''): UserDisplayInfo {
    if (!userIdOrMention) {
        return {
            jid: '',
            number: 'Desconhecido',
            formattedNum: 'Número Desconhecido',
            pushName: 'Membro',
            fullDisplay: 'Membro',
            nameAndNumber: 'Membro',
            mentionTag: '@Desconhecido'
        };
    }

    const originalDigits = userIdOrMention.split('@')[0].split(':')[0].replace(/\D/g, '');
    let rawNum = extractRawNumber(userIdOrMention);
    const cleanJid = rawNum + '@s.whatsapp.net';
    const isLid = rawNum.length > 13;
    const mentionTag = '@' + rawNum;
    const formattedNum = formatPhoneNumber(rawNum);

    const isCreator = rawNum === '5511927018683' || rawNum === '54259127210155';
    if (isCreator) {
        return {
            jid: cleanJid,
            number: '5511927018683',
            formattedNum: '+55 (11) 92701-8683',
            pushName: 'Leandro',
            fullDisplay: 'Leandro - +55 (11) 92701-8683',
            nameAndNumber: 'Leandro - +55 (11) 92701-8683',
            mentionTag: '@5511927018683'
        };
    }

    // Resolução de nome em várias fontes (padrão Nome - Número em todo o projeto)
    let pushName = (pushNameHint || '').trim();
    if (!pushName) pushName = (contactCache[rawNum] && contactCache[rawNum].name) || '';
    if (!pushName) pushName = (profilesDB[rawNum] && profilesDB[rawNum].name) || '';
    if (!pushName) pushName = (profilesDB[originalDigits] && profilesDB[originalDigits].name) || '';
    if (!pushName) pushName = (contactCache[originalDigits] && contactCache[originalDigits].name) || '';
    if (!pushName && contactsLookup) {
        const r = contactsLookup(userIdOrMention) || (originalDigits !== rawNum ? contactsLookup(originalDigits + '@s.whatsapp.net') : null);
        if (r && r.name) pushName = r.name;
    }
    if (pushName) {
        contactCache[rawNum] = { name: pushName, time: Date.now() };
        rememberProfile(rawNum, pushName);
        rememberProfile(originalDigits, pushName, rawNum);
    }
    if (pushName.startsWith('@') || pushName === rawNum) pushName = '';

    // PADRÃO OBRIGATÓRIO: "Nome - +55XXXXXXXXXXX"
    let nameAndNumber: string;
    if (formattedNum) {
        nameAndNumber = pushName ? (pushName + ' - ' + formattedNum) : formattedNum;
    } else {
        nameAndNumber = pushName || 'Membro';
    }

    return {
        jid: cleanJid,
        number: rawNum,
        formattedNum: formattedNum || rawNum,
        pushName: pushName,
        fullDisplay: nameAndNumber,
        nameAndNumber: nameAndNumber,
        mentionTag: mentionTag
    };
}