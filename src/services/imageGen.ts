import axios from 'axios';

export async function generateAIImage(prompt: string): Promise<Buffer | null> {
    if (!prompt) return null;
    try {
        const seed = Math.floor(Math.random() * 1000000);
        const encodedPrompt = encodeURIComponent(prompt.trim());
        const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&nologo=true&seed=${seed}`;

        const res = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            timeout: 35000
        });

        if (res.data) {
            return Buffer.from(res.data);
        }
        return null;
    } catch (e: any) {
        console.error('[ERRO GERADOR DE IMAGEM]', e.message);
        return null;
    }
}
