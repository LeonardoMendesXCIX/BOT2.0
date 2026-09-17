"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchWikipedia = fetchWikipedia;
const axios_1 = __importDefault(require("axios"));
async function fetchWikipedia(query) {
    try {
        const res = await axios_1.default.get(`https://pt.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`);
        if (res.data && res.data.extract) {
            return `📚 *WIKIPÉDIA: ${res.data.title.toUpperCase()}*\n\n${res.data.extract}\n\n🔗 _${res.data.content_urls?.desktop?.page || ''}_`;
        }
        return '❌ Nenhum artigo encontrado na Wikipédia.';
    }
    catch (e) {
        return '❌ Artigo não localizado na Wikipédia.';
    }
}
