const ABERTURAS = ['🚨 ALERTA GERAL:', '📢 ATENÇÃO GRUPO:', '🤖 RELATÓRIO JARVIS:', '⚠️ COMUNICADO:', '🔔 BIP BIP:', '📣 MEGAFONE ATIVADO:', '🧠 FATO CIENTÍFICO:', '🕵️ INVESTIGAÇÃO CONCLUIDA:', '🎙️ MICROFONE ABERTO:', '🛸 CONTATO IMEDIATO:', '📰 PLANTÃO DE NOTÍCIAS:', '🎭 SESSÃO TEATRO:', '⏰ DESPERTADOR:', '🔮 PREVISÃO DO DIA:', '🎲 GIRO DA SORTE:', '🍿 SESSÃO PIPOCA:', '🚀 TRANSMISSÃO DIRETA:', '🐦 UM PASSARINHO ME CONTOU:', '📻 RÁDIO CORREDOR:', '🧯 EMERGÊNCIA DE TÉDIO:'];
const CENARIOS = ['o grupo está tão quieto que dá pra ouvir o Wi-Fi', 'faz meia hora que ninguém manda nem um "kkk"', 'o silêncio aqui está nível modo avião coletivo', 'até o bot de música sentiu falta de vocês', 'detectei mais teia de aranha que mensagem', 'o último "bom dia" foi tão raro que virou evento', 'tem mais gente lendo do que respondendo, hein', 'o grupo virou sala de espera de consultório', 'ninguém fala nada, mas todo mundo está online', 'o recorde de silêncio do século está sendo batido agora', 'mandei um "oi" pro espelho e ele respondeu mais rápido', 'a última mensagem já criou poeira de tão antiga', 'o grupo está mais parado que foto de perfil', 'tem 40 pessoas e 0 assuntos, como assim?', 'o silêncio foi tão grande que eu quase dormi', 'até o anti-link está desempregado hoje', 'o grupo está quieto até demais, suspeitei', 'ninguém manda nada desde a era dos dinossauros', 'o "digitando..." apareceu e sumiu, covardia', 'falta só uma faísca pra esse grupo pegar fogo', 'o último meme já foi esquecido pela história', 'tem mais notificação de outros grupos que daqui', 'o grupo está em modo espectador coletivo', 'até eu, que sou bot, senti falta de um "kkk"', 'a calmaria está tão grande que dá pra meditar'];
const FINAIS = ['Quem salva o grupo do tédio agora? 😂', 'Alguém se habilita a quebrar o silêncio? 🎤', 'Manda um "kkk" aí pra eu saber que tem vida! 🧟', 'Bora movimentar isso aqui! 🚀', 'Quem mandar a primeira mensagem ganha um 🏆 imaginário!', 'Socorro, alguém fala algo! 😅', 'O prêmio de "primeiro a responder" está na mesa! 🍽️', 'Vamos fingir que esse silêncio não aconteceu, né? 😂', 'Deem uma chance pro grupo brilhar hoje! ✨', 'Última chamada antes do grupo virar museu! 🏛️'];
export const TOTAL_FUNNY = ABERTURAS.length * CENARIOS.length * FINAIS.length;
export function getFunnyMessage(storage: any): string {
    if (!storage.data.cache) storage.data.cache = {};
    if (!Array.isArray(storage.data.cache.funnyUsed)) storage.data.cache.funnyUsed = [];
    if (storage.data.cache.funnyUsed.length >= TOTAL_FUNNY) storage.data.cache.funnyUsed = [];
    let idx = Math.floor(Math.random() * TOTAL_FUNNY);
    let guard = 0;
    while (storage.data.cache.funnyUsed.includes(idx) && guard < 60) { idx = Math.floor(Math.random() * TOTAL_FUNNY); guard++; }
    storage.data.cache.funnyUsed.push(idx);
    storage.flagSave();
    const a = Math.floor(idx / (CENARIOS.length * FINAIS.length));
    const c = Math.floor(idx / FINAIS.length) % CENARIOS.length;
    const f = idx % FINAIS.length;
    return ABERTURAS[a] + ' ' + CENARIOS[c] + ' ' + FINAIS[f];
}
