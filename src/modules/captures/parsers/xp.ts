import { BRL, money, normalizeText, parsePositiveCents } from './amount.js';
import type { AppParser, ParsedCapture } from './types.js';

/**
 * XP Investimentos (br.com.xp.carteira), P21 L6. Three known formats (specs/notificacoes-levantamento.md); every other
 * text is "em estudo" (XP_STUDY): it never becomes a draft and is deleted after 60 days. The reader never answers null:
 * there is nothing for the user to fill in by hand.
 *
 * Tickers are read, never guessed: [A-Z]{4}\d{1,2}.
 */
const TICKER = String.raw`([A-Z]{4}\d{1,2})`;
const INCOME_TITLE = new RegExp(String.raw`^${TICKER} pagou (rendimentos|dividendos|juros sobre capital)!?$`, 'i');
const INCOME_TEXT = new RegExp(String.raw`^Você recebeu ${BRL}\b`, 'i');
const NOTICE_TITLE = /^Reinvestimento de Proventos$/i;
const NOTICE_TEXT = new RegExp(String.raw`^Seu reinvestimento no valor de ${BRL} será executado no dia (\d{2})/(\d{2})/(\d{4}) no ativo ${TICKER}\.?$`, 'i');
const DONE_TITLE = /^Reinvestimento de Proventos realizado com sucesso$/i;
const DONE_TEXT = new RegExp(String.raw`^Seu reinvestimento no valor de ${BRL} foi realizado no ativo ${TICKER}\.`, 'i');

const STUDY: ParsedCapture = { kind: 'XP_STUDY', type: null, amountCents: null, amount: null, description: null };
const study = (): ParsedCapture => ({ ...STUDY });

const INCOME_LABEL: Record<string, string> = { rendimentos: 'Rendimento', dividendos: 'Dividendo', 'juros sobre capital': 'Juros sobre capital' };

function isoDay(day: string, month: string, year: string): string | null {
  const d = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const ok = d.getUTCFullYear() === Number(year) && d.getUTCMonth() === Number(month) - 1 && d.getUTCDate() === Number(day);
  return ok ? `${year}-${month}-${day}` : null;
}

export const parseXp: AppParser = ({ title, text }) => {
  const t = normalizeText(title ?? '');
  const body = normalizeText(text);

  const income = INCOME_TITLE.exec(t);
  if (income) {
    const cents = INCOME_TEXT.test(body) ? parsePositiveCents(INCOME_TEXT.exec(body)![1]!) : null;
    if (cents === null) return study();
    const ticker = income[1]!.toUpperCase();
    return { kind: 'XP_INCOME', type: null, ...money(cents), description: `${INCOME_LABEL[income[2]!.toLowerCase()]} ${ticker}`, ticker };
  }

  if (NOTICE_TITLE.test(t)) {
    const m = NOTICE_TEXT.exec(body);
    const cents = m ? parsePositiveCents(m[1]!) : null;
    const executionDate = m ? isoDay(m[2]!, m[3]!, m[4]!) : null;
    if (!m || cents === null || executionDate === null) return study();
    const ticker = m[5]!.toUpperCase();
    return { kind: 'XP_REINVEST_NOTICE', type: null, ...money(cents), description: `Aviso de reinvestimento ${ticker}`, ticker, executionDate };
  }

  if (DONE_TITLE.test(t)) {
    const m = DONE_TEXT.exec(body.replace(/\.\s.*$/, '.'));
    const cents = m ? parsePositiveCents(m[1]!) : null;
    if (!m || cents === null) return study();
    const ticker = m[2]!.toUpperCase();
    return { kind: 'XP_REINVEST_DONE', type: null, ...money(cents), description: `Reinvestimento ${ticker}`, ticker };
  }

  return study();
};
