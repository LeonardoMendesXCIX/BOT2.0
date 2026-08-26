import axios from 'axios';
import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';

const execPromise = util.promisify(exec);

export interface MusicSearchItem {
    id: number;
    videoId: string;
    title: string;
    artist: string;
    duration: string;
    thumbnail: string;
    url: string;
}

export interface MusicResult {
    title: string;
    artist: string;
    duration: string;
    buffer: Buffer;
    thumbnail: Buffer | null;
    url: string;
}

const MEDIA_DIR = path.join(__dirname, '..', '..', 'tmp-media');
if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

// 1. Busca Direta Oficial do YouTube (Scraper Nativo 100% Preciso)
export async function searchYouTubeDirect(query: string, limit = 10): Promise<MusicSearchItem[]> {
    try {
        const encoded = encodeURIComponent(query.trim());
        const url = `https://www.youtube.com/results?search_query=${encoded}`;
        const res = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
            },
            timeout: 12000
        });

        const html = res.data;
        let match = html.match(/var ytInitialData = ({.*?});<\/script>/);
        if (!match) match = html.match(/window\["ytInitialData"\] = ({.*?});<\/script>/);
        if (!match) match = html.match(/ytInitialData\s*=\s*({.+?});/);

        if (match) {
            const data = JSON.parse(match[1]);
            const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
            const videos: MusicSearchItem[] = [];

            for (const section of contents) {
                const items = section?.itemSectionRenderer?.contents || [];
                for (const item of items) {
                    const v = item?.videoRenderer;
                    if (v && v.videoId) {
                        const videoId = v.videoId;
                        const title = v.title?.runs?.[0]?.text || 'Música';
                        const author = v.ownerText?.runs?.[0]?.text || 'YouTube Music';
                        const duration = v.lengthText?.simpleText || '3:00';
                        const thumb = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

                        videos.push({
                            id: videos.length + 1,
                            videoId,
                            title,
                            artist: author,
                            duration,
                            thumbnail: thumb,
                            url: `https://www.youtube.com/watch?v=${videoId}`
                        });

                        if (videos.length === limit) break;
                    }
                }
                if (videos.length === limit) break;
            }

            if (videos.length > 0) return videos;
        }
    } catch (e: any) {
        console.error('[ERRO BUSCA YOUTUBE DIRETO]', e.message);
    }
    return [];
}

export async function searchMusicList(query: string, limit = 10): Promise<MusicSearchItem[]> {
    if (!query) return [];
    return searchYouTubeDirect(query, limit);
}

// 2. Localização Automática de Binários (bin/ local, raiz ou PATH)
function getBinaryCommands() {
    const rootDir = path.join(__dirname, '..', '..');
    const binDir = path.join(rootDir, 'bin');

    let ytDlpCmd = 'yt-dlp';
    if (fs.existsSync(path.join(binDir, 'yt-dlp.exe'))) {
        ytDlpCmd = `"${path.join(binDir, 'yt-dlp.exe')}"`;
    } else if (fs.existsSync(path.join(rootDir, 'yt-dlp.exe'))) {
        ytDlpCmd = `"${path.join(rootDir, 'yt-dlp.exe')}"`;
    }

    let ffmpegParam = '';
    if (fs.existsSync(path.join(binDir, 'ffmpeg.exe'))) {
        ffmpegParam = `--ffmpeg-location "${binDir}"`;
    } else if (fs.existsSync(path.join(rootDir, 'ffmpeg.exe'))) {
        ffmpegParam = `--ffmpeg-location "${rootDir}"`;
    }

    return { ytDlpCmd, ffmpegParam };
}

// 3. Matriz de 20 Tentativas Sucessivas de Download
export async function downloadMusicById(
    videoId: string, 
    titleHint = 'Música', 
    artistHint = 'Artista', 
    durationHint = '3:00',
    urlHint = ''
): Promise<MusicResult | null> {
    if (!videoId) return null;
    const videoUrl = urlHint || `https://www.youtube.com/watch?v=${videoId}`;
    let title = titleHint;
    let artist = artistHint;
    let duration = durationHint;

    // Baixa Thumbnail para capa
    let thumbBuffer: Buffer | null = null;
    try {
        const thumbUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
        const thumbRes = await axios.get(thumbUrl, { responseType: 'arraybuffer', timeout: 5000 });
        if (thumbRes.data) thumbBuffer = Buffer.from(thumbRes.data);
    } catch (e) {}

    const { ytDlpCmd, ffmpegParam } = getBinaryCommands();
    const tempFileBase = path.join(MEDIA_DIR, `media_${Date.now()}_${Math.floor(Math.random() * 1000)}`);

    const MAX_RETRIES = 20;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        console.log(`[MUSICA] Executando tentativa ${attempt}/${MAX_RETRIES} para "${title}"...`);

        try {
            // TENTATIVAS 1 A 7: yt-dlp Local com Diferentes Estratégias e Clientes Mobile/Web
            if (attempt === 1) {
                const cmd = `${ytDlpCmd} ${ffmpegParam} --no-check-certificates --no-warnings --extractor-args "youtube:player_client=android,web" -x --audio-format mp3 --audio-quality 0 -o "${tempFileBase}.%(ext)s" "${videoUrl}"`;
                await execPromise(cmd, { timeout: 45000, windowsHide: true });
            } else if (attempt === 2) {
                const cmd = `${ytDlpCmd} --no-check-certificates --no-warnings --extractor-args "youtube:player_client=ios,mweb" -f "ba[ext=m4a]/ba/best" -o "${tempFileBase}.%(ext)s" "${videoUrl}"`;
                await execPromise(cmd, { timeout: 45000, windowsHide: true });
            } else if (attempt === 3) {
                const cmd = `${ytDlpCmd} ${ffmpegParam} --no-check-certificates --no-warnings --extractor-args "youtube:player_client=tv_embedded,web_creator" -x --audio-format mp3 -o "${tempFileBase}.%(ext)s" "${videoUrl}"`;
                await execPromise(cmd, { timeout: 45000, windowsHide: true });
            } else if (attempt === 4) {
                const cmd = `${ytDlpCmd} --no-check-certificates --no-warnings --extractor-args "youtube:player_client=android_creator,mweb" -f "ba/best" -o "${tempFileBase}.%(ext)s" "${videoUrl}"`;
                await execPromise(cmd, { timeout: 45000, windowsHide: true });
            } else if (attempt === 5) {
                const cmd = `${ytDlpCmd} --no-check-certificates --no-warnings --extractor-args "youtube:player_client=ios" -f "ba" -o "${tempFileBase}.%(ext)s" "${videoUrl}"`;
                await execPromise(cmd, { timeout: 45000, windowsHide: true });
            } else if (attempt === 6) {
                const cmd = `${ytDlpCmd} ${ffmpegParam} --no-check-certificates --no-warnings --extract-audio --audio-format m4a -o "${tempFileBase}.%(ext)s" "${videoUrl}"`;
                await execPromise(cmd, { timeout: 45000, windowsHide: true });
            } else if (attempt === 7) {
                const cmd = `${ytDlpCmd} --no-check-certificates --no-warnings -f "bestaudio" -o "${tempFileBase}.%(ext)s" "${videoUrl}"`;
                await execPromise(cmd, { timeout: 45000, windowsHide: true });
            }

            // Se for tentativa local 1 a 7, checa se o arquivo foi criado em tmp-media
            if (attempt >= 1 && attempt <= 7) {
                const found = fs.readdirSync(MEDIA_DIR).find(f => f.startsWith(path.basename(tempFileBase)));
                if (found) {
                    const finalPath = path.join(MEDIA_DIR, found);
                    const buf = fs.readFileSync(finalPath);
                    try { fs.unlinkSync(finalPath); } catch (e) {}
                    if (buf && buf.byteLength > 10000) {
                        console.log(`[MUSICA SUCESSO] Áudio obtido na tentativa ${attempt}/${MAX_RETRIES} (${buf.byteLength} bytes).`);
                        return { title, artist, duration, buffer: buf, thumbnail: thumbBuffer, url: videoUrl };
                    }
                }
            }

            // TENTATIVAS 8 A 12: Extração Direta Google CDN via InnerTube (Clientes Mobile Nativos)
            const innertubeClients: Record<number, any> = {
                8: { clientName: 'ANDROID_TESTSUITE', clientVersion: '1.9', androidSdkVersion: 30 },
                9: { clientName: 'ANDROID', clientVersion: '19.09.37', androidSdkVersion: 30 },
                10: { clientName: 'IOS', clientVersion: '19.09.3', deviceModel: 'iPhone14,3' },
                11: { clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', clientVersion: '2.0' },
                12: { clientName: 'MWEB', clientVersion: '2.20240301.01.00' }
            };

            if (attempt >= 8 && attempt <= 12) {
                const clientConfig = innertubeClients[attempt];
                const res = await axios.post('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
                    context: {
                        client: {
                            ...clientConfig,
                            hl: 'pt-BR',
                            gl: 'BR'
                        }
                    },
                    videoId: videoId
                }, {
                    headers: {
                        'Content-Type': 'application/json',
                        'User-Agent': 'com.google.android.youtube/19.09.37 (Linux; U; Android 11)'
                    },
                    timeout: 10000
                });

                const formats = res.data?.streamingData?.adaptiveFormats || [];
                const audioFormat = formats.find((f: any) => f.itag === 140 && f.url) || 
                                    formats.find((f: any) => f.mimeType?.startsWith('audio/') && f.url);

                if (audioFormat && audioFormat.url) {
                    const streamRes = await axios.get(audioFormat.url, {
                        responseType: 'arraybuffer',
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
                        timeout: 35000
                    });

                    if (streamRes.data && streamRes.data.byteLength > 10000) {
                        console.log(`[MUSICA SUCESSO] Áudio obtido na tentativa ${attempt}/${MAX_RETRIES} (${streamRes.data.byteLength} bytes).`);
                        return { title, artist, duration, buffer: Buffer.from(streamRes.data), thumbnail: thumbBuffer, url: videoUrl };
                    }
                }
            }

            // TENTATIVAS 13 A 16: APIs de Download em Nuvem
            if (attempt === 13) {
                const veviozRes = await axios.get(`https://api.vevioz.com/api/button/mp3/${videoId}`, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
                    timeout: 10000
                });
                const matchHref = veviozRes.data?.match(/href="(https?:\/\/[^"]+download[^"]*)"/i);
                if (matchHref) {
                    const fileRes = await axios.get(matchHref[1], { responseType: 'arraybuffer', timeout: 35000 });
                    if (fileRes.data && fileRes.data.byteLength > 10000) {
                        console.log(`[MUSICA SUCESSO] Áudio obtido na tentativa ${attempt}/${MAX_RETRIES} (${fileRes.data.byteLength} bytes).`);
                        return { title, artist, duration, buffer: Buffer.from(fileRes.data), thumbnail: thumbBuffer, url: videoUrl };
                    }
                }
            }

            if (attempt === 14) {
                const bkRes = await axios.get(`https://bk9.fun/download/youtube?url=${encodeURIComponent(videoUrl)}`, { timeout: 15000 });
                const dl = bkRes.data?.BK9?.url || bkRes.data?.result?.download?.url;
                if (dl && typeof dl === 'string' && dl.startsWith('http')) {
                    const streamRes = await axios.get(dl, { responseType: 'arraybuffer', timeout: 35000 });
                    if (streamRes.data && streamRes.data.byteLength > 10000) {
                        console.log(`[MUSICA SUCESSO] Áudio obtido na tentativa ${attempt}/${MAX_RETRIES} (${streamRes.data.byteLength} bytes).`);
                        return { title, artist, duration, buffer: Buffer.from(streamRes.data), thumbnail: thumbBuffer, url: videoUrl };
                    }
                }
            }

            if (attempt === 15) {
                const vrRes = await axios.get(`https://api.vreden.my.id/api/ytmp3?url=${encodeURIComponent(videoUrl)}`, { timeout: 15000 });
                const dl = vrRes.data?.result?.download?.url || vrRes.data?.result?.url;
                if (dl && typeof dl === 'string' && dl.startsWith('http')) {
                    const streamRes = await axios.get(dl, { responseType: 'arraybuffer', timeout: 35000 });
                    if (streamRes.data && streamRes.data.byteLength > 10000) {
                        console.log(`[MUSICA SUCESSO] Áudio obtido na tentativa ${attempt}/${MAX_RETRIES} (${streamRes.data.byteLength} bytes).`);
                        return { title, artist, duration, buffer: Buffer.from(streamRes.data), thumbnail: thumbBuffer, url: videoUrl };
                    }
                }
            }

            if (attempt === 16) {
                const wdRes = await axios.get(`https://widipe.com/download/ytdl?url=${encodeURIComponent(videoUrl)}`, { timeout: 15000 });
                const dl = wdRes.data?.result?.dl || wdRes.data?.result?.url;
                if (dl && typeof dl === 'string' && dl.startsWith('http')) {
                    const streamRes = await axios.get(dl, { responseType: 'arraybuffer', timeout: 35000 });
                    if (streamRes.data && streamRes.data.byteLength > 10000) {
                        console.log(`[MUSICA SUCESSO] Áudio obtido na tentativa ${attempt}/${MAX_RETRIES} (${streamRes.data.byteLength} bytes).`);
                        return { title, artist, duration, buffer: Buffer.from(streamRes.data), thumbnail: thumbBuffer, url: videoUrl };
                    }
                }
            }

            // TENTATIVAS 17 A 20: Instâncias Invidious com Streaming Proxy itag 140
            const invidiousInstances: Record<number, string> = {
                17: 'https://inv.thepixora.com',
                18: 'https://invidious.nerdvpn.de',
                19: 'https://vid.priv.au',
                20: 'https://invidious.jing.rocks'
            };

            if (attempt >= 17 && attempt <= 20) {
                const instance = invidiousInstances[attempt];
                const infoRes = await axios.get(`${instance}/api/v1/videos/${videoId}`, { timeout: 10000 });
                const formats = infoRes.data?.adaptiveFormats || [];
                const audioFormat = formats.find((f: any) => f.type?.startsWith('audio/'));
                if (audioFormat && audioFormat.url) {
                    const streamRes = await axios.get(audioFormat.url, { responseType: 'arraybuffer', timeout: 35000 });
                    if (streamRes.data && streamRes.data.byteLength > 10000) {
                        console.log(`[MUSICA SUCESSO] Áudio obtido na tentativa ${attempt}/${MAX_RETRIES} (${streamRes.data.byteLength} bytes).`);
                        return { title, artist, duration, buffer: Buffer.from(streamRes.data), thumbnail: thumbBuffer, url: videoUrl };
                    }
                }
            }
        } catch (errAttempt: any) {
            console.log(`[MUSICA AVISO] Tentativa ${attempt}/${MAX_RETRIES} falhou:`, errAttempt.message || errAttempt);
        }
    }

    console.error(`[MUSICA ERRO] Todas as ${MAX_RETRIES} tentativas de download falharam para "${title}".`);
    return null;
}

export async function fetchMusic(query: string): Promise<MusicResult | null> {
    if (!query) return null;
    const cleanQuery = query.trim();

    let videoId = '';
    const ytMatch = cleanQuery.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/))([a-zA-Z0-9_-]{11})/);
    if (ytMatch) {
        videoId = ytMatch[1];
        return downloadMusicById(videoId);
    }

    const list = await searchMusicList(cleanQuery, 1);
    if (list && list.length > 0) {
        return downloadMusicById(list[0].videoId, list[0].title, list[0].artist, list[0].duration, list[0].url);
    }

    return null;
}
