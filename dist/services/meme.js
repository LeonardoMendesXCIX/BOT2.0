"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchMemeImage = fetchMemeImage;
const axios_1 = __importDefault(require("axios"));
async function fetchMemeImage() {
    const endpoints = [
        'https://meme-api.com/gimme/DiretoDoZapZap',
        'https://meme-api.com/gimme/eu_nvr',
        'https://meme-api.com/gimme/memes_brasil',
        'https://meme-api.com/gimme/memes',
        'https://meme-api.com/gimme'
    ];
    for (const url of endpoints) {
        try {
            const res = await axios_1.default.get(url, { timeout: 10000 });
            if (res.data && res.data.url && (res.data.url.endsWith('.jpg') || res.data.url.endsWith('.png') || res.data.url.endsWith('.jpeg') || res.data.url.endsWith('.webp'))) {
                const imgRes = await axios_1.default.get(res.data.url, { responseType: 'arraybuffer', timeout: 15000 });
                if (imgRes.data) {
                    return {
                        buffer: Buffer.from(imgRes.data),
                        title: res.data.title || 'Meme do Dia'
                    };
                }
            }
        }
        catch (e) { }
    }
    return null;
}
