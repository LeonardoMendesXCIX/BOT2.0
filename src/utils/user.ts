export interface UserDisplayInfo {
    jid: string;
    number: string;
    formattedNum: string;
    pushName: string;
    fullDisplay: string;
    nameAndNumber: string;
    mentionTag: string;
}

// CORREÇÃO: exportado para permitir persistência e consulta externa
export const contactCache: Record<string, { name: string; time: number }> = {};
export const lidMap: Record<string, string> = {};

export function updateLidMapping(participants: any[]): void {
    if (!participants) return;
    for (const p of participants) {
        if (p.id) {
            const cleanId = p.id.split('@')[0].split(':')[0].replace(/\D/g, '');
            if (p.lid) {
                const cleanLid = p.lid.split('@')[0].split(':')[0].replace(/\D/g, '');
                if (cleanId && cleanLid && cleanId !== cleanLid) {
                    lidMap[cleanLid] = cleanId;
                }
            }
            const name = p.name || p.notify || p.verifiedName;
            if (cleanId && name) {
                contactCache[cleanId] = { name: name.trim(), time: Date.now() };
            }
            if (p.lid && name) {
                const cleanLid = p.lid.split('@')[0].split(':')[0].replace(/\D/g, '');
                contactCache[cleanLid] = { name: name.trim(), time: Date.now() };
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
            return `+55 (${ddd}) ${rest.slice(0, 5)}-${rest.slice(5)}`;
        } else if (rest.length === 8) {
            return `+55 (${ddd}) ${rest.slice(0, 4)}-${rest.slice(4)}`;
        }
    }
    if (num.length > 13) {
        return '';
    }
    return `+${num}`;
}

export function extractRawNumber(userIdOrMention: string): string {
    if (!userIdOrMention) return '';
    const part = userIdOrMention.split('@')[0].split(':')[0];
    let digits = part.replace(/\D/g, '');

    if (lidMap[digits]) {
        digits = lidMap[digits];
    }
    return digits;
}

export function getUserInfo(userIdOrMention: string, pushNameHint: string = ''): UserDisplayInfo {
    if (!userIdOrMention) {
        return {
            jid: '',
            number: 'Desconhecido',
            formattedNum: 'Número Desconhecido',
            pushName: 'Membro',
            fullDisplay: '@Desconhecido',
            nameAndNumber: 'Membro',
            mentionTag: '@Desconhecido'
        };
    }

    const rawNum = extractRawNumber(userIdOrMention);
    const cleanJid = `${rawNum}@s.whatsapp.net`;
    const isLid = rawNum.length > 13;
    const mentionTag = `@${rawNum}`;
    const formattedNum = formatPhoneNumber(rawNum);

    const isCreator = rawNum === '5511927018683' || rawNum === '54259127210155';

    if (isCreator) {
        return {
            jid: cleanJid,
            number: '5511927018683',
            formattedNum: '+55 (11) 92701-8683',
            pushName: 'Leandro',
            fullDisplay: '*Leandro* - +55 (11) 92701-8683',
            nameAndNumber: '*Leandro* - +55 (11) 92701-8683',
            mentionTag: '@5511927018683'
        };
    }

    let pushName = pushNameHint ? pushNameHint.trim() : '';
    if (!pushName && contactCache[rawNum] && (Date.now() - contactCache[rawNum].time < 86400000)) {
        pushName = contactCache[rawNum].name;
    }
    if (pushName) {
        contactCache[rawNum] = { name: pushName, time: Date.now() };
    }

    if (pushName.startsWith('@') || pushName === rawNum) {
        pushName = '';
    }

    const finalName = pushName ? pushName : '';
    let nameAndNumber = '';
    let fullDisplay = '';

    if (finalName && !isLid && formattedNum) {
        nameAndNumber = `*${finalName}* - ${formattedNum}`;
        fullDisplay = `*${finalName}* - ${formattedNum}`;
    } else if (finalName && isLid) {
        nameAndNumber = `*${finalName}*`;
        fullDisplay = `*${finalName}*`;
    } else if (!finalName && !isLid && formattedNum) {
        nameAndNumber = formattedNum;
        fullDisplay = formattedNum;
    } else {
        nameAndNumber = `*Novo Membro* - ${formattedNum || `@${rawNum}`}`;
        fullDisplay = `*Novo Membro* - ${formattedNum || `@${rawNum}`}`;
    }

    return {
        jid: cleanJid,
        number: rawNum,
        formattedNum: formattedNum || rawNum,
        pushName: finalName,
        fullDisplay,
        nameAndNumber,
        mentionTag
    };
}