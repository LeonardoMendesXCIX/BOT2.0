const TIMEZONE = 'America/Sao_Paulo';
export function getHHMM(): string {
    try {
        return new Intl.DateTimeFormat('pt-BR', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
    } catch (e) {
        const d = new Date();
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }
}
export function isWithinWindow(open?: string, close?: string, nowHHMM?: string): boolean {
    const now = nowHHMM || getHHMM();
    if (!open) return false;
    if (!close) return now >= open;
    if (open <= close) return now >= open && now < close;
    return now >= open || now < close;
}
