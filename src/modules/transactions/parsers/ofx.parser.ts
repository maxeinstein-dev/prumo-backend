import {
  buildUtcDate,
  decodeEntities,
  MAX_CENTS,
  parseAmountText,
  toRow,
  type AmountResult,
  type ParseResult,
  type ParsedRow,
  type SkippedRow,
} from './statement.common.js';

export type { ParsedRow };

export const OFX_DEFAULT_DESCRIPTION = 'Importação OFX';

const TRNAMT_REGEX = /<TRNAMT>([^\r\n<]+)/;
const DTPOSTED_REGEX = /<DTPOSTED>([^\r\n<]+)/;
const MEMO_REGEX = /<MEMO>([^\r\n<]+)/;

function extract(regex: RegExp, block: string): string | null {
  const match = regex.exec(block);
  if (!match?.[1]) return null;
  const value = match[1].trim();
  return value.length > 0 ? value : null;
}

function buildDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(year, month - 1, day, hour, minute, second);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

/**
 * Local Date of an OFX date-time (`YYYYMMDD[HHMMSS[.XXX]][[offset:TZ]]`): the digits are read as written, in the
 * statement's own clock, so the calendar day is the one the bank printed. Null when the day or time is not real.
 */
export function parseOfxDate(raw: string): Date | null {
  const value = raw.trim();
  if (value.length >= 14 && /^\d{14}/.test(value)) {
    const chunk = value.slice(0, 14);
    return buildDate(
      Number(chunk.slice(0, 4)),
      Number(chunk.slice(4, 6)),
      Number(chunk.slice(6, 8)),
      Number(chunk.slice(8, 10)),
      Number(chunk.slice(10, 12)),
      Number(chunk.slice(12, 14)),
    );
  }
  if (value.length >= 8 && /^\d{8}/.test(value)) {
    const chunk = value.slice(0, 8);
    return buildDate(
      Number(chunk.slice(0, 4)),
      Number(chunk.slice(4, 6)),
      Number(chunk.slice(6, 8)),
    );
  }
  return null;
}

/** `YYYYMMDD[HHMMSS[.XXX]][offset]`: only the calendar day the bank printed is kept, at 00:00 UTC. */
function parseOfxDay(raw: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(raw.trim());
  return match ? buildUtcDate(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}

/**
 * OFX amounts use `.` as the decimal mark by the spec, so a plain `-1.234` is 1.234 here (unlike in a CSV, where it
 * is ambiguous). Anything else, such as a bank that prints `,`, goes through the strict amount rules.
 */
function parseOfxAmount(raw: string): AmountResult {
  const plain = /^([+-]?)(\d+(?:\.\d+)?)$/.exec(raw);
  if (!plain) return parseAmountText(raw);
  const cents = Math.round(Number(plain[2]) * 100);
  return cents > 0 && cents <= MAX_CENTS ? { cents, negative: plain[1] === '-' } : { error: 'invalid-amount' };
}

/**
 * The entries of a bank statement, with the ones that could not be read and why. Dates keep the day the bank printed
 * (00:00 UTC); the memo has its XML entities decoded.
 */
export function parseOfxStatement(text: string): ParseResult {
  const result: ParseResult = { rows: [], skipped: [] };
  const blocks = text.split('<STMTTRN>');

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i] as string;
    const skip = (reason: SkippedRow['reason']) => result.skipped.push({ line: i, reason });

    const date = parseOfxDay(extract(DTPOSTED_REGEX, block) ?? '');
    if (date === null) {
      skip('invalid-date');
      continue;
    }
    const amount = parseOfxAmount(extract(TRNAMT_REGEX, block) ?? '');
    if ('error' in amount) {
      skip(amount.error);
      continue;
    }
    const memo = extract(MEMO_REGEX, block);
    result.rows.push(toRow(date, (memo !== null ? decodeEntities(memo).trim() : '') || OFX_DEFAULT_DESCRIPTION, amount.cents, amount.negative));
  }

  return result;
}

/** The rows alone, for callers that do not need the skipped lines. */
export function parseOfx(text: string): ParsedRow[] {
  return parseOfxStatement(text).rows;
}
