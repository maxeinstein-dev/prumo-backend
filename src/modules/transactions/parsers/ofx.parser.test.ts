import { describe, expect, it } from 'vitest';

import { OFX_DEFAULT_DESCRIPTION, parseOfx, parseOfxDate, parseOfxStatement } from './ofx.parser.js';

const OFX_TWO_ENTRIES = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20240115120000
<TRNAMT>2500.00
<MEMO>Salario mensal
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20240116
<TRNAMT>-89.90
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>
`;

const entry = (date: string, amount: string, memo?: string) =>
  `<STMTTRN>\n<TRNTYPE>DEBIT\n<DTPOSTED>${date}\n<TRNAMT>${amount}\n${memo === undefined ? '' : `<MEMO>${memo}\n`}</STMTTRN>\n`;

describe('parseOfx', () => {
  it('parses two entries, one with MEMO and one without (default description)', () => {
    const rows = parseOfx(OFX_TWO_ENTRIES);

    expect(rows).toHaveLength(2);

    expect(rows[0]?.description).toBe('Salario mensal');
    expect(rows[0]?.amount).toBe(2500);
    expect(rows[0]?.type).toBe('INCOME');

    // No MEMO -> default description, negative value -> EXPENSE with positive amount
    expect(rows[1]?.description).toBe('Importação OFX');
    expect(rows[1]?.amount).toBe(89.9);
    expect(rows[1]?.type).toBe('EXPENSE');
  });

  it('keeps only the printed day, at 00:00 UTC, for a full timestamp and for a short date', () => {
    const rows = parseOfx(OFX_TWO_ENTRIES);

    expect(rows[0]?.date.toISOString()).toBe('2024-01-15T00:00:00.000Z');
    expect(rows[1]?.date.toISOString()).toBe('2024-01-16T00:00:00.000Z');
  });

  it('keeps 23:59:59 on its own day, whatever the zone of the server (it used to roll into the next day behind UTC)', () => {
    const [row] = parseOfx(entry('20261105235959[-3:BRT]', '-7.00', 'Late night'));

    expect(row?.date.toISOString()).toBe('2026-11-05T00:00:00.000Z');
  });

  it('discards entries without a valid date instead of falling back to now()', () => {
    const text = `<STMTTRN>
<DTPOSTED>not-a-date
<TRNAMT>100.00
<MEMO>Bad date
</STMTTRN>
<STMTTRN>
<DTPOSTED>20240301
<TRNAMT>50.00
<MEMO>Good entry
</STMTTRN>
`;
    const rows = parseOfx(text);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.description).toBe('Good entry');
  });

  it('skips blocks missing TRNAMT', () => {
    const text = `<STMTTRN>
<DTPOSTED>20240301
<MEMO>No amount
</STMTTRN>
`;
    expect(parseOfx(text)).toHaveLength(0);
  });

  it('returns empty array for content without transactions', () => {
    expect(parseOfx('OFXHEADER:100\nno transactions here')).toEqual([]);
  });
});

describe('parseOfxStatement', () => {
  it('keeps identical entries: two coffees on the same day are two rows', () => {
    const { rows, skipped } = parseOfxStatement(entry('20261105', '-10.00', 'Coffee') + entry('20261105', '-10.00', 'Coffee'));

    expect(rows).toHaveLength(2);
    expect(skipped).toEqual([]);
  });

  it('reports the entries it cannot read, with the reason and the position, instead of dropping them', () => {
    const { rows, skipped } = parseOfxStatement(
      entry('20261105', '-1.00', 'Ok') + entry('20261331', '-1.00', 'Bad day') + entry('20261105', 'abc', 'Bad amount') + entry('20261105', '1,2,3', 'Odd') + entry('20261105', '0.00', 'Zero'),
    );

    expect(rows.map((r) => r.description)).toEqual(['Ok']);
    expect(skipped).toEqual([
      { line: 2, reason: 'invalid-date' },
      { line: 3, reason: 'invalid-amount' },
      { line: 4, reason: 'invalid-amount' },
      { line: 5, reason: 'invalid-amount' },
    ]);
  });

  it('reads amounts the way OFX prints them: a dot is the decimal mark, even with three digits after it (cents are rounded)', () => {
    expect(parseOfx(entry('20261105', '-1.234', 'Dot')).map((r) => r.amount)).toEqual([1.23]);
    expect(parseOfx(entry('20261105', '-1234.5', 'One digit')).map((r) => r.amount)).toEqual([1234.5]);
    expect(parseOfx(entry('20261105', '-1234,56', 'Comma')).map((r) => r.amount)).toEqual([1234.56]);
    expect(parseOfx(entry('20261105', '12.345', 'Round')).map((r) => r.amount)).toEqual([12.35]);
  });

  it('decodes the XML entities of a memo and leaves unknown names literal, including inherited ones', () => {
    const [row] = parseOfx(entry('20261105', '-3.00', 'AT&amp;T &lt;x&gt; &#65;&#x42; &constructor; &__proto__; &toString; &nope;'));

    expect(row?.description).toBe('AT&T <x> AB &constructor; &__proto__; &toString; &nope;');
  });

  it('keeps the spacing of the memo, only trimmed (descriptions stored by earlier imports must still match)', () => {
    const [row] = parseOfx(entry('20261105', '-3.00', '  COMPRA   LOJA  X  '));

    expect(row?.description).toBe('COMPRA   LOJA  X');
  });

  it('still reads a card invoice as raw rows, since the card importer has its own parser', () => {
    const text = '<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>' + entry('20261105', '-3.00', 'Shop');

    expect(parseOfx(text)).toHaveLength(1);
  });
});

describe('parseOfxDate (kept for the card invoice parser)', () => {
  it('still reads a local date-time, as the card importer expects', () => {
    const date = parseOfxDate('20261105120000');

    expect([date?.getFullYear(), date?.getMonth(), date?.getDate(), date?.getHours()]).toEqual([2026, 10, 5, 12]);
  });

  it('exports the default description both parsers use', () => {
    expect(OFX_DEFAULT_DESCRIPTION).toBe('Importação OFX');
  });
});
