import yts from 'yt-search';
import ytdl from '@distube/ytdl-core';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import fs from 'fs';
import path from 'path';
import axios from 'axios';

ffmpeg.setFfmpegPath(ffmpegStatic as string);

const TEMP_DIR = path.join(__dirname, '..', '..', 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

setInterval(() => {
    try {
        const now = Date.now();
        for (const f of fs.readdirSync(TEMP_DIR)) {
            const fp = path.join(TEMP_DIR, f);
            const st = fs.statSync(fp);
            if (now - st.mtimeMs > 10 * 60 * 1000) fs.unlinkSync(fp);
        }
    } catch (e) { }
}, 5 * 60 * 1000);

const INVIDIOUS = [
    'https://inv.nadeko.net',
    'https://invidious.fdn.fr',
    'https://inv.tux.pizza',
    'https://invidious.nerdvpn.de',
    'https://vid.puffyan.us'
];

const PIPED = [
    'https://piped.video',
    'https://piped.adminforge.de',
    'https://piped.projectsegfau.lt'
];

const COBALT = [
    'https://cobalt.tools/',
    'https://co.wuk.sh/api/json',
    'https://api.cobalt.tools/'
];

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function safeJson<T>(value: any, fallback: T): T { try { return value ?? fallback; } catch { return fallback; } }

function buildResult(v: any) {
    return {
        title: v?.title || 'YouTube',
        url: v?.url || v?.link || '',
        videoId: v?.videoId || v?.id || '',
        duration: v?.duration?.timestamp || v?.duration || '0:00',
        seconds: Number(v?.seconds ?? 0),
        thumbnail: v?.thumbnail || v?.image || '',
        author: v?.author?.name || v?.channel || ''
    };
}

async function fetchHtml(url: string): Promise<string> {
    const { data } = await axios.get(url, { headers: { 'User-Agent': USER_AGENT }, timeout: 15000 });
    return String(data || '');
}

async function searchYtSearch(query: string, limit: number): Promise<any[]> {
    const res = await yts(query);
    const items = (res?.videos || []).slice(0, limit).map(buildResult);
    return items;
}

async function searchInvidious(query: string, limit: number): Promise<any[]> {
    for (const base of INVIDIOUS) {
        try {
            const url = `${base}/api/v1/search?q=${encodeURIComponent(query)}&type=video&region=BR&hl=pt-BR&safeSearch=0`;
            const { data } = await axios.get(url, { headers: { 'User-Agent': USER_AGENT }, timeout: 15000 });
            const arr = Array.isArray(data) ? data : [];
            const items = arr.slice(0, limit).map((v: any) => buildResult({
                title: v.title,
                url: v.videoId ? `https://www.youtube.com/watch?v=${v.videoId}` : v.url,
                videoId: v.videoId,
                duration: v.lengthSeconds ? `${Math.floor(Number(v.lengthSeconds) / 60)}:${String(Number(v.lengthSeconds) % 60).padStart(2, '0')}` : '0:00',
                seconds: Number(v.lengthSeconds || 0),
                thumbnail: v.videoThumbnails?.[0]?.url || v.thumbnail || '',
                author: v.author?.name || v.author || ''
            }));
            if (items.length) return items;
        } catch (e) { }
    }
    return [];
}

async function searchPiped(query: string, limit: number): Promise<any[]> {
    for (const base of PIPED) {
        try {
            const url = `${base}/search?q=${encodeURIComponent(query)}&filter=videos`;
            const { data } = await axios.get(url, { headers: { 'User-Agent': USER_AGENT }, timeout: 15000 });
            const arr = Array.isArray(data) ? data : [];
            const items = arr.slice(0, limit).map((v: any) => buildResult({
                title: v.title,
                url: v.url || `https://www.youtube.com/watch?v=${v.id}`,
                videoId: v.url ? (v.url.match(/[?&]v=([^&]+)/)?.[1] || v.id) : v.id,
                duration: v.duration ?? '0:00',
                seconds: Number(v.duration && typeof v.duration === 'number' ? v.duration : 0),
                thumbnail: v.thumbnail || '',
                author: v.uploaderName || ''
            }));
            if (items.length) return items;
        } catch (e) { }
    }
    return [];
}

async function searchDuckDuckGo(query: string, limit: number): Promise<any[]> {
    try {
        const html = await fetchHtml(`https://duckduckgo.com/html/?q=${encodeURIComponent(query + ' youtube')}`);
        const matches = [...html.matchAll(/<a rel="nofollow" class="result-link" href="(.*?)".*?>(.*?)<\/a>/gi)];
        const out: any[] = [];
        for (const m of matches) {
            const href = m[1];
            const title = (m[2] || '').replace(/<.*?>/g, '').trim();
            const yt = href.match(/(?:v=|be\/)([A-Za-z0-9_-]{11})/);
            if (title && yt) {
                out.push(buildResult({ title, url: href, videoId: yt[1], duration: '0:00', seconds: 0, thumbnail: '', author: '' }));
                if (out.length >= limit) break;
            }
        }
        return out;
    } catch (e) {
        return [];
    }
}

export async function searchYouTube(query: string, limit = 15): Promise<any[]> {
    const strategies = [
        () => searchYtSearch(query, limit),
        () => searchInvidious(query, limit),
        () => searchInvidious(query, limit),
        () => searchInvidious(query, limit),
        () => searchInvidious(query, limit),
        () => searchPiped(query, limit),
        () => searchPiped(query, limit),
        () => searchPiped(query, limit),
        () => searchDuckDuckGo(query, limit),
    ];

    for (let i = 0; i < strategies.length; i++) {
        try {
            const result = await strategies[i]();
            if (Array.isArray(result) && result.length > 0) {
                console.log(`[SEARCH] estratégia ${i + 1} resolveu: ${query}`);
                return result.slice(0, limit);
            }
        } catch (e) { }
    }
    return [];
}

async function directYTDownload(url: string, audio: boolean): Promise<Buffer> {
    const stream = ytdl(url, { quality: audio ? 'highestaudio' : 'highestvideo', filter: audio ? 'audioonly' : 'videoandaudio' as any });
    const out = path.join(TEMP_DIR, `${audio ? 'a' : 'v'}_${Date.now()}.tmp`);
    return await new Promise((resolve, reject) => {
        ffmpeg(stream)
            .audioBitrate(audio ? 128 : undefined)
            .toFormat(audio ? 'mp3' : 'mp4')
            .on('end', () => {
                try { const buf = fs.readFileSync(out); resolve(buf); }
                catch (e) { reject(e as Error); }
            })
            .on('error', (err: Error) => reject(err))
            .save(out);
    });
}

async function getAudioFromInvidious(url: string): Promise<Buffer> {
    const videoId = ytdl.getVideoID(url);
    for (const base of INVIDIOUS) {
        try {
            const info = await axios.get(`${base}/api/v1/videos/${videoId}`, { headers: { 'User-Agent': USER_AGENT }, timeout: 15000 });
            const formats = info.data?.adaptiveFormats || info.data?.formatStreams || [];
            const candidate = formats.find((f: any) => (f.type || '').includes('audio') || (f.mimeType || '').includes('audio')) || formats[0];
            if (candidate?.url) {
                const data = await axios.get(candidate.url, { responseType: 'arraybuffer', timeout: 35000, headers: { 'User-Agent': USER_AGENT } });
                return Buffer.from(data.data);
            }
        } catch (e) { }
    }
    throw new Error('Invidious audio fallback falhou');
}

async function getAudioFromPiped(url: string): Promise<Buffer> {
    const videoId = ytdl.getVideoID(url);
    for (const base of PIPED) {
        try {
            const { data } = await axios.get(`${base}/streams/${videoId}`, { headers: { 'User-Agent': USER_AGENT }, timeout: 15000 });
            const candidate = data?.audioStreams?.find((s: any) => s?.url) || data?.audioStreams?.[0];
            if (candidate?.url) {
                const res = await axios.get(candidate.url, { responseType: 'arraybuffer', timeout: 35000, headers: { 'User-Agent': USER_AGENT } });
                return Buffer.from(res.data);
            }
        } catch (e) { }
    }
    throw new Error('Piped audio fallback falhou');
}

async function getAudioFromCobalt(url: string): Promise<Buffer> {
    const videoId = ytdl.getVideoID(url);
    for (const host of COBALT) {
        try {
            const request = host.includes('/api/json')
                ? `${host}?url=${encodeURIComponent(url)}&vQuality=720p&format=mp3&aFormat=mp3`
                : `${host}api/json?url=${encodeURIComponent(url)}&vQuality=720p&format=mp3&aFormat=mp3`;
            const { data } = await axios.get(request, { headers: { 'User-Agent': USER_AGENT }, timeout: 20000 });
            const dl = data?.url || data?.streamUrl || data?.output?.url || (data?.url && data.url[0]);
            if (dl && typeof dl === 'string') {
                const res = await axios.get(dl, { responseType: 'arraybuffer', timeout: 35000, headers: { 'User-Agent': USER_AGENT } });
                return Buffer.from(res.data);
            }
        } catch (e) { }
    }
    throw new Error('Cobalt audio fallback falhou');
}

async function getVideoFromInvidious(url: string): Promise<Buffer> {
    const videoId = ytdl.getVideoID(url);
    for (const base of INVIDIOUS) {
        try {
            const info = await axios.get(`${base}/api/v1/videos/${videoId}`, { headers: { 'User-Agent': USER_AGENT }, timeout: 15000 });
            const formats = info.data?.formatStreams || [];
            const cand = formats.find((f: any) => (f.type || '').includes('video') && f.url) || formats[0];
            if (cand?.url) {
                const res = await axios.get(cand.url, { responseType: 'arraybuffer', timeout: 35000, headers: { 'User-Agent': USER_AGENT } });
                return Buffer.from(res.data);
            }
        } catch (e) { }
    }
    throw new Error('Invidious video fallback falhou');
}

async function getVideoFromPiped(url: string): Promise<Buffer> {
    const videoId = ytdl.getVideoID(url);
    for (const base of PIPED) {
        try {
            const { data } = await axios.get(`${base}/streams/${videoId}`, { headers: { 'User-Agent': USER_AGENT }, timeout: 15000 });
            const candidate = data?.videoStreams?.find((s: any) => s?.url) || data?.videoStreams?.[0];
            if (candidate?.url) {
                const res = await axios.get(candidate.url, { responseType: 'arraybuffer', timeout: 35000, headers: { 'User-Agent': USER_AGENT } });
                return Buffer.from(res.data);
            }
        } catch (e) { }
    }
    throw new Error('Piped video fallback falhou');
}

async function getVideoFromCobalt(url: string): Promise<Buffer> {
    for (const host of COBALT) {
        try {
            const request = host.includes('/api/json')
                ? `${host}?url=${encodeURIComponent(url)}&vQuality=720p&format=mp4&aFormat=mp3`
                : `${host}api/json?url=${encodeURIComponent(url)}&vQuality=720p&format=mp4&aFormat=mp3`;
            const { data } = await axios.get(request, { headers: { 'User-Agent': USER_AGENT }, timeout: 20000 });
            const dl = data?.url || data?.streamUrl || data?.output?.url || (data?.url && data.url[0]);
            if (dl && typeof dl === 'string') {
                const res = await axios.get(dl, { responseType: 'arraybuffer', timeout: 35000, headers: { 'User-Agent': USER_AGENT } });
                return Buffer.from(res.data);
            }
        } catch (e) { }
    }
    throw new Error('Cobalt video fallback falhou');
}

function makeTempPath(prefix: string): string { return path.join(TEMP_DIR, `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}.bin`); }

export async function downloadAudio(url: string): Promise<string> {
    const outPath = makeTempPath('a');
    const stream = ytdl(url, { quality: 'highestaudio', filter: 'audioonly' });
    await new Promise<void>((resolve, reject) => {
        ffmpeg(stream)
            .audioBitrate(128)
            .toFormat('mp3')
            .on('end', () => resolve())
            .on('error', (err: Error) => reject(err))
            .save(outPath);
    });
    return outPath;
}

export async function downloadVideo(url: string): Promise<string> {
    const outPath = makeTempPath('v');
    const stream = ytdl(url, { quality: 'highestvideo' });
    await new Promise<void>((resolve, reject) => {
        ffmpeg(stream)
            .videoCodec('libx264')
            .audioCodec('aac')
            .format('mp4')
            .on('end', () => resolve())
            .on('error', (err: Error) => reject(err))
            .save(outPath);
    });
    return outPath;
}

export async function getAudioBuffer(url: string): Promise<Buffer> {
    const strategies = [
        { name: 'ytdl', fn: async () => { const fp = await downloadAudio(url); const buf = fs.readFileSync(fp); fs.unlinkSync(fp); return buf; } },
        { name: 'invidious_1', fn: async () => getAudioFromInvidious(url) },
        { name: 'invidious_2', fn: async () => getAudioFromInvidious(url) },
        { name: 'invidious_3', fn: async () => getAudioFromInvidious(url) },
        { name: 'invidious_4', fn: async () => getAudioFromInvidious(url) },
        { name: 'piped_1', fn: async () => getAudioFromPiped(url) },
        { name: 'piped_2', fn: async () => getAudioFromPiped(url) },
        { name: 'piped_3', fn: async () => getAudioFromPiped(url) },
        { name: 'cobalt_1', fn: async () => getAudioFromCobalt(url) },
        { name: 'cobalt_2', fn: async () => getAudioFromCobalt(url) },
        { name: 'cobalt_3', fn: async () => getAudioFromCobalt(url) },
        { name: 'invidious_direct_1', fn: async () => getAudioFromInvidious(url) },
        { name: 'piped_direct_1', fn: async () => getAudioFromPiped(url) },
        { name: 'cobalt_direct_1', fn: async () => getAudioFromCobalt(url) },
        { name: 'ytdl_fallback', fn: async () => { const fp = await downloadAudio(url); const buf = fs.readFileSync(fp); fs.unlinkSync(fp); return buf; } }
    ];
    for (const s of strategies) {
        try {
            const buffer = await s.fn();
            if (buffer && buffer.length > 1000) {
                console.log('[AUDIO] estratégia usada:', s.name);
                return buffer;
            }
        } catch (e) { }
    }
    throw new Error('Nenhuma estratégia de áudio funcionou');
}

export async function getVideoBuffer(url: string): Promise<Buffer> {
    const strategies = [
        { name: 'ytdl', fn: async () => { const fp = await downloadVideo(url); const buf = fs.readFileSync(fp); fs.unlinkSync(fp); return buf; } },
        { name: 'invidious_1', fn: async () => getVideoFromInvidious(url) },
        { name: 'invidious_2', fn: async () => getVideoFromInvidious(url) },
        { name: 'invidious_3', fn: async () => getVideoFromInvidious(url) },
        { name: 'invidious_4', fn: async () => getVideoFromInvidious(url) },
        { name: 'piped_1', fn: async () => getVideoFromPiped(url) },
        { name: 'piped_2', fn: async () => getVideoFromPiped(url) },
        { name: 'piped_3', fn: async () => getVideoFromPiped(url) },
        { name: 'cobalt_1', fn: async () => getVideoFromCobalt(url) },
        { name: 'cobalt_2', fn: async () => getVideoFromCobalt(url) },
        { name: 'cobalt_3', fn: async () => getVideoFromCobalt(url) },
        { name: 'itag_22', fn: async () => { const id = ytdl.getVideoID(url); const stream = ytdl(url, { quality: '18' }); const fp = makeTempPath('v22'); await new Promise<void>((resolve, reject) => { ffmpeg(stream).format('mp4').on('end', () => resolve()).on('error', (err: Error) => reject(err)).save(fp); }); const buf = fs.readFileSync(fp); fs.unlinkSync(fp); return buf; } },
        { name: 'itag_18', fn: async () => { const stream = ytdl(url, { quality: '18' }); const fp = makeTempPath('v18'); await new Promise<void>((resolve, reject) => { ffmpeg(stream).format('mp4').on('end', () => resolve()).on('error', (err: Error) => reject(err)).save(fp); }); const buf = fs.readFileSync(fp); fs.unlinkSync(fp); return buf; } },
        { name: 'itag_136', fn: async () => { const stream = ytdl(url, { quality: '136' }); const fp = makeTempPath('v136'); await new Promise<void>((resolve, reject) => { ffmpeg(stream).format('mp4').on('end', () => resolve()).on('error', (err: Error) => reject(err)).save(fp); }); const buf = fs.readFileSync(fp); fs.unlinkSync(fp); return buf; } },
        { name: 'itag_137', fn: async () => { const stream = ytdl(url, { quality: '137' }); const fp = makeTempPath('v137'); await new Promise<void>((resolve, reject) => { ffmpeg(stream).format('mp4').on('end', () => resolve()).on('error', (err: Error) => reject(err)).save(fp); }); const buf = fs.readFileSync(fp); fs.unlinkSync(fp); return buf; } },
        { name: 'ytdl_fallback', fn: async () => { const fp = await downloadVideo(url); const buf = fs.readFileSync(fp); fs.unlinkSync(fp); return buf; } }
    ];
    for (const s of strategies) {
        try {
            const buffer = await s.fn();
            if (buffer && buffer.length > 1000) {
                console.log('[VIDEO] estratégia usada:', s.name);
                return buffer;
            }
        } catch (e) { }
    }
    throw new Error('Nenhuma estratégia de vídeo funcionou');
}

