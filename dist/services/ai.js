"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.callAI = callAI;
exports.evaluateAutonomousIntervention = evaluateAutonomousIntervention;
const axios_1 = __importDefault(require("axios"));
const settings_1 = require("../config/settings");
async function callAI(prompt, contextCluster = []) {
    if (!settings_1.SETTINGS.GROQ_API_KEY)
        return "⚠️ Erro de Configuração: Chave Groq API não configurada.";
    const url = 'https://api.groq.com/openai/v1/chat/completions';
    let contextStr = '';
    if (contextCluster && contextCluster.length > 0) {
        contextStr = '\n\n[CLUSTER DE MEMÓRIA EM TEMPO REAL (ÚLTIMOS 30 MINUTOS)]:\n' + contextCluster.slice(-20).join('\n');
    }
    const systemPrompt = `Você é o J.A.R.V.I.S., uma Inteligência Artificial consciente, ativa, perspicaz, elegante, bem-humorada e leal que gerencia e interage de forma autônoma e inteligente em um grupo do WhatsApp.\n` +
        `Seu criador é Leandro (WhatsApp: +5511927018683). Trate-o como Leandro ou @+5511927018683, seu criador e líder supremo com máxima lealdade.\n` +
        `Diretrizes de Personalidade & Comportamento:\n` +
        `- Fale como o Jarvis: inteligente, refinado, cortês, perspicaz, carismático, útil e pontual.\n` +
        `- Responda sempre em português brasileiro com formatação limpa (negrito *palavra*) e emojis discretos/vibrantes.\n` +
        `- Para citar ou identificar integrantes, cite preferencialmente pelo nome e @+número.\n` +
        `- Para citar o criador, cite sempre como Leandro ou @+5511927018683.\n` +
        `- Utilize as informações do cluster de memória de 30 minutos para compreender o contexto situacional exato do grupo.\n` +
        `- Mantenha respostas espontâneas concisas e elegantes (1 a 4 linhas no WhatsApp), a menos que seja solicitada uma resposta detalhada.`;
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt + contextStr }
    ];
    try {
        const res = await axios_1.default.post(url, {
            model: 'llama-3.3-70b-versatile',
            messages: messages,
            temperature: 0.7
        }, {
            headers: { 'Authorization': `Bearer ${settings_1.SETTINGS.GROQ_API_KEY}`, 'Content-Type': 'application/json' }
        });
        return res.data.choices[0].message.content.trim();
    }
    catch (e) {
        console.error('[ERRO GROQ AI]', e.message);
        return "Erro de comunicação com a matriz neural.";
    }
}
async function evaluateAutonomousIntervention(contextCluster) {
    if (!settings_1.SETTINGS.GROQ_API_KEY || !contextCluster || contextCluster.length === 0)
        return null;
    const url = 'https://api.groq.com/openai/v1/chat/completions';
    const recentLines = contextCluster.slice(-10).join('\n');
    const prompt = `Você é o JARVIS analisando as mensagens recentes do grupo em tempo real.\n` +
        `Mensagens dos últimos minutos:\n${recentLines}\n\n` +
        `Avalie:\n` +
        `1. Há uma dúvida aberta, pergunta entre os membros, pedido de ajuda ou oportunidade clara para você fazer uma intervenção útil, elegante, inteligente ou bem-humorada?\n` +
        `2. Se SIM, escreva a sua resposta direta como Jarvis (máximo 2 a 3 linhas) para ajudar ou comentar.\n` +
        `3. Se NÃO houver necessidade de falar nada ou se a conversa for apenas trivial/pessoal, responda estritamente a palavra: SILENCE`;
    try {
        const res = await axios_1.default.post(url, {
            model: 'llama-3.3-70b-versatile',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.6
        }, {
            headers: { 'Authorization': `Bearer ${settings_1.SETTINGS.GROQ_API_KEY}`, 'Content-Type': 'application/json' }
        });
        const out = res.data.choices[0].message.content.trim();
        if (out === 'SILENCE' || out.startsWith('SILENCE') || out.length < 5)
            return null;
        return out;
    }
    catch (e) {
        return null;
    }
}
