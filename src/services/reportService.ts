import axios from 'axios';

/**
 * Analisa uma imagem e extrai números de telefone visíveis.
 * Usa o modelo de visão da Groq.
 */
export async function extractPhoneFromImage(imageBase64: string): Promise<string[]> {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
        console.error('[REPORT] GROQ_API_KEY não configurada');
        return [];
    }

    try {
        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model: 'llama-3.2-90b-vision-preview',
                messages: [
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: 'Analise a imagem e extraia TODOS os números de telefone visíveis. Considere números com DDI (ex: +55 11 99999-9999) ou sem. Retorne APENAS os números separados por vírgula, somente dígitos (10 a 15 dígitos cada). Se não houver nenhum, retorne exatamente: NENHUM. Não adicione explicações.'
                            },
                            {
                                type: 'image_url',
                                image_url: { url: `data:image/jpeg;base64,${imageBase64}` }
                            }
                        ]
                    }
                ],
                max_tokens: 200,
                temperature: 0.1
            },
            {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );

        const content = response.data?.choices?.[0]?.message?.content?.trim() || '';
        console.log('[REPORT] Resposta da IA:', content);

        if (!content || content.toUpperCase().includes('NENHUM')) return [];

        const numeros = content
            .split(/[,\n;]/)
            .map((s: string) => s.replace(/\D/g, ''))
            .filter((s: string) => s.length >= 10 && s.length <= 15);

        return Array.from(new Set(numeros));
    } catch (error: any) {
        console.error('[REPORT] Erro ao analisar imagem:', error.response?.data || error.message);
        return [];
    }
}
