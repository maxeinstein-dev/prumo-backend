import { describe, expect, it } from 'vitest';

import { parseCsv, parseCsvStatement } from './csv.parser.js';

const summary = (text: string) => parseCsvStatement(text).rows.map((r) => [r.description, r.amount, r.type]);

describe('parseCsv', () => {
  it('skips the header and parses rows with ; delimiter', () => {
    const text = `data;descricao;valor
15/01/2024;Salario;2500.00
16/01/2024;Café;-12.50
`;
    const rows = parseCsv(text);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.description).toBe('Salario');
    expect(rows[0]?.amount).toBe(2500);
    expect(rows[0]?.type).toBe('INCOME');
    // The day printed in the file, at 00:00 UTC, whatever the server's zone
    expect(rows[0]?.date.toISOString()).toBe('2024-01-15T00:00:00.000Z');
  });

  it('parses rows with , delimiter', () => {
    const text = `data,descricao,valor
2024-02-01,Freelance,800.00
`;
    const rows = parseCsv(text);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.description).toBe('Freelance');
    expect(rows[0]?.amount).toBe(800);
    expect(rows[0]?.type).toBe('INCOME');
    expect(rows[0]?.date.toISOString()).toBe('2024-02-01T00:00:00.000Z');
  });

  it('parses Brazilian amount 1.234,56 as negative (EXPENSE with positive amount)', () => {
    const text = `data;descricao;valor
10/03/2024;Aluguel;-1.234,56
`;
    const rows = parseCsv(text);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBeCloseTo(1234.56, 2);
    expect(rows[0]?.type).toBe('EXPENSE');
  });

  it('parses dd-MM-yyyy and dd/MM/yyyy HH:mm:ss dates, keeping only the day', () => {
    const text = `data;descricao;valor
10-03-2024;Conta de luz;100.00
11/03/2024 23:59:59;Mercado;200.00
`;
    const rows = parseCsv(text);

    expect(rows.map((r) => r.date.toISOString())).toEqual(['2024-03-10T00:00:00.000Z', '2024-03-11T00:00:00.000Z']);
  });

  it('ignores invalid lines without throwing', () => {
    const text = `data;descricao;valor
15/01/2024;Salario;2500.00
this line has no columns at all
99/99/9999;Data invalida;10.00
20/01/2024;Valor invalido;abc
;;;
`;
    expect(() => parseCsv(text)).not.toThrow();
    const rows = parseCsv(text);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.description).toBe('Salario');
  });
});

describe('parseCsvStatement', () => {
  it('keeps the first line when the file has no header', () => {
    expect(summary('15/01/2024;Salary;100,00\n16/01/2024;Rent;-50,00\n')).toEqual([
      ['Salary', 100, 'INCOME'],
      ['Rent', 50, 'EXPENSE'],
    ]);
  });

  it('does not mistake a first line with a bad date for a header', () => {
    const { rows, skipped } = parseCsvStatement('32/13/2024;Typo;-10,00\n16/01/2024;Fine;-5,00\n');

    expect(rows).toHaveLength(1);
    expect(skipped).toEqual([{ line: 1, reason: 'invalid-date' }]);
  });

  it('takes the columns named in the header, in any order, and ignores the extra ones', () => {
    expect(summary('Valor;Data;Saldo;Descrição\n-100;05/11/2026;250;Rent\n')).toEqual([['Rent', 100, 'EXPENSE']]);
    // A bank layout with an id column and the amount before the description
    expect(summary('Data,Valor,Identificador,Descrição\n2026-11-05,-12.50,abc-1,Padaria\n')).toEqual([['Padaria', 12.5, 'EXPENSE']]);
  });

  it('does not glue an extra column to the amount: "-100;250" is not 100,25', () => {
    const { rows, skipped } = parseCsvStatement('05/11/2026;Rent;-100;250\n');

    expect(rows).toEqual([]);
    expect(skipped).toEqual([{ line: 1, reason: 'column-count' }]);
  });

  it('refuses a header that names neither the three columns nor has exactly three columns', () => {
    expect(() => parseCsvStatement('a;b;c;d\n1;2;3;4\n')).toThrow(/header must name/);
  });

  it('uses the position when a three-column header has names it does not know', () => {
    expect(summary('When;What;How much\n05/11/2026;Rent;-100,00\n')).toEqual([['Rent', 100, 'EXPENSE']]);
  });

  it('reads quoted cells, so a decimal comma or a comma in the text does not split the line', () => {
    expect(summary('date,description,amount\n2024-03-10,"Rent, March","-1.234,56"\n')).toEqual([['Rent, March', 1234.56, 'EXPENSE']]);
  });

  it('reads English grouping and refuses ambiguous amounts, reporting the line', () => {
    const { rows, skipped } = parseCsvStatement('date;description;amount\n2024-03-10;A;-1,234.50\n2024-03-11;B;1.234\n2024-03-12;C;abc\n');

    expect(rows.map((r) => r.amount)).toEqual([1234.5]);
    expect(skipped).toEqual([
      { line: 3, reason: 'ambiguous-amount' },
      { line: 4, reason: 'invalid-amount' },
    ]);
  });

  it('gives a row without a description a default one instead of an empty text the confirm would refuse', () => {
    expect(summary('data;descricao;valor\n05/11/2026;;-3,00\n')).toEqual([['Importação CSV', 3, 'EXPENSE']]);
  });

  it('keeps identical lines: two coffees on the same day are two rows', () => {
    expect(summary('data;descricao;valor\n05/11/2026;Coffee;-4,00\n05/11/2026;Coffee;-4,00\n')).toHaveLength(2);
  });

  it('ignores blank lines and tolerates CRLF', () => {
    expect(summary('data;descricao;valor\r\n\r\n15/01/2024;A;1,50\r\n')).toEqual([['A', 1.5, 'INCOME']]);
  });

  it('returns nothing for an empty file', () => {
    expect(parseCsvStatement('\n\n').rows).toEqual([]);
  });
});
