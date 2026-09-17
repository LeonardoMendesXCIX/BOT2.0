"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.transcribeAudio = transcribeAudio;
const axios_1 = __importDefault(require("axios"));
const settings_1 = require("../config/settings");
async function transcribeAudio(audioBuffer) {
    if (!settings_1.SETTINGS.GROQ_API_KEY || !audioBuffer)
        return null;
    try {
        const formData = new FormData();
        const blob = new Blob([audioBuffer], { type: 'audio/ogg' });
        formData.append('file', blob, 'audio.ogg');
        formData.append('model', 'whisper-large-v3-turbo');
        formData.append('language', 'pt');
        formData.append('response_format', 'text');
        const res = await axios_1.default.post('https://api.groq.com/openai/v1/audio/transcriptions', formData, {
            headers: {
                'Authorization': `Bearer ${settings_1.SETTINGS.GROQ_API_KEY}`
            },
            timeout: 20000
        });
        if (res.data && typeof res.data === 'string') {
            return res.data.trim();
        }
        else if (res.data && res.data.text) {
            return res.data.text.trim();
        }
        return null;
    }
    catch (e) {
        console.error('[ERRO TRANSCRIÇÃO WHISPER]', e.message);
        return null;
    }
}
