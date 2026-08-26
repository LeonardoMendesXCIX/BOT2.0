import axios from 'axios';
import { SETTINGS } from '../config/settings';

export async function transcribeAudio(audioBuffer: Buffer): Promise<string | null> {
    if (!SETTINGS.GROQ_API_KEY || !audioBuffer) return null;
    try {
        const formData = new FormData();
        const blob = new Blob([audioBuffer], { type: 'audio/ogg' });
        formData.append('file', blob, 'audio.ogg');
        formData.append('model', 'whisper-large-v3-turbo');
        formData.append('language', 'pt');
        formData.append('response_format', 'text');

        const res = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', formData, {
            headers: {
                'Authorization': `Bearer ${SETTINGS.GROQ_API_KEY}`
            },
            timeout: 20000
        });

        if (res.data && typeof res.data === 'string') {
            return res.data.trim();
        } else if (res.data && res.data.text) {
            return res.data.text.trim();
        }
        return null;
    } catch (e: any) {
        console.error('[ERRO TRANSCRIÇÃO WHISPER]', e.message);
        return null;
    }
}
