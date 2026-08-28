"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateAIImage = generateAIImage;
const axios_1 = __importDefault(require("axios"));
async function generateAIImage(prompt) {
    if (!prompt)
        return null;
    try {
        const seed = Math.floor(Math.random() * 1000000);
        const encodedPrompt = encodeURIComponent(prompt.trim());
        const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&nologo=true&seed=${seed}`;
        const res = await axios_1.default.get(imageUrl, {
            responseType: 'arraybuffer',
            timeout: 35000
        });
        if (res.data) {
            return Buffer.from(res.data);
        }
        return null;
    }
    catch (e) {
        console.error('[ERRO GERADOR DE IMAGEM]', e.message);
        return null;
    }
}
