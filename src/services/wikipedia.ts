import axios from 'axios';

export async function fetchWikipedia(query: string): Promise<string> {
    try {
        const res = await axios.get(`https://pt.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`);
        if (res.data && res.data.extract) {
            return `📚 *WIKIPÉDIA: ${res.data.title.toUpperCase()}*\n\n${res.data.extract}\n\n🔗 _${res.data.content_urls?.desktop?.page || ''}_`;
        }
        return '❌ Nenhum artigo encontrado na Wikipédia.';
    } catch (e) {
        return '❌ Artigo não localizado na Wikipédia.';
    }
}
