"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchCurrency = fetchCurrency;
const axios_1 = __importDefault(require("axios"));
async function fetchCurrency() {
    try {
        const res = await axios_1.default.get('https://economia.awesomeapi.com.br/last/USD-BRL,EUR-BRL,BTC-BRL');
        const data = res.data;
        return `💵 *COTAÇÃO DE MOEDAS (SISTEMA JARVIS)*\n\n` +
            `🇺🇸 *Dólar Comercial:* R$ ${parseFloat(data.USDBRL.bid).toFixed(2)} (${data.USDBRL.pctChange}%)\n` +
            `🇪🇺 *Euro:* R$ ${parseFloat(data.EURBRL.bid).toFixed(2)} (${data.EURBRL.pctChange}%)\n` +
            `🪙 *Bitcoin:* R$ ${parseFloat(data.BTCBRL.bid).toLocaleString('pt-BR')}\n\n` +
            `🕒 _Atualizado em tempo real pelos meus sensores financeiros._`;
    }
    catch (e) {
        return "❌ Erro ao consultar o mercado financeiro.";
    }
}
