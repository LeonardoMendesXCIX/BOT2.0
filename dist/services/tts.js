"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateTTS = generateTTS;
const axios_1 = __importDefault(require("axios"));
async function generateTTS(text) {
    if (!text)
        return null;
    try {
        const cleanText = encodeURIComponent(text.substring(0, 300).trim());
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${cleanText}&tl=pt-BR&client=tw-ob`;
        const res = await axios_1.default.get(url, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            },
            timeout: 15000
        });
        if (res.data) {
            return Buffer.from(res.data);
        }
        return null;
    }
    catch (e) {
        console.error('[ERRO TTS]', e.message);
        return null;
    }
}
