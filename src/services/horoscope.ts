import axios from 'axios';

export async function fetchHoroscope(signName: string, isDetailed: boolean = false): Promise<string> {
    try {
        const query = `horóscopo do dia ${signName} previsão de hoje`;
        const response = await axios.get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        const regex = /<a class="result__snippet[^>]*>(.*?)<\/a>/g;
        let match, validSnippets: string[] = [];
        while ((match = regex.exec(response.data)) !== null) {
            let clean = match[1].replace(/<\/?[^>]+(>|$)/g, "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
            const isBait = /leia a tendência|confira a previsão|veja o que|descubra|tudo sobre o signo|clique aqui|assine o/i.test(clean);
            if (clean.length > 55 && !isBait) validSnippets.push(clean);
        }
        if (validSnippets.length === 0) return "Os astros estão em silêncio no momento.";
        const limit = isDetailed ? Math.min(2, validSnippets.length) : 1;
        return validSnippets.slice(0, limit).join('\n\n');
    } catch (e) {
        return "Falha de conexão com os serviços de astrologia.";
    }
}
