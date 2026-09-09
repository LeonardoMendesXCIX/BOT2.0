import yts from 'yt-search';
import ytdl from '@distube/ytdl-core';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import fs from 'fs';
import path from 'path';

ffmpeg.setFfmpegPath(ffmpegStatic);

const TEMP_DIR = path.join(__dirname, '..', '..', 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

setInterval(() => {
    const now = Date.now();
    try {
        fs.readdirSync(TEMP_DIR).forEach(f => {
            const fp = path.join(TEMP_DIR, f);
            const stat = fs.statSync(fp);
            if (now - stat.mtimeMs > 10 * 60 * 1000) fs.unlinkSync(fp);
        });
    } catch (e) { }
}, 5 * 60 * 1000);

export async function searchYouTube(query: string, limit = 15): Promise<any[]> {
    const r = await yts(query);
    return r.videos.slice(0, limit).map((v: any) => ({
        title: v.title,
        url: v.url,
        videoId: v.videoId,
        duration: v.duration.timestamp,
        seconds: v.seconds,
        thumbnail: v.thumbnail,
        author: v.author?.name || ''
    }));
}

export async function downloadAudio(url: string): Promise<string> {
    const outPath = path.join(TEMP_DIR, 'a_' + Date.now() + '.mp3');
    return new Promise((resolve, reject) => {
        const stream = ytdl(url, { quality: 'highestaudio', filter: 'audioonly' });
        ffmpeg(stream)
            .audioBitrate(128)
            .toFormat('mp3')
            .on('end', () => resolve(outPath))
            .on('error', (err: Error) => reject(err))
            .save(outPath);
    });
}

export async function downloadVideo(url: string): Promise<string> {
    const outPath = path.join(TEMP_DIR, 'v_' + Date.now() + '.mp4');
    return new Promise((resolve, reject) => {
        const stream = ytdl(url, { quality: 'highestvideo' });
        ffmpeg(stream)
            .videoCodec('libx264')
            .audioCodec('aac')
            .format('mp4')
            .on('end', () => resolve(outPath))
            .on('error', (err: Error) => reject(err))
            .save(outPath);
    });
}

export async function getAudioBuffer(url: string): Promise<Buffer> {
    const fp = await downloadAudio(url);
    const buf = fs.readFileSync(fp);
    try { fs.unlinkSync(fp); } catch (e) { }
    return buf;
}

export async function getVideoBuffer(url: string): Promise<Buffer> {
    const fp = await downloadVideo(url);
    const buf = fs.readFileSync(fp);
    try { fs.unlinkSync(fp); } catch (e) { }
    return buf;
}
