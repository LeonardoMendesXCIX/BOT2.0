import axios from 'axios';

export async function fetchNews(query: string, maxItems: number = 5): Promise<string> {
    try {
        const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query + ' when:1d')}&hl=pt-BR&gl=BR&ceid=BR:pt-419`;
        const response = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const xml = response.data;
        const items: string[] = [];
        const itemRegex = /<item>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<link>(.*?)<\/link>[\s\S]*?<\/item>/g;
        let match;
        while ((match = itemRegex.exec(xml)) !== null && items.length < maxItems) {
            let title = match[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
            const titleParts = title.split(' - ');
            if (titleParts.length > 1) titleParts.pop(); 
            title = titleParts.join(' - ') || title;
            items.push(`📰 *${title.trim()}*\n🔗 ${match[2].trim()}`);
        }
        if (items.length === 0) return "Nenhuma notícia relevante encontrada nas últimas 24 horas.";
        return items.join('\n\n');
    } catch (e) {
        return "Erro ao comunicar com servidores de notícias.";
    }
}
