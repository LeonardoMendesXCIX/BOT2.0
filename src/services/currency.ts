import axios from 'axios';

export async function fetchCurrency(): Promise<string> {
    try {
        const res = await axios.get('https://economia.awesomeapi.com.br/last/USD-BRL,EUR-BRL,BTC-BRL');
        const data = res.data;
        return `💵 *COTAÇÃO DE MOEDAS (SISTEMA JARVIS)*\n\n` +
            `🇺🇸 *Dólar Comercial:* R$ ${parseFloat(data.USDBRL.bid).toFixed(2)} (${data.USDBRL.pctChange}%)\n` +
            `🇪🇺 *Euro:* R$ ${parseFloat(data.EURBRL.bid).toFixed(2)} (${data.EURBRL.pctChange}%)\n` +
            `🪙 *Bitcoin:* R$ ${parseFloat(data.BTCBRL.bid).toLocaleString('pt-BR')}\n\n` +
            `🕒 _Atualizado em tempo real pelos meus sensores financeiros._`;
    } catch (e) {
        return "❌ Erro ao consultar o mercado financeiro.";
    }
}
