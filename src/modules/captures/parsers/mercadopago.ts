import { BRL, cleanMerchant, money, normalizeText, parseAnyPositiveCents, parsePositiveCents } from './amount.js';
import { isNotice, noticeReading } from './notice.js';
import type { AppParser } from './types.js';

const PIX_DEPOSIT = new RegExp(String.raw`^Você depositou ${BRL} via Pix e o valor já está rendendo na sua conta\.?$`, 'i');

/**
 * Pix sent, notified by the app ("Seu Pix foi enviado"; seen on 15/11/2026): "O Pix de R$ 10.00 foi feito para NOME,
 * CPF: ∗∗∗.nnn.nnn-∗∗." The amount comes with a decimal point. The name runs up to ", CPF"/", CNPJ" or the final dot;
 * the document is never read.
 */
const PIX_SENT = new RegExp(String.raw`^O Pix de ${BRL} foi feito para (.*?)(?:,\s*(?:CPF|CNPJ)\b.*)?\.?$`, 'i');

function pixSent(body: string) {
  const m = PIX_SENT.exec(body);
  if (!m) return null;
  const cents = parseAnyPositiveCents(m[1]!);
  if (cents === null) return null;
  const name = cleanMerchant(m[2] ?? '').replace(/[.,]+$/, '');
  return {
    kind: 'PIX_OUT' as const, type: 'EXPENSE' as const, ...money(cents), method: 'PIX' as const,
    ...(name ? { merchant: name } : {}), description: name || 'Pix enviado',
  };
}

export const parseMercadoPago: AppParser = ({ text }) => {
  const body = normalizeText(text);
  const sent = PIX_SENT.test(body) ? pixSent(body) : undefined;
  if (sent !== undefined) return sent;
  const m = PIX_DEPOSIT.exec(body);
  if (m) {
    // Decided 13/11/2026: income with a warning, no pairing with an outflow of another account.
    const cents = parsePositiveCents(m[1]!);
    if (cents === null) return null;
    return { kind: 'PIX_IN', type: 'INCOME', ...money(cents), method: 'PIX', description: 'Depósito via Pix', warning: 'POSSIBLE_OWN_TRANSFER' };
  }
  return body && isNotice(body) ? noticeReading() : null;
};
