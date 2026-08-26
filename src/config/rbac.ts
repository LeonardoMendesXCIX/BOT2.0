export const RBAC = {
    roles: {
        '5': ['*'], 
        '4': ['!todos', '!all', '!marcartodos', '!fixar', '!desfixar', '!pin', '!unpin', '!remove', '!apagar', '!deletar', '!del', '!bot', '!antinsfw', '!nsfw', '!desenhe', '!criarimg', '!gerarimg', '!transcrever', '!ouvir', '!audio', '!enquete', '!votacao', '!voz', '!falar', '!antidelete', '!divulga', '!divulgar', '!admins', '!adms', '!ajuda', '!jarvis', '!ia', '!h', '!t', '!f', '!n', '!s', '!s2img', '!fig', '!baixarfig', '!m', '!r', '!ma', '!sa', '!bv', '!exit', '!saida', '!auto', '!agendar', '!boasvindas', '!alerta', '!antilink', '!antifake', '!ddi', '!limparfakes', '!antiflood', '!antighost', '!apresentacao', '!megafone', '!ban', '!kick', '!inativos', '!inativosmsg', '!msginativos', '!fantasmas', '!regras', '!fechar', '!abrir', '!sorteio', '!warn', '!warns', '!unwarn', '!rank', '!top', '!moeda', '!wiki', '!qrcode', '!quiz', '!charada', '!status', '!painel'],
        '3': ['!todos', '!all', '!marcartodos', '!fixar', '!desfixar', '!pin', '!unpin', '!remove', '!apagar', '!deletar', '!del', '!bot', '!antinsfw', '!nsfw', '!desenhe', '!criarimg', '!gerarimg', '!transcrever', '!ouvir', '!audio', '!enquete', '!votacao', '!voz', '!falar', '!antidelete', '!divulga', '!divulgar', '!admins', '!adms', '!ajuda', '!jarvis', '!m', '!r', '!ma', '!sa', '!bv', '!exit', '!saida', '!auto', '!agendar', '!boasvindas', '!alerta', '!antilink', '!antifake', '!ddi', '!limparfakes', '!antiflood', '!antighost', '!apresentacao', '!megafone', '!ban', '!kick', '!inativos', '!inativosmsg', '!msginativos', '!fantasmas', '!regras', '!fechar', '!abrir', '!sorteio', '!warn', '!warns', '!unwarn', '!rank', '!top', '!moeda', '!wiki', '!qrcode', '!quiz', '!charada', '!status', '!painel'], 
        '2': ['!todos', '!all', '!marcartodos', '!fixar', '!desfixar', '!pin', '!unpin', '!remove', '!apagar', '!deletar', '!del', '!bot', '!antinsfw', '!nsfw', '!desenhe', '!criarimg', '!gerarimg', '!transcrever', '!ouvir', '!audio', '!enquete', '!votacao', '!voz', '!falar', '!antidelete', '!divulga', '!divulgar', '!admins', '!adms', '!ajuda', '!jarvis', '!ia', '!h', '!t', '!f', '!s', '!s2img', '!fig', '!baixarfig', '!m', '!r', '!ma', '!sa', '!bv', '!exit', '!saida', '!auto', '!antilink', '!antifake', '!ddi', '!limparfakes', '!antiflood', '!antighost', '!apresentacao', '!megafone', '!ban', '!kick', '!inativos', '!inativosmsg', '!msginativos', '!fantasmas', '!regras', '!fechar', '!abrir', '!sorteio', '!warn', '!warns', '!unwarn', '!rank', '!top', '!moeda', '!wiki', '!qrcode', '!quiz', '!charada', '!status', '!painel'], 
        '1': ['!desenhe', '!criarimg', '!transcrever', '!ouvir', '!audio', '!enquete', '!votacao', '!voz', '!falar', '!admins', '!adms', '!ajuda', '!jarvis', '!ia', '!h', '!t', '!f', '!s', '!s2img', '!fig', '!baixarfig', '!regras', '!sorteio', '!rank', '!top', '!moeda', '!wiki', '!qrcode', '!quiz', '!charada', '!status', '!painel'], 
        '0': ['!desenhe', '!criarimg', '!transcrever', '!ouvir', '!audio', '!enquete', '!votacao', '!voz', '!falar', '!admins', '!adms', '!ajuda', '!jarvis', '!ia', '!h', '!t', '!f', '!s', '!s2img', '!fig', '!baixarfig', '!regras', '!sorteio', '!rank', '!top', '!moeda', '!wiki', '!qrcode', '!quiz', '!charada', '!status', '!painel'] 
    },
    superAdmin: '54259127210155',
    defaultRole: '0' 
};

export const checkMatch = (dbNum: string, incoming: string): boolean => {
    let without9 = dbNum.startsWith('55') && dbNum.length === 13 ? dbNum.slice(0, 4) + dbNum.slice(5) : dbNum;
    let with9 = dbNum.startsWith('55') && dbNum.length === 12 ? dbNum.slice(0, 4) + '9' + dbNum.slice(4) : dbNum;
    return incoming === dbNum || incoming === without9 || incoming === with9;
};

export function getUserRole(userId: string, usersDb: Record<string, string>): string {
    if (!userId) return RBAC.defaultRole;
    const incomingNum = userId.replace(/\D/g, '');
    if (checkMatch(RBAC.superAdmin, incomingNum) || checkMatch('5511927018683', incomingNum)) return '5';
    for (const [dbNum, roleLvl] of Object.entries(usersDb || {})) {
        if (checkMatch(dbNum, incomingNum)) return roleLvl;
    }
    return RBAC.defaultRole;
}

export function hasPermission(userId: string, command: string, usersDb: Record<string, string>): boolean {
    if (['!id', '!ajuda', '!cadastro', '!remover', '!cancelar', '!status', '!painel', '!admins', '!adms'].includes(command.toLowerCase())) return true; 
    const role = getUserRole(userId, usersDb);
    const userAllowedCmds = RBAC.roles[role] || [];
    if (userAllowedCmds.includes('*')) return true;
    return userAllowedCmds.includes(command.toLowerCase()); 
}

export function isSuperAdmin(userId: string, usersDb: Record<string, string>): boolean {
    return getUserRole(userId, usersDb) === '5';
}
