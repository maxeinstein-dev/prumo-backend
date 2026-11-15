import { BRL, cleanMerchant, money, parseAnyPositiveCents, parsePositiveCents } from './amount.js';
import type { AppParser } from './types.js';

/**
 * Senders (the title of a Gmail notification) whose e-mails are read: only the ones that have a reader, Google Pay and
 * Mercado Pago (decided by the user on 15/11/2026, after the review: a bank enters this list together with its reader,
 * written from sample e-mails). The phone keeps the same list and drops every other e-mail before it is stored or sent,
 * and the server stores no e-mail that no reader understands (captures.service), so the text of a promotion, an invoice
 * or a statement is never kept. Compared without case or extra spaces, as a whole name.
 */
export const GMAIL_SENDERS = ['Google Pay', 'Mercado Pago'] as const;

const normalizeSender = (raw: string) => raw.replace(/\s+/g, ' ').trim().toLowerCase();
const ALLOWED = new Set(GMAIL_SENDERS.map(normalizeSender));

export function isAllowedGmailSender(title: string | null | undefined): boolean {
  return typeof title === 'string' && ALLOWED.has(normalizeSender(title));
}

const PIX_SENT = new RegExp(String.raw`^Seu Pix de ${BRL} foi enviado\s*$`);
const DATE_LINE = /, às \d{1,2}:\d{2}(?::\d{2})?\.?\s*$/;

/**
 * Mercado Pago e-mail of a Pix sent. The app notifies the same Pix too (seen on 15/11/2026), so when both arrive the
 * e-mail is dismissed as a duplicate (capture-duplicates.ts). The receiver name is the line after the date; the CPF/CNPJ
 * line that follows is never read. A text cut before the name falls back to "Pix enviado".
 */
function parseMercadoPagoPixSent(text: string) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const at = lines.findIndex((l) => PIX_SENT.test(l));
  if (at < 0) return null;
  const cents = parsePositiveCents(PIX_SENT.exec(lines[at]!)![1]!);
  if (cents === null) return null;
  let description = 'Pix enviado';
  if (DATE_LINE.test(lines[at + 1] ?? '')) {
    const name = cleanMerchant(lines[at + 2] ?? '');
    if (name && !/^(CPF\/CNPJ|Mercado Pago)/i.test(name)) description = name;
  }
  return { kind: 'PIX_OUT' as const, type: 'EXPENSE' as const, ...money(cents), method: 'PIX' as const, description };
}

const GOOGLE_PAY_PIX = new RegExp(String.raw`Seu Pix de ${BRL} no Google Pay foi realizado com sucesso`, 'i');

/**
 * Google Pay e-mail of a Pix paid with it: "Seu Pix de R$X no Google Pay foi realizado com sucesso". It names neither
 * the bank that paid nor the receiver, so it is a kind of its own (no account rule of another e-mail applies) and comes
 * with no account: the user picks it when confirming (decided 15/11/2026). A Pix from the Nubank account made this way
 * has no other notification; one from Mercado Pago also has the app's, and then this e-mail is the duplicate.
 */
/**
 * The body of the same e-mail (print of 15/11/2026): "Seu Pix foi concluído com sucesso." with the amount on the next
 * line ("R$37,50"). Read too, because the phone keeps the longest text of the notification, which may be the body alone.
 */
const GOOGLE_PAY_PIX_BODY = new RegExp(String.raw`Seu Pix foi concluído com sucesso\.? ${BRL}`, 'i');

function parseGooglePayPix(text: string) {
  const flat = text.replace(/\s+/g, ' ');
  const m = GOOGLE_PAY_PIX.exec(flat) ?? GOOGLE_PAY_PIX_BODY.exec(flat);
  if (!m) return null;
  const cents = parseAnyPositiveCents(m[1]!);
  if (cents === null) return null;
  return { kind: 'WALLET_PIX_OUT' as const, type: 'EXPENSE' as const, ...money(cents), method: 'PIX' as const, description: 'Pix pelo Google Pay' };
}

export const parseGmail: AppParser = ({ title, text }) => {
  if (!isAllowedGmailSender(title)) return null;
  const sender = normalizeSender(title!);
  if (sender === 'mercado pago') return parseMercadoPagoPixSent(text);
  if (sender === 'google pay') return parseGooglePayPix(text);
  return null;
};
