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