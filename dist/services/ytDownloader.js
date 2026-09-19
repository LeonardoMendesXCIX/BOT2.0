"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.YtDlpError = void 0;
exports.searchYouTube = searchYouTube;
exports.getAudioBuffer = getAudioBuffer;
exports.getVideoBuffer = getVideoBuffer;
exports.downloadAudio = downloadAudio;
exports.downloadVideo = downloadVideo;
const yt_search_1 = __importDefault(require("yt-search"));
const ytdl_core_1 = __importDefault(require("@distube/ytdl-core"));
const fluent_ffmpeg_1 = __importDefault(require("fluent-ffmpeg"));
const ffmpeg_static_1 = __importDefault(require("ffmpeg-static"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const axios_1 = __importDefault(require("axios"));
const child_process_1 = require("child_process");
fluent_ffmpeg_1.default.setFfmpegPath(ffmpeg_static_1.default || 'ffmpeg');
const TEMP_DIR = path_1.default.join(__dirname, '..', '..', 'temp');
if (!fs_1.default.existsSync(TEMP_DIR))
    fs_1.default.mkdirSync(TEMP_DIR, { recursive: true });
setInterval(() => {
    const now = Date.now();
    try {
        fs_1.default.readdirSync(TEMP_DIR).forEach(f => {
            try {
                const fp = path_1.default.join(TEMP_DIR, f);
                if (now - fs_1.default.statSync(fp).mtimeMs > 10 * 60 * 1000)
                    fs_1.default.unlinkSync(fp);
            }
            catch (e) { }
        });
    }
    catch (e) { }
}, 5 * 60 * 1000);
async function tryStrategies(name, strategies) {
    let lastError = 'todas as estratégias falharam';
    let firstDetailedError;
    for (let i = 0; i < strategies.length; i++) {
        try {
            const r = await strategies[i]();
            if (r.success && r.data) {
                console.log('[YT ' + name + '] ✅ estratégia ' + (i + 1) + '/' + strategies.length + ': ' + r.strategyName);
                return r.data;
            }
            if (r.error instanceof Error && !firstDetailedError)
                firstDetailedError = r.error;
            lastError = r.error || 'falha';
        }
        catch (e) {
            lastError = e instanceof Error ? e : (e?.message || 'erro');
            if (e instanceof Error && !firstDetailedError)
                firstDetailedError = e;
        }
    }
    if (firstDetailedError)
        throw firstDetailedError;
    if (lastError instanceof Error)
        throw lastError;
    throw new Error(name + ': ' + lastError);
}
const INVIDIOUS = ['https://yewtu.be', 'https://vid.puffyan.us', 'https://invidious.privacyredirect.com', 'https://inv.nadeko.net'];
const PIPED = ['https://pipedapi.kavin.rocks', 'https://pipedapi.adminforge.de', 'https://api.piped.private.coffee'];
// ============ BUSCA (10 estratégias) ============
async function searchYouTube(query, limit = 15) {
    const mapYts = (r) => r.videos.slice(0, limit).map((v) => ({
        title: v.title, url: v.url, videoId: v.videoId,
        duration: v.duration?.timestamp || '?:??', seconds: v.seconds || 0,
        thumbnail: v.thumbnail || '', author: v.author?.name || ''
    }));
    const strategies = [
        async () => { const r = await (0, yt_search_1.default)({ query, pages: 1 }); return { success: r.videos.length > 0, data: mapYts(r), strategyName: 'yt-search' }; },
        async () => { const r = await (0, yt_search_1.default)({ query, pages: 2 }); return { success: r.videos.length > 0, data: mapYts(r), strategyName: 'yt-search 2p' }; },
        ...INVIDIOUS.map(inst => async () => {
            const res = await axios_1.default.get(inst + '/api/v1/search', { params: { q: query, type: 'video' }, timeout: 8000 });
            const items = (res.data || []).slice(0, limit);
            return { success: items.length > 0, data: items.map((v) => ({ title: v.title, url: 'https://www.youtube.com/watch?v=' + v.videoId, videoId: v.videoId, duration: Math.floor((v.lengthSeconds || 0) / 60) + ':' + String((v.lengthSeconds || 0) % 60).padStart(2, '0'), seconds: v.lengthSeconds || 0, thumbnail: v.videoThumbnails?.[0]?.url || '', author: v.author || '' })), strategyName: 'Invidious ' + inst };
        }),
        ...PIPED.map(inst => async () => {
            const res = await axios_1.default.get(inst + '/search', { params: { q: query, filter: 'videos' }, timeout: 8000 });
            const items = (res.data?.items || []).slice(0, limit);
            return { success: items.length > 0, data: items.map((v) => ({ title: v.title, url: 'https://www.youtube.com' + (v.url || ''), videoId: (v.url || '').replace('/watch?v=', ''), duration: Math.floor((v.duration || 0) / 60) + ':' + String((v.duration || 0) % 60).padStart(2, '0'), seconds: v.duration || 0, thumbnail: v.thumbnail || '', author: v.uploaderName || '' })), strategyName: 'Piped ' + inst };
        }),
        async () => {
            const res = await axios_1.default.get('https://html.duckduckgo.com/html/', { params: { q: query + ' youtube' }, timeout: 6000, headers: { 'User-Agent': 'Mozilla/5.0' } });
            const m = String(res.data).match(/v=([a-zA-Z0-9_-]{11})/);
            if (!m)
                return { success: false, strategyName: 'DuckDuckGo' };
            return { success: true, data: [{ title: query, url: 'https://www.youtube.com/watch?v=' + m[1], videoId: m[1], duration: '?:??', seconds: 0, thumbnail: '', author: 'YouTube' }], strategyName: 'DuckDuckGo' };
        }
    ];
    return tryStrategies('BUSCA', strategies);
}
// ============ HELPERS ============
async function ytBuf(url, opts, name) {
    try {
        const chunks = [];
        await new Promise((res, rej) => {
            (0, ytdl_core_1.default)(url, opts).on('data', c => chunks.push(c)).on('end', () => res()).on('error', rej);
        });
        const buf = Buffer.concat(chunks);
        return buf.length > 5000 ? { success: true, data: buf, strategyName: name } : { success: false, strategyName: name, error: 'muito pequeno' };
    }
    catch (e) {
        return { success: false, strategyName: name, error: e.message };
    }
}
async function toMp3(input, bitrate) {
    const inP = path_1.default.join(TEMP_DIR, 'in_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
    const outP = inP + '.mp3';
    fs_1.default.writeFileSync(inP, input);
    try {
        await new Promise((res, rej) => (0, fluent_ffmpeg_1.default)(inP).audioCodec('libmp3lame').audioBitrate(bitrate).toFormat('mp3').on('end', () => res()).on('error', rej).save(outP));
        return fs_1.default.readFileSync(outP);
    }
    finally {
        try {
            fs_1.default.unlinkSync(inP);
        }
        catch (e) { }
        try {
            fs_1.default.unlinkSync(outP);
        }
        catch (e) { }
    }
}
class YtDlpError extends Error {
    stderr;
    exitCode;
    timedOut;
    constructor(message, stderr = '', exitCode = null, timedOut = false) {
        super(message);
        this.stderr = stderr;
        this.exitCode = exitCode;
        this.timedOut = timedOut;
        this.name = 'YtDlpError';
        Object.setPrototypeOf(this, YtDlpError.prototype);
    }
}
exports.YtDlpError = YtDlpError;
function downloadWithYtDlp(url) {
    return new Promise((resolve, reject) => {
        const command = process.env.YT_DLP_PATH || 'yt-dlp';
        const args = [
            '-x', '--audio-format', 'mp3', '--no-playlist',
            '--no-check-certificate',
            '--extractor-args', 'youtube:player-client=web,default',
            '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            '--no-warnings', '--socket-timeout', '30', '-o', '-', '--', url
        ];
        console.log('[YT yt-dlp] iniciando download:', url);
        const child = (0, child_process_1.spawn)(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const chunks = [];
        let stderr = '';
        let settled = false;
        const timeout = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            child.kill('SIGKILL');
            const detail = stderr.trim().replace(/\s+/g, ' ').slice(-1000);
            console.error('[YT yt-dlp] timeout após 60 segundos:', detail || 'sem stderr');
            reject(new YtDlpError('timeout do yt-dlp após 60 segundos' + (detail ? ': ' + detail : ''), stderr, null, true));
        }, 60000);
        child.stdout.on('data', chunk => chunks.push(Buffer.from(chunk)));
        child.stderr.on('data', chunk => { stderr += String(chunk); });
        child.once('error', error => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            const message = 'falha ao iniciar yt-dlp: ' + error.message;
            console.error('[YT yt-dlp] ' + message);
            reject(new YtDlpError(message, stderr));
        });
        child.once('close', code => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            const output = Buffer.concat(chunks);
            if (code === 0 && output.length > 5000) {
                console.log('[YT yt-dlp] download concluído:', output.length, 'bytes');
                resolve(output);
                return;
            }
            const detail = stderr.trim().replace(/\s+/g, ' ').slice(-1000) || 'saída vazia';
            console.error('[YT yt-dlp] falhou (code=' + code + '):', detail);
            reject(new YtDlpError('yt-dlp falhou: ' + detail, stderr, code));
        });
    });
}
async function invidiousStream(url, inst, kind) {
    try {
        const id = ytdl_core_1.default.getVideoID(url);
        const api = await axios_1.default.get(inst + '/api/v1/videos/' + id, { timeout: 10000 });
        const list = kind === 'audio' ? (api.data?.adaptiveFormats || []).filter((f) => (f.type || '').startsWith('audio/')) : (api.data?.formatStreams || []);
        const chosen = list[0];
        if (!chosen?.url)
            return { success: false, strategyName: 'Invidious ' + kind + ' ' + inst, error: 'sem url' };
        const dl = await axios_1.default.get(chosen.url, { responseType: 'arraybuffer', timeout: 60000 });
        return { success: true, data: Buffer.from(dl.data), strategyName: 'Invidious ' + kind + ' ' + inst };
    }
    catch (e) {
        return { success: false, strategyName: 'Invidious ' + kind + ' ' + inst, error: e.message };
    }
}
async function pipedStream(url, inst, kind) {
    try {
        const id = ytdl_core_1.default.getVideoID(url);
        const api = await axios_1.default.get(inst + '/streams/' + id, { timeout: 10000 });
        const list = kind === 'audio' ? (api.data?.audioStreams || []) : (api.data?.videoStreams || []);
        const chosen = list[0];
        if (!chosen?.url)
            return { success: false, strategyName: 'Piped ' + kind + ' ' + inst, error: 'sem url' };
        const dl = await axios_1.default.get(chosen.url, { responseType: 'arraybuffer', timeout: 60000 });
        return { success: true, data: Buffer.from(dl.data), strategyName: 'Piped ' + kind + ' ' + inst };
    }
    catch (e) {
        return { success: false, strategyName: 'Piped ' + kind + ' ' + inst, error: e.message };
    }
}
async function cobalt(url, audio) {
    try {
        const res = await axios_1.default.post('https://api.cobalt.tools/api/json', { url, isAudioOnly: audio }, { headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, timeout: 15000 });
        if (!res.data?.url)
            return { success: false, strategyName: 'Cobalt', error: 'sem url' };
        const dl = await axios_1.default.get(res.data.url, { responseType: 'arraybuffer', timeout: 60000 });
        return { success: true, data: Buffer.from(dl.data), strategyName: 'Cobalt' };
    }
    catch (e) {
        return { success: false, strategyName: 'Cobalt', error: e.message };
    }
}
// ============ ÁUDIO (15 estratégias) ============
async function getAudioBuffer(url) {
    const strategies = [
        async () => {
            try {
                return { success: true, data: await downloadWithYtDlp(url), strategyName: 'yt-dlp stdout mp3' };
            }
            catch (e) {
                return { success: false, strategyName: 'yt-dlp stdout mp3', error: e instanceof Error ? e : new Error(e?.message || 'erro desconhecido') };
            }
        },
        async () => { const r = await ytBuf(url, { quality: 'highestaudio', filter: 'audioonly' }, 'ytdl high'); if (!r.data)
            return r; try {
            return { success: true, data: await toMp3(r.data, '192'), strategyName: 'ytdl high+mp3 192k' };
        }
        catch (e) {
            return { success: false, strategyName: 'ytdl high+mp3', error: e.message };
        } },
        async () => { const r = await ytBuf(url, { quality: 'highestaudio', filter: 'audioonly' }, 'ytdl high'); if (!r.data)
            return r; try {
            return { success: true, data: await toMp3(r.data, '128'), strategyName: 'ytdl high+mp3 128k' };
        }
        catch (e) {
            return { success: false, strategyName: 'ytdl high+mp3 128', error: e.message };
        } },
        async () => { const r = await ytBuf(url, { quality: 'highestaudio', filter: 'audioonly' }, 'ytdl high'); if (!r.data)
            return r; try {
            return { success: true, data: await toMp3(r.data, '96'), strategyName: 'ytdl high+mp3 96k' };
        }
        catch (e) {
            return { success: false, strategyName: 'ytdl high+mp3 96', error: e.message };
        } },
        async () => { const r = await ytBuf(url, { quality: 'lowestaudio', filter: 'audioonly' }, 'ytdl low'); if (!r.data)
            return r; try {
            return { success: true, data: await toMp3(r.data, '128'), strategyName: 'ytdl low+mp3' };
        }
        catch (e) {
            return { success: false, strategyName: 'ytdl low+mp3', error: e.message };
        } },
        ...INVIDIOUS.map(inst => async () => { const r = await invidiousStream(url, inst, 'audio'); if (!r.data)
            return r; try {
            return { success: true, data: await toMp3(r.data, '128'), strategyName: 'Invidious a ' + inst };
        }
        catch (e) {
            return { success: false, strategyName: 'Invidious a ' + inst, error: e.message };
        } }),
        ...PIPED.map(inst => async () => { const r = await pipedStream(url, inst, 'audio'); if (!r.data)
            return r; try {
            return { success: true, data: await toMp3(r.data, '128'), strategyName: 'Piped a ' + inst };
        }
        catch (e) {
            return { success: false, strategyName: 'Piped a ' + inst, error: e.message };
        } }),
        async () => cobalt(url, true),
        async () => ytBuf(url, { quality: 'highestaudio', filter: 'audioonly' }, 'ytdl direto (sem conversão)')
    ];
    return tryStrategies('AUDIO', strategies);
}
// ============ VÍDEO (15 estratégias) ============
async function getVideoBuffer(url) {
    const strategies = [
        async () => ytBuf(url, { quality: 'highest', filter: 'videoandaudio' }, 'ytdl highest'),
        async () => ytBuf(url, { quality: 'highestvideo', filter: 'videoandaudio' }, 'ytdl highestvideo'),
        async () => ytBuf(url, { filter: (f) => f.container === 'mp4' && f.hasVideo && f.hasAudio }, 'ytdl mp4+a'),
        async () => ytBuf(url, { quality: 'lowest', filter: 'videoandaudio' }, 'ytdl lowest'),
        async () => { const info = await ytdl_core_1.default.getInfo(url); const f = info.formats.find(x => x.qualityLabel === '360p' && x.hasVideo && x.hasAudio); return f ? ytBuf(url, { quality: f.itag }, 'ytdl itag 360p') : { success: false, strategyName: 'itag 360p', error: 'sem formato' }; },
        async () => { const info = await ytdl_core_1.default.getInfo(url); const f = info.formats.find(x => x.qualityLabel === '480p' && x.hasVideo && x.hasAudio); return f ? ytBuf(url, { quality: f.itag }, 'ytdl itag 480p') : { success: false, strategyName: 'itag 480p', error: 'sem formato' }; },
        ...INVIDIOUS.map(inst => async () => invidiousStream(url, inst, 'video')),
        ...PIPED.map(inst => async () => pipedStream(url, inst, 'video')),
        async () => cobalt(url, false),
        async () => ytBuf(url, { quality: 'lowestvideo', filter: 'videoandaudio' }, 'ytdl lowestvideo')
    ];
    return tryStrategies('VIDEO', strategies);
}
// ============ WRAPPERS DE COMPATIBILIDADE ==========
async function downloadAudio(url) {
    const buf = await getAudioBuffer(url);
    const p = path_1.default.join(TEMP_DIR, 'a_' + Date.now() + '.mp3');
    fs_1.default.writeFileSync(p, buf);
    return p;
}
async function downloadVideo(url) {
    const buf = await getVideoBuffer(url);
    const p = path_1.default.join(TEMP_DIR, 'v_' + Date.now() + '.mp4');
    fs_1.default.writeFileSync(p, buf);
    return p;
}
