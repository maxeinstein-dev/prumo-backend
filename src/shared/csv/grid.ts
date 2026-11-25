/**
 * Zero-dependency RFC 4180 CSV tokenizer used by spreadsheet importers.
 *
 * The output is a raw grid: no trimming, no type coercion, and every logical
 * record (including blank lines) becomes exactly one row, so row indexes in
 * the grid match line numbers in the uploaded file.
 */

export type Grid = string[][];
export type CsvDelimiter = ',' | ';';
export type CsvEncoding = 'utf-8' | 'windows-1252';

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

/**
 * Decodes an uploaded CSV buffer. Tries strict UTF-8 first and falls back to
 * windows-1252 (the usual encoding of Excel exports on pt-BR Windows).
 * A leading UTF-8 BOM is stripped and reported through `hadBom`.
 */
export function decodeCsvBuffer(buffer: Buffer): {
  text: string;
  encoding: CsvEncoding;
  hadBom: boolean;
} {
  const hadBom = hasUtf8Bom(buffer);
  const bytes = hadBom ? buffer.subarray(UTF8_BOM.length) : buffer;

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { text, encoding: 'utf-8', hadBom };
  } catch {
    return { text: decodeWindows1252(bytes), encoding: 'windows-1252', hadBom };
  }
}

function hasUtf8Bom(buffer: Buffer): boolean {
  return buffer.length >= UTF8_BOM.length && UTF8_BOM.every((byte, index) => buffer[index] === byte);
}

// What windows-1252 puts in 0x80-0x9F, where latin1 has C1 control characters. The five undefined bytes (0x81, 0x8D,
// 0x8F, 0x90, 0x9D) stay as the control character of the same code, as the WHATWG decoder does.
const CP1252_HIGH: readonly number[] = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

/**
 * Decoded by hand instead of with TextDecoder('windows-1252'): some Node versions (20 among them) answer that label with
 * plain latin1, so the euro sign and the curly quotes of an Excel export came out as control characters.
 */
function decodeWindows1252(bytes: Buffer): string {
  return bytes.toString('latin1').replace(/[\u0080-\u009f]/g, (c) => String.fromCharCode(CP1252_HIGH[c.charCodeAt(0) - 0x80]));
}

/**
 * Picks the delimiter by counting ',' against ';' in the first non-blank
 * record. Characters inside double quotes are ignored, and the scan is
 * quote-aware so a quoted first cell spanning several lines does not cut it
 * short. A tie (or no delimiter at all) resolves to ','.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  let commas = 0;
  let semicolons = 0;
  let inQuotes = false;
  let atFieldStart = true;
  let sawContent = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') i++;
        else inQuotes = false;
      }
      continue;
    }

    if (ch === '\n' || ch === '\r') {
      if (sawContent) break;
      atFieldStart = true; // blank or whitespace-only line: the next line starts a fresh field
      continue;
    }

    if (ch === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
      sawContent = true;
      continue;
    }

    if (ch === ',') commas++;
    else if (ch === ';') semicolons++;

    // Either candidate may end a field, so a quote right after one is an opening quote.
    atFieldStart = ch === ',' || ch === ';';
    if (ch !== ' ' && ch !== '\t') sawContent = true;
  }

  return semicolons > commas ? ';' : ',';
}

/**
 * Tokenizes CSV text into a grid of raw cells (RFC 4180, lenient).
 *
 * - CRLF, LF and a lone CR all end a record; a trailing terminator adds no record.
 * - A quoted cell may contain the delimiter, line breaks (normalized to '\n')
 *   and '""' escapes. Text after a closing quote is appended literally.
 * - A stray '"' inside an unquoted cell is kept literally.
 * - A blank line becomes [''] so downstream row numbers match the file.
 */
export function parseCsvGrid(text: string, delimiter: CsvDelimiter = detectDelimiter(text)): Grid {
  const grid: Grid = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let atFieldStart = true;
  // Where the pending record starts; equals text.length when the text ended on a terminator.
  let recordStart = 0;

  const endRecord = (nextIndex: number): void => {
    row.push(cell);
    grid.push(row);
    row = [];
    cell = '';
    atFieldStart = true;
    recordStart = nextIndex;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else if (ch === '\r') {
        cell += '\n';
        i += text[i + 1] === '\n' ? 2 : 1;
      } else {
        cell += ch;
        i += 1;
      }
      continue;
    }

    if (ch === delimiter) {
      row.push(cell);
      cell = '';
      atFieldStart = true;
      i += 1;
    } else if (ch === '\n') {
      endRecord(i + 1);
      i += 1;
    } else if (ch === '\r') {
      const next = text[i + 1] === '\n' ? i + 2 : i + 1;
      endRecord(next);
      i = next;
    } else if (ch === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
      i += 1;
    } else {
      cell += ch;
      atFieldStart = false;
      i += 1;
    }
  }

  // Flush the last record unless the text ended exactly on a terminator (or was empty).
  if (recordStart < text.length) {
    row.push(cell);
    grid.push(row);
  }

  return grid;
}

/** Decodes, detects the delimiter and tokenizes an uploaded CSV buffer in one call. */
export function bufferToGrid(buffer: Buffer): {
  grid: Grid;
  delimiter: CsvDelimiter;
  encoding: CsvEncoding;
  hadBom: boolean;
} {
  const { text, encoding, hadBom } = decodeCsvBuffer(buffer);
  const delimiter = detectDelimiter(text);

  return { grid: parseCsvGrid(text, delimiter), delimiter, encoding, hadBom };
}
