"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendToN8N = sendToN8N;
exports.consultarN8nSugestao = consultarN8nSugestao;
const axios_1 = __importDefault(require("axios"));
function webhookUrl() {
    return process.env.N8N_WEBHOOK_URL?.trim() || null;
}
async function sendToN8N(payload) {
    const url = webhookUrl();
    if (!url)
        return;
    try {
        await axios_1.default.post(url, payload, { timeout: 10000 });
    }
    catch (error) {
        console.error('[N8N] Falha ao enviar evento:', error.message);
    }
}
async function consultarN8nSugestao(text, userId, chatId) {
    const url = webhookUrl();
    if (!url)
        return null;
    try {
        const response = await axios_1.default.post(url, { action: 'suggest_command', text, userId, chatId }, { timeout: 10000 });
        const body = Array.isArray(response.data) ? response.data[0] : response.data;
        if (body?.action !== 'reply' || typeof body.message !== 'string' || !body.message.trim())
            return null;
        return {
            action: 'reply',
            message: body.message,
            mentions: Array.isArray(body.mentions) ? body.mentions.filter((mention) => typeof mention === 'string') : [],
        };
    }
    catch (error) {
        console.error('[N8N] Falha ao consultar sugestão:', error.message);
        return null;
    }
}
