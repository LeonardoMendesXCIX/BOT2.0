import axios from 'axios';

export async function downloadMedia(url: string): Promise<Buffer | null> {
    try {
        const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
        return Buffer.from(r.data);
    } catch (e) {
        return null;
    }
}

export async function getYoutubeInfo(query: string): Promise<{ title: string; url: string } | null> {
    try {
        const r = await axios.get('https://noembed.com/embed?url=' + encodeURIComponent('https://youtube.com/results?search_query=' + query), { timeout: 8000 }).catch(() => null);
        if (!r || !r.data) {
            return { title: query, url: 'https://youtube.com/results?search_query=' + encodeURIComponent(query) };
        }
        return { title: r.data.title || query, url: 'https://youtube.com/results?search_query=' + encodeURIComponent(query) };
    } catch (e) {
        return null;
    }
}

export async function translateText(text: string, to: string = 'pt'): Promise<string | null> {
    try {
        const r = await axios.get('https://api.mymemory.translated.net/get', { params: { q: text.slice(0, 400), langpair: 'auto|' + to }, timeout: 8000 });
        return r.data?.responseData?.translatedText || null;
    } catch (e) {
        return null;
    }
}

export async function defineWord(word: string): Promise<string | null> {
    try {
        const r = await axios.get('https://api.dicionario-aberto.net/word/' + encodeURIComponent(word), { timeout: 8000 });
        const entries = r.data || [];
        if (!entries.length) return null;
        const defs = entries.slice(0, 3).map((e: any) => '• ' + (e.meanings?.[0]?.definitions?.[0]?.text || '')).filter(Boolean).join('\n');
        return defs || null;
    } catch (e) {
        return null;
    }
}

export async function removeBackground(imgBuf: Buffer): Promise<Buffer | null> {
    try {
        return null;
    } catch (e) {
        return null;
    }
}

export async function fetchLiveMatches(): Promise<Array<{ home: string; away: string; score: string; minute: string }>> {
    try {
        return [];
    } catch (e) {
        return [];
    }
}
