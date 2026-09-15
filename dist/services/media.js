"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.downloadMedia = downloadMedia;
exports.getYoutubeInfo = getYoutubeInfo;
exports.translateText = translateText;
exports.defineWord = defineWord;
exports.removeBackground = removeBackground;
exports.fetchLiveMatches = fetchLiveMatches;
const axios_1 = __importDefault(require("axios"));
async function downloadMedia(url) {
    try {
        const r = await axios_1.default.get(url, { responseType: 'arraybuffer', timeout: 15000 });
        return Buffer.from(r.data);
    }
    catch (e) {
        return null;
    }
}
async function getYoutubeInfo(query) {
    try {
        const r = await axios_1.default.get('https://noembed.com/embed?url=' + encodeURIComponent('https://youtube.com/results?search_query=' + query), { timeout: 8000 }).catch(() => null);
        if (!r || !r.data) {
            return { title: query, url: 'https://youtube.com/results?search_query=' + encodeURIComponent(query) };
        }
        return { title: r.data.title || query, url: 'https://youtube.com/results?search_query=' + encodeURIComponent(query) };
    }
    catch (e) {
        return null;
    }
}
async function translateText(text, to = 'pt') {
    try {
        const r = await axios_1.default.get('https://api.mymemory.translated.net/get', { params: { q: text.slice(0, 400), langpair: 'auto|' + to }, timeout: 8000 });
        return r.data?.responseData?.translatedText || null;
    }
    catch (e) {
        return null;
    }
}
async function defineWord(word) {
    try {
        const r = await axios_1.default.get('https://api.dicionario-aberto.net/word/' + encodeURIComponent(word), { timeout: 8000 });
        const entries = r.data || [];
        if (!entries.length)
            return null;
        const defs = entries.slice(0, 3).map((e) => '• ' + (e.meanings?.[0]?.definitions?.[0]?.text || '')).filter(Boolean).join('\n');
        return defs || null;
    }
    catch (e) {
        return null;
    }
}
async function removeBackground(imgBuf) {
    try {
        return null;
    }
    catch (e) {
        return null;
    }
}
async function fetchLiveMatches() {
    try {
        return [];
    }
    catch (e) {
        return [];
    }
}
