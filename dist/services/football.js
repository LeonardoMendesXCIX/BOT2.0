"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchFootballData = fetchFootballData;
const axios_1 = __importDefault(require("axios"));
const settings_1 = require("../config/settings");
async function fetchFootballData(leagueId, queryType, cache) {
    const cacheKey = `${leagueId}_${queryType}_${settings_1.SETTINGS.CURRENT_SEASON}`;
    if (cache[cacheKey] && (Date.now() - cache[cacheKey].timestamp < settings_1.SETTINGS.CACHE_TTL)) {
        return cache[cacheKey].data;
    }
    const headers = { 'x-apisports-key': settings_1.SETTINGS.API_FOOTBALL_KEY };
    try {
        let report = '';
        if (queryType === 'standings') {
            const res = await axios_1.default.get(`https://v3.football.api-sports.io/standings?league=${leagueId}&season=${settings_1.SETTINGS.CURRENT_SEASON}`, { headers });
            if (!res.data || !res.data.response || res.data.response.length === 0)
                return `Não existem dados de classificação.`;
            const standings = res.data.response[0].league.standings[0];
            report = `📊 *Classificação - ${res.data.response[0].league.name} (${settings_1.SETTINGS.CURRENT_SEASON})*\n\n`;
            for (let i = 0; i < Math.min(10, standings.length); i++) {
                const team = standings[i];
                report += `${team.rank}º ${team.team.name} - ${team.points} pts | J:${team.all.played} V:${team.all.win} E:${team.all.draw} D:${team.all.lose}\n`;
            }
        }
        else if (queryType === 'fixtures') {
            const res = await axios_1.default.get(`https://v3.football.api-sports.io/fixtures?league=${leagueId}&season=${settings_1.SETTINGS.CURRENT_SEASON}&next=5`, { headers });
            if (!res.data || !res.data.response || res.data.response.length === 0)
                return `Não há jogos agendados.`;
            report = `📅 *Próximos 5 Jogos*\n\n`;
            res.data.response.forEach((match) => {
                const date = new Date(match.fixture.date).toLocaleDateString('pt-BR');
                const time = new Date(match.fixture.date).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                report += `🔹 *${match.teams.home.name} x ${match.teams.away.name}*\n📅 ${date} às ${time}\n\n`;
            });
        }
        else if (queryType === 'topscorers') {
            const res = await axios_1.default.get(`https://v3.football.api-sports.io/players/topscorers?league=${leagueId}&season=${settings_1.SETTINGS.CURRENT_SEASON}`, { headers });
            if (!res.data || !res.data.response || res.data.response.length === 0)
                return `Sem dados de artilharia.`;
            report = `⚽ *Maiores Artilheiros*\n\n`;
            for (let i = 0; i < Math.min(5, res.data.response.length); i++) {
                const p = res.data.response[i].player;
                const stats = res.data.response[i].statistics[0];
                report += `${i + 1}º *${p.name}* (${stats.team.name}) - ${stats.goals.total || 0} gol(s)\n`;
            }
        }
        cache[cacheKey] = { data: report, timestamp: Date.now() };
        return report;
    }
    catch (e) {
        return "Erro ao consultar dados esportivos.";
    }
}
