import sharp from 'sharp';
function escapeXml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function wrapText(text: string, max: number): string[] {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
        if ((cur + ' ' + w).trim().length > max) { if (cur) lines.push(cur.trim()); cur = w; }
        else cur = (cur + ' ' + w).trim();
    }
    if (cur) lines.push(cur.trim());
    return lines.slice(0, 10);
}
export async function generateNglCard(message: string, footer: string): Promise<Buffer> {
    const lines = wrapText(message, 26);
    const cardH = 220 + lines.length * 36;
    const totalH = cardH + 100;
    const tspans = lines.map((l, i) => '<tspan x="60" dy="' + (i === 0 ? '0' : '36') + '">' + escapeXml(l) + '</tspan>').join('');
    const svg = '<svg width="720" height="' + totalH + '" xmlns="http://www.w3.org/2000/svg">' +
        '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7b2ff7"/><stop offset="1" stop-color="#f107a3"/></linearGradient></defs>' +
        '<rect width="720" height="' + totalH + '" fill="url(#g)"/>' +
        '<rect x="30" y="30" width="660" height="' + cardH + '" rx="26" fill="#ffffff"/>' +
        '<text x="60" y="95" font-family="Arial" font-size="30" font-weight="bold" fill="#7b2ff7">mensagem anônima recebida</text>' +
        '<text x="60" y="160" font-family="Arial" font-size="27" fill="#222222">' + tspans + '</text>' +
        '<text x="40" y="' + (totalH - 35) + '" font-family="Arial" font-size="15" fill="#ffffff" opacity="0.8">' + escapeXml(footer) + '</text>' +
        '</svg>';
    return await sharp(Buffer.from(svg)).png().toBuffer();
}

export async function generateProfileCard(name: string, level: number, role: string, xp: number, coins: number): Promise<Buffer> {
    const svg = '<svg width="600" height="300" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7b2ff7"/><stop offset="1" stop-color="#f107a3"/></linearGradient></defs><rect width="600" height="300" fill="url(#g)"/><rect x="20" y="20" width="560" height="260" rx="20" fill="#ffffff"/><text x="50" y="80" font-family="Arial" font-size="30" font-weight="bold" fill="#7b2ff7">' + escapeXml(name) + '</text><text x="50" y="130" font-family="Arial" font-size="22" fill="#222">Nível ' + level + ' — ' + escapeXml(role) + '</text><text x="50" y="175" font-family="Arial" font-size="20" fill="#555">✨ XP: ' + xp + '</text><text x="50" y="215" font-family="Arial" font-size="20" fill="#555">💰 Moedas: ' + coins + '</text><text x="50" y="255" font-family="Arial" font-size="14" fill="#999">BOT DROPHTTP</text></svg>';
    return await sharp(Buffer.from(svg)).png().toBuffer();
}

export async function generateMemeCard(top: string, bottom: string): Promise<Buffer> {
    const svg = '<svg width="600" height="400" xmlns="http://www.w3.org/2000/svg"><rect width="600" height="400" fill="#111"/><text x="300" y="70" font-family="Impact,Arial" font-size="40" fill="#fff" text-anchor="middle">' + escapeXml(top) + '</text><text x="300" y="360" font-family="Impact,Arial" font-size="40" fill="#fff" text-anchor="middle">' + escapeXml(bottom) + '</text></svg>';
    return await sharp(Buffer.from(svg)).png().toBuffer();
}

export async function generateQuoteCard(author: string, quote: string): Promise<Buffer> {
    const svg = '<svg width="600" height="260" xmlns="http://www.w3.org/2000/svg"><rect width="600" height="260" fill="#f5f5f5"/><rect x="20" y="20" width="560" height="220" rx="16" fill="#fff" stroke="#ddd"/><text x="50" y="80" font-family="Arial" font-size="24" font-weight="bold" fill="#7b2ff7">' + escapeXml(author) + '</text><text x="50" y="130" font-family="Arial" font-size="20" fill="#333">"' + escapeXml(quote) + '"</text></svg>';
    return await sharp(Buffer.from(svg)).png().toBuffer();
}

export async function generateTextSticker(text: string, bg: string): Promise<Buffer> {
    const svg = '<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg"><rect width="512" height="512" fill="' + bg + '"/><text x="256" y="280" font-family="Arial" font-size="60" font-weight="bold" fill="#fff" text-anchor="middle">' + escapeXml(text) + '</text></svg>';
    return await sharp(Buffer.from(svg)).png().toBuffer();
}

