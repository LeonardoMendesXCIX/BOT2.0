import axios from 'axios';

export interface N8NSuggestion {
    action: 'reply';
    message: string;
    mentions: string[];
}

function webhookUrl(): string | null {
    return process.env.N8N_WEBHOOK_URL?.trim() || null;
}

export async function sendToN8N(payload: any): Promise<void> {
    const url = webhookUrl();
    if (!url) return;
    try {
        await axios.post(url, payload, { timeout: 10000 });
    } catch (error: any) {
        console.error('[N8N] Falha ao enviar evento:', error.message);
    }
}

export async function consultarN8nSugestao(text: string, userId: string, chatId: string): Promise<N8NSuggestion | null> {
    const url = webhookUrl();
    if (!url) return null;
    try {
        const response = await axios.post(url, { action: 'suggest_command', text, userId, chatId }, { timeout: 10000 });
        const body = Array.isArray(response.data) ? response.data[0] : response.data;
        if (body?.action !== 'reply' || typeof body.message !== 'string' || !body.message.trim()) return null;
        return {
            action: 'reply',
            message: body.message,
            mentions: Array.isArray(body.mentions) ? body.mentions.filter((mention: unknown): mention is string => typeof mention === 'string') : [],
        };
    } catch (error: any) {
        console.error('[N8N] Falha ao consultar sugestão:', error.message);
        return null;
    }
}