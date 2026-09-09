import yts from 'yt-search';
import ytdl from '@distube/ytdl-core';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import fs from 'fs';
import path from 'path';
import axios from 'axios';

ffmpeg.setFfmpegPath(ffmpegStatic || 'ffmpeg');

const TEMP_DIR = path.join(__dirname, '..', '..', 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

setInterval(() => {
    const now = Date.now();
    try {
        fs.readdirSync(TEMP_DIR).forEach(f => {
            try {
                const fp = path.join(TEMP_DIR, f);
                if (now - fs.statSync(fp).mtimeMs > 10 * 60 * 1000) fs.unlinkSync(fp);
            } catch (e) { }
        });
    } catch (e) { }
}, 5 * 60 * 1000);

export interface SearchResult {
    title: string; url: string; videoId: string;
    duration: string; seconds: number; thumbnail: string; author: string;
}
interface StrategyResult<T> { success: boolean; data?: T; error?: string; strategyName: string; }
type Strategy<T> = () => Promise<StrategyResult<T>>;

async function tryStrategies<T>(name: string, strategies: Strategy<T>[]): Promise<T> {
    let lastError = 'todas as estratégias falharam';
    for (let i = 0; i < strategies.length; i++) {
        try {
            const r = await strategies[i]();
            if (r.success && r.data) {
                console.log('[YT ' + name + '] ✅ estratégia ' + (i + 1) + '/' + strategies.length + ': ' + r.strategyName);
                return r.data;
            }
            lastError = r.error || 'falha';
        } catch (e: any) { lastError = e?.message || 'erro'; }
    }
    throw new Error(name + ': ' + lastError);
}

const INVIDIOUS = ['https://yewtu.be', 'https://vid.puffyan.us', 'https://invidious.privacyredirect.com', 'https://inv.nadeko.net'];
const PIPED = ['https://pipedapi.kavin.rocks', 'https://pipedapi.adminforge.de', 'https://api.piped.private.coffee'];

// ============ BUSCA (10 estratégias) ============
export async function searchYouTube(query: string, limit = 15): Promise<SearchResult[]> {
    const mapYts = (r: any) => r.videos.slice(0, limit).map((v: any) => ({
        title: v.title, url: v.url, videoId: v.videoId,
        duration: v.duration?.timestamp || '?:??', seconds: v.seconds || 0,
        thumbnail: v.thumbnail || '', author: v.author?.name || ''
    }));
    const strategies: Strategy<SearchResult[]>[] = [
        async () => { const r = await yts({ query, pages: 1 }); return { success: r.videos.length > 0, data: mapYts(r), strategyName: 'yt-search' }; },
        async () => { const r = await yts({ query, pages: 2 }); return { success: r.videos.length > 0, data: mapYts(r), strategyName: 'yt-search 2p' }; },
        ...INVIDIOUS.map(inst => async (): Promise<StrategyResult<SearchResult[]>> => {
            const res = await axios.get(inst + '/api/v1/search', { params: { q: query, type: 'video' }, timeout: 8000 });
            const items = (res.data || []).slice(0, limit);
            return { success: items.length > 0, data: items.map((v: any) => ({ title: v.title, url: 'https://www.youtube.com/watch?v=' + v.videoId, videoId: v.videoId, duration: Math.floor((v.lengthSeconds || 0) / 60) + ':' + String((v.lengthSeconds || 0) % 60).padStart(2, '0'), seconds: v.lengthSeconds || 0, thumbnail: v.videoThumbnails?.[0]?.url || '', author: v.author || '' })), strategyName: 'Invidious ' + inst };
        }),
        ...PIPED.map(inst => async (): Promise<StrategyResult<SearchResult[]>> => {
            const res = await axios.get(inst + '/search', { params: { q: query, filter: 'videos' }, timeout: 8000 });
            const items = (res.data?.items || []).slice(0, limit);
            return { success: items.length > 0, data: items.map((v: any) => ({ title: v.title, url: 'https://www.youtube.com' + (v.url || ''), videoId: (v.url || '').replace('/watch?v=', ''), duration: Math.floor((v.duration || 0) / 60) + ':' + String((v.duration || 0) % 60).padStart(2, '0'), seconds: v.duration || 0, thumbnail: v.thumbnail || '', author: v.uploaderName || '' })), strategyName: 'Piped ' + inst };
        }),
        async () => {
            const res = await axios.get('https://html.duckduckgo.com/html/', { params: { q: query + ' youtube' }, timeout: 6000, headers: { 'User-Agent': 'Mozilla/5.0' } });
            const m = String(res.data).match(/v=([a-zA-Z0-9_-]{11})/);
            if (!m) return { success: false, strategyName: 'DuckDuckGo' };
            return { success: true, data: [{ title: query, url: 'https://www.youtube.com/watch?v=' + m[1], videoId: m[1], duration: '?:??', seconds: 0, thumbnail: '', author: 'YouTube' }], strategyName: 'DuckDuckGo' };
        }
    ];
    return tryStrategies('BUSCA', strategies);
}

// ============ HELPERS ============
async function ytBuf(url: string, opts: ytdl.downloadOptions, name: string): Promise<StrategyResult<Buffer>> {
    try {
        const chunks: Buffer[] = [];
        await new Promise<void>((res, rej) => {
            ytdl(url, opts).on('data', c => chunks.push(c)).on('end', () => res()).on('error', rej);
        });
        const buf = Buffer.concat(chunks);
        return buf.length > 5000 ? { success: true, data: buf, strategyName: name } : { success: false, strategyName: name, error: 'muito pequeno' };
    } catch (e: any) { return { success: false, strategyName: name, error: e.message }; }
}

async function toMp3(input: Buffer, bitrate: string): Promise<Buffer> {
    const inP = path.join(TEMP_DIR, 'in_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
    const outP = inP + '.mp3';
    fs.writeFileSync(inP, input);
    try {
        await new Promise<void>((res, rej) => ffmpeg(inP).audioCodec('libmp3lame').audioBitrate(bitrate).toFormat('mp3').on('end', () => res()).on('error', rej).save(outP));
        return fs.readFileSync(outP);
    } finally {
        try { fs.unlinkSync(inP); } catch (e) { }
        try { fs.unlinkSync(outP); } catch (e) { }
    }
}

async function invidiousStream(url: string, inst: string, kind: 'audio' | 'video'): Promise<StrategyResult<Buffer>> {
    try {
        const id = ytdl.getVideoID(url);
        const api = await axios.get(inst + '/api/v1/videos/' + id, { timeout: 10000 });
        const list = kind === 'audio' ? (api.data?.adaptiveFormats || []).filter((f: any) => (f.type || '').startsWith('audio/')) : (api.data?.formatStreams || []);
        const chosen = list[0];
        if (!chosen?.url) return { success: false, strategyName: 'Invidious ' + kind + ' ' + inst, error: 'sem url' };
        const dl = await axios.get(chosen.url, { responseType: 'arraybuffer', timeout: 60000 });
        return { success: true, data: Buffer.from(dl.data), strategyName: 'Invidious ' + kind + ' ' + inst };
    } catch (e: any) { return { success: false, strategyName: 'Invidious ' + kind + ' ' + inst, error: e.message }; }
}

async function pipedStream(url: string, inst: string, kind: 'audio' | 'video'): Promise<StrategyResult<Buffer>> {
    try {
        const id = ytdl.getVideoID(url);
        const api = await axios.get(inst + '/streams/' + id, { timeout: 10000 });
        const list = kind === 'audio' ? (api.data?.audioStreams || []) : (api.data?.videoStreams || []);
        const chosen = list[0];
        if (!chosen?.url) return { success: false, strategyName: 'Piped ' + kind + ' ' + inst, error: 'sem url' };
        const dl = await axios.get(chosen.url, { responseType: 'arraybuffer', timeout: 60000 });
        return { success: true, data: Buffer.from(dl.data), strategyName: 'Piped ' + kind + ' ' + inst };
    } catch (e: any) { return { success: false, strategyName: 'Piped ' + kind + ' ' + inst, error: e.message }; }
}

async function cobalt(url: string, audio: boolean): Promise<StrategyResult<Buffer>> {
    try {
        const res = await axios.post('https://api.cobalt.tools/api/json', { url, isAudioOnly: audio }, { headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, timeout: 15000 });
        if (!res.data?.url) return { success: false, strategyName: 'Cobalt', error: 'sem url' };
        const dl = await axios.get(res.data.url, { responseType: 'arraybuffer', timeout: 60000 });
        return { success: true, data: Buffer.from(dl.data), strategyName: 'Cobalt' };
    } catch (e: any) { return { success: false, strategyName: 'Cobalt', error: e.message }; }
}

// ============ ÁUDIO (15 estratégias) ============
export async function getAudioBuffer(url: string): Promise<Buffer> {
    const strategies: Strategy<Buffer>[] = [
        async () => { const r = await ytBuf(url, { quality: 'highestaudio', filter: 'audioonly' }, 'ytdl high'); if (!r.data) return r; try { return { success: true, data: await toMp3(r.data, '192'), strategyName: 'ytdl high+mp3 192k' }; } catch (e: any) { return { success: false, strategyName: 'ytdl high+mp3', error: e.message }; } },
        async () => { const r = await ytBuf(url, { quality: 'highestaudio', filter: 'audioonly' }, 'ytdl high'); if (!r.data) return r; try { return { success: true, data: await toMp3(r.data, '128'), strategyName: 'ytdl high+mp3 128k' }; } catch (e: any) { return { success: false, strategyName: 'ytdl high+mp3 128', error: e.message }; } },
        async () => { const r = await ytBuf(url, { quality: 'highestaudio', filter: 'audioonly' }, 'ytdl high'); if (!r.data) return r; try { return { success: true, data: await toMp3(r.data, '96'), strategyName: 'ytdl high+mp3 96k' }; } catch (e: any) { return { success: false, strategyName: 'ytdl high+mp3 96', error: e.message }; } },
        async () => { const r = await ytBuf(url, { quality: 'lowestaudio', filter: 'audioonly' }, 'ytdl low'); if (!r.data) return r; try { return { success: true, data: await toMp3(r.data, '128'), strategyName: 'ytdl low+mp3' }; } catch (e: any) { return { success: false, strategyName: 'ytdl low+mp3', error: e.message }; } },
        ...INVIDIOUS.map(inst => async () => { const r = await invidiousStream(url, inst, 'audio'); if (!r.data) return r; try { return { success: true, data: await toMp3(r.data, '128'), strategyName: 'Invidious a ' + inst }; } catch (e: any) { return { success: false, strategyName: 'Invidious a ' + inst, error: e.message }; } }),
        ...PIPED.map(inst => async () => { const r = await pipedStream(url, inst, 'audio'); if (!r.data) return r; try { return { success: true, data: await toMp3(r.data, '128'), strategyName: 'Piped a ' + inst }; } catch (e: any) { return { success: false, strategyName: 'Piped a ' + inst, error: e.message }; } }),
        async () => cobalt(url, true),
        async () => ytBuf(url, { quality: 'highestaudio', filter: 'audioonly' }, 'ytdl direto (sem conversão)')
    ];
    return tryStrategies('AUDIO', strategies);
}

// ============ VÍDEO (15 estratégias) ============
export async function getVideoBuffer(url: string): Promise<Buffer> {
    const strategies: Strategy<Buffer>[] = [
        async () => ytBuf(url, { quality: 'highest', filter: 'videoandaudio' }, 'ytdl highest'),
        async () => ytBuf(url, { quality: 'highestvideo', filter: 'videoandaudio' }, 'ytdl highestvideo'),
        async () => ytBuf(url, { filter: (f: any) => f.container === 'mp4' && f.hasVideo && f.hasAudio }, 'ytdl mp4+a'),
        async () => ytBuf(url, { quality: 'lowest', filter: 'videoandaudio' }, 'ytdl lowest'),
        async () => { const info = await ytdl.getInfo(url); const f = info.formats.find(x => x.qualityLabel === '360p' && x.hasVideo && x.hasAudio); return f ? ytBuf(url, { quality: f.itag }, 'ytdl itag 360p') : { success: false, strategyName: 'itag 360p', error: 'sem formato' }; },
        async () => { const info = await ytdl.getInfo(url); const f = info.formats.find(x => x.qualityLabel === '480p' && x.hasVideo && x.hasAudio); return f ? ytBuf(url, { quality: f.itag }, 'ytdl itag 480p') : { success: false, strategyName: 'itag 480p', error: 'sem formato' }; },
        ...INVIDIOUS.map(inst => async () => invidiousStream(url, inst, 'video')),
        ...PIPED.map(inst => async () => pipedStream(url, inst, 'video')),
        async () => cobalt(url, false),
        async () => ytBuf(url, { quality: 'lowestvideo', filter: 'videoandaudio' }, 'ytdl lowestvideo')
    ];
    return tryStrategies('VIDEO', strategies);
}

// ============ WRAPPERS DE COMPATIBILIDADE ==========
export async function downloadAudio(url: string): Promise<string> {
    const buf = await getAudioBuffer(url);
    const p = path.join(TEMP_DIR, 'a_' + Date.now() + '.mp3');
    fs.writeFileSync(p, buf);
    return p;
}
export async function downloadVideo(url: string): Promise<string> {
    const buf = await getVideoBuffer(url);
    const p = path.join(TEMP_DIR, 'v_' + Date.now() + '.mp4');
    fs.writeFileSync(p, buf);
    return p;
}
