import http from 'http';
import crypto from 'crypto';
import { StorageManager } from '../database/storage';
import { getUserInfo } from '../utils/user';
const tokenMap: Record<string, string> = {};
function getSlugs(storage: StorageManager): Record<string, string> {
    if (!storage.data.cache) storage.data.cache = {};
    if (!storage.data.cache.anonSlugs) storage.data.cache.anonSlugs = {};
    return storage.data.cache.anonSlugs;
}
function json(res: http.ServerResponse, code: number, obj: any) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
}
export function startWebServer(getSock: () => any, storage: StorageManager, port: number = 3000): void {
    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url || '/', 'http://localhost');
            const path = decodeURIComponent(url.pathname);
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
            const groupMatch = path.match(/^\/c\/([a-z0-9-]+)$/i);
            if (req.method === 'GET' && groupMatch) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE_HTML); return; }
            const apiMatch = path.match(/^\/api\/grupo\/([a-z0-9-]+)$/i);
            if (req.method === 'GET' && apiMatch) {
                const chatId = Object.keys(getSlugs(storage)).find(c => getSlugs(storage)[c] === apiMatch[1]) || null;
                const sock = getSock();
                if (!chatId || !sock) { json(res, 404, { error: 'Link inválido.' }); return; }
                const meta = await sock.groupMetadata(chatId).catch(() => null);
                if (!meta) { json(res, 404, { error: 'Grupo não encontrado.' }); return; }
                const membros = meta.participants.map((p: any) => {
                    const info = getUserInfo(p.id, p.name || (p as any).notify || '');
                    const token = crypto.randomBytes(6).toString('hex');
                    tokenMap[token] = p.id;
                    return { token: token, nome: info.pushName || info.formattedNum || 'Membro' };
                });
                const botNum = sock.user && sock.user.id ? sock.user.id.split(':')[0].replace(/\D/g, '') : '';
                json(res, 200, { nome: meta.subject, membros: membros, botNum: botNum });
                return;
            }
            if (req.method === 'POST' && path === '/api/enviar') {
                let body = '';
                req.on('data', c => { body += c; });
                req.on('end', () => {
                    try {
                        const data = JSON.parse(body || '{}');
                        const sock = getSock();
                        const destJid = tokenMap[data.token];
                        const msgTxt = String(data.msg || '').trim();
                        if (!destJid || !msgTxt || !sock) { json(res, 400, { error: 'Dados inválidos.' }); return; }
                        const destNum = destJid.split('@')[0].split(':')[0].replace(/\D/g, '');
                        const botNum = sock.user && sock.user.id ? sock.user.id.split(':')[0].replace(/\D/g, '') : '';
                        const waLink = 'https://wa.me/' + botNum + '?text=' + encodeURIComponent('!anonimo @' + destNum + ' ' + msgTxt);
                        json(res, 200, { waLink: waLink });
                    } catch (e) { json(res, 400, { error: 'Erro.' }); }
                });
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(HOME_HTML);
        } catch (e: any) { json(res, 500, { error: e.message }); }
    });
    server.listen(port, () => console.log('[WEB] Correio Anônimo online em http://localhost:' + port));
}
const PAGE_HTML = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Correio Anônimo</title><style>body{margin:0;font-family:Arial,sans-serif;background:linear-gradient(135deg,#7b2ff7,#f107a3);min-height:100vh;display:flex;align-items:center;justify-content:center}.card{background:#fff;border-radius:20px;padding:30px;width:90%;max-width:420px;box-shadow:0 20px 50px rgba(0,0,0,.3)}h1{margin:0 0 6px;color:#7b2ff7;text-align:center}.sub{text-align:center;color:#888;margin-bottom:20px}select,textarea{width:100%;box-sizing:border-box;border:2px solid #eee;border-radius:12px;padding:12px;font-size:15px;margin-bottom:14px}textarea{min-height:110px}button{width:100%;border:none;border-radius:12px;padding:15px;background:linear-gradient(135deg,#7b2ff7,#f107a3);color:#fff;font-size:16px;font-weight:bold;cursor:pointer}.ok{color:#2e7d32;text-align:center;margin-top:14px;display:none}</style></head><body><div class="card"><h1>🎭 Correio Anônimo</h1><div class="sub" id="grupo">carregando...</div><select id="dest"></select><textarea id="msg" placeholder="Escreva sua mensagem anônima..."></textarea><button onclick="enviar()">💌 Enviar anonimamente</button><div class="ok" id="ok"></div></div><script>var slug=location.pathname.split('/').pop();fetch('/api/grupo/'+slug).then(function(r){return r.json()}).then(function(d){if(d.error){document.getElementById('grupo').innerText=d.error;return;}document.getElementById('grupo').innerText=d.nome;var sel=document.getElementById('dest');var html='<option value="">Para quem?</option>';for(var i=0;i<d.membros.length;i++){html+='<option value="'+d.membros[i].token+'">'+d.membros[i].nome+'</option>';}sel.innerHTML=html;});function enviar(){var token=document.getElementById('dest').value;var msg=document.getElementById('msg').value;if(!token){alert('Escolha o destinatário');return;}if(!msg){alert('Escreva a mensagem');return;}fetch('/api/enviar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:token,msg:msg})}).then(function(r){return r.json()}).then(function(d){if(d.waLink){document.getElementById('ok').style.display='block';document.getElementById('ok').innerText='Abrindo WhatsApp...';window.location.href=d.waLink;}else{alert(d.error||'Erro');}});}</script></body></html>`;
const HOME_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Correio Anônimo</title><style>body{margin:0;font-family:Arial;background:linear-gradient(135deg,#7b2ff7,#f107a3);min-height:100vh;display:flex;align-items:center;justify-content:center}.card{background:#fff;border-radius:20px;padding:40px;text-align:center}</style></head><body><div class="card"><h1>🎭 Correio Anônimo</h1><p>Peça o link ao administrador com <b>!linkcorreio</b>.</p></div></body></html>`;