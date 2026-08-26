import axios from 'axios';
import { SETTINGS } from '../config/settings';

export async function checkImageNSFW(imageBuffer: Buffer): Promise<boolean> {
    if (!SETTINGS.GROQ_API_KEY || !imageBuffer) return false;
    try {
        const base64Image = imageBuffer.toString('base64');
        const url = 'https://api.groq.com/openai/v1/chat/completions';

        const payload = {
            model: 'llama-3.2-11b-vision-preview',
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: 'Analyze this image. Does it contain explicit adult content, pornography, sexual acts, or nudity? Answer strictly with one word: YES or NO.'
                        },
                        {
                            type: 'image_url',
                            image_url: {
                                url: `data:image/jpeg;base64,${base64Image}`
                            }
                        }
                    ]
                }
            ],
            temperature: 0.1,
            max_tokens: 10
        };

        const res = await axios.post(url, payload, {
            headers: {
                'Authorization': `Bearer ${SETTINGS.GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 12000
        });

        const answer = res.data.choices[0]?.message?.content?.trim().toUpperCase();
        return answer === 'YES' || answer.includes('YES');
    } catch (e: any) {
        return false;
    }
}
