"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkMatch = exports.RBAC = void 0;
exports.getUserRole = getUserRole;
exports.hasPermission = hasPermission;
exports.isSuperAdmin = isSuperAdmin;
exports.RBAC = {
    roles: {
        '5': ['*'],
        '4': ['!bot', '!divulga', '!divulgar', '!admins', '!adms', '!ajuda', '!jarvis', '!ia', '!h', '!t', '!f', '!n', '!s', '!s2img', '!fig', '!baixarfig', '!meme', '!troll', '!m', '!r', '!ma', '!sa', '!bv', '!exit', '!saida', '!auto', '!agendar', '!boasvindas', '!alerta', '!antilink', '!antifake', '!ddi', '!antiflood', '!antighost', '!apresentacao', '!megafone', '!ban', '!kick', '!inativos', '!regras', '!fechar', '!abrir', '!sorteio', '!warn', '!warns', '!unwarn', '!rank', '!top', '!moeda', '!wiki', '!qrcode', '!quiz', '!charada', '!status', '!painel'],
        '3': ['!bot', '!divulga', '!divulgar', '!admins', '!adms', '!ajuda', '!jarvis', '!meme', '!troll', '!m', '!r', '!ma', '!sa', '!bv', '!exit', '!saida', '!auto', '!agendar', '!boasvindas', '!alerta', '!antilink', '!antifake', '!ddi', '!antiflood', '!antighost', '!apresentacao', '!megafone', '!ban', '!kick', '!inativos', '!regras', '!fechar', '!abrir', '!sorteio', '!warn', '!warns', '!unwarn', '!rank', '!top', '!moeda', '!wiki', '!qrcode', '!quiz', '!charada', '!status', '!painel'],
        '2': ['!bot', '!divulga', '!divulgar', '!admins', '!adms', '!ajuda', '!jarvis', '!ia', '!h', '!t', '!f', '!s', '!s2img', '!fig', '!baixarfig', '!meme', '!troll', '!m', '!r', '!ma', '!sa', '!bv', '!exit', '!saida', '!auto', '!antilink', '!antifake', '!ddi', '!antiflood', '!antighost', '!apresentacao', '!megafone', '!ban', '!kick', '!inativos', '!regras', '!fechar', '!abrir', '!sorteio', '!warn', '!warns', '!unwarn', '!rank', '!top', '!moeda', '!wiki', '!qrcode', '!quiz', '!charada', '!status', '!painel'],
        '1': ['!admins', '!adms', '!ajuda', '!jarvis', '!ia', '!h', '!t', '!f', '!s', '!s2img', '!fig', '!baixarfig', '!meme', '!troll', '!regras', '!sorteio', '!rank', '!top', '!moeda', '!wiki', '!qrcode', '!quiz', '!charada', '!status', '!painel'],
        '0': ['!admins', '!adms', '!ajuda', '!jarvis', '!ia', '!h', '!t', '!f', '!s', '!s2img', '!fig', '!baixarfig', '!meme', '!troll', '!regras', '!sorteio', '!rank', '!top', '!moeda', '!wiki', '!qrcode', '!quiz', '!charada', '!status', '!painel']
    },
    superAdmin: '54259127210155',
    defaultRole: '0'
};
const checkMatch = (dbNum, incoming) => {
    let without9 = dbNum.startsWith('55') && dbNum.length === 13 ? dbNum.slice(0, 4) + dbNum.slice(5) : dbNum;
    let with9 = dbNum.startsWith('55') && dbNum.length === 12 ? dbNum.slice(0, 4) + '9' + dbNum.slice(4) : dbNum;
    return incoming === dbNum || incoming === without9 || incoming === with9;
};
exports.checkMatch = checkMatch;
function getUserRole(userId, usersDb) {
    if (!userId)
        return exports.RBAC.defaultRole;
    const incomingNum = userId.replace(/\D/g, '');
    if ((0, exports.checkMatch)(exports.RBAC.superAdmin, incomingNum))
        return '5';
    for (const [dbNum, roleLvl] of Object.entries(usersDb || {})) {
        if ((0, exports.checkMatch)(dbNum, incomingNum))
            return roleLvl;
    }
    return exports.RBAC.defaultRole;
}
function hasPermission(userId, command, usersDb) {
    if (['!id', '!ajuda', '!cadastro', '!remover', '!cancelar', '!status', '!painel', '!admins', '!adms'].includes(command.toLowerCase()))
        return true;
    const role = getUserRole(userId, usersDb);
    const userAllowedCmds = exports.RBAC.roles[role] || [];
    if (userAllowedCmds.includes('*'))
        return true;
    return userAllowedCmds.includes(command.toLowerCase());
}
function isSuperAdmin(userId, usersDb) {
    return getUserRole(userId, usersDb) === '5';
}
