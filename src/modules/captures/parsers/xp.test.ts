import { describe, expect, it } from 'vitest';
import { PARSER_VERSION, parseCapture } from './index.js';

// The texts keep the exact shape of the real XP notifications; tickers and amounts are invented (TEST11, ABCD11, 12,34...).
const XP = 'br.com.xp.carteira';
const parse = (title: string | null, text: string) => parseCapture({ package: XP, title, text });
const NBSP = ' ';

describe('XP: rendimento pago (provento)', () => {
  it('reads "<ticker> pagou rendimentos!" as an income of the ticker, with the amount of the text', () => {
    expect(parse('TEST11 pagou rendimentos!', 'Você recebeu R$ 12,34 e o valor já está disponível na sua conta.')).toEqual({
      kind: 'XP_INCOME', type: null, amountCents: 1234, amount: 12.34, description: 'Rendimento TEST11', ticker: 'TEST11',
    });
  });

  it.each([
    ['dividendos', 'Dividendo TEST11'],
    ['juros sobre capital', 'Juros sobre capital TEST11'],
    ['rendimentos', 'Rendimento TEST11'],
  ])('also reads the title with %s', (word, description) => {
    const parsed = parse(`TEST11 pagou ${word}!`, 'Você recebeu R$ 7,77 e o valor já está disponível na sua conta.');
    expect(parsed).toMatchObject({ kind: 'XP_INCOME', amountCents: 777, ticker: 'TEST11', description });
  });

  it('reads thousands, a non-breaking space after R$ and a ticker with one digit', () => {
    expect(parse('ABCD3 pagou dividendos!', `Você recebeu R$${NBSP}1.234,56 e o valor já está disponível na sua conta.`)).toMatchObject({
      kind: 'XP_INCOME', amountCents: 123456, ticker: 'ABCD3',
    });
  });

  it('a payout title whose text carries no amount is not a draft: it goes to study', () => {
    expect(parse('TEST11 pagou rendimentos!', 'Você recebeu um rendimento.')).toMatchObject({ kind: 'XP_STUDY', amountCents: null });
  });

  it('a zero amount is not a draft either', () => {
    expect(parse('TEST11 pagou rendimentos!', 'Você recebeu R$ 0,00 e o valor já está disponível na sua conta.')).toMatchObject({ kind: 'XP_STUDY' });
  });
});

describe('XP: reinvestimento de proventos', () => {
  it('the notice (future date) keeps the ticker, the announced amount and the day, and is not a draft', () => {
    expect(parse('Reinvestimento de Proventos', 'Seu reinvestimento no valor de R$ 12,34 será executado no dia 24/11/2026 no ativo TEST11.')).toEqual({
      kind: 'XP_REINVEST_NOTICE', type: null, amountCents: 1234, amount: 12.34, description: 'Aviso de reinvestimento TEST11', ticker: 'TEST11', executionDate: '2026-11-24',
    });
  });

  it('the notice tolerates a missing final period', () => {
    expect(parse('Reinvestimento de Proventos', 'Seu reinvestimento no valor de R$ 7,77 será executado no dia 01/12/2026 no ativo ABCD11')).toMatchObject({
      kind: 'XP_REINVEST_NOTICE', ticker: 'ABCD11', executionDate: '2026-12-01',
    });
  });

  it('the notice with an impossible date is study, not a wrong pairing key', () => {
    expect(parse('Reinvestimento de Proventos', 'Seu reinvestimento no valor de R$ 7,77 será executado no dia 31/02/2026 no ativo ABCD11.')).toMatchObject({ kind: 'XP_STUDY' });
  });

  it('the execution is a purchase of the executed amount in the ticker', () => {
    expect(
      parse(
        'Reinvestimento de Proventos realizado com sucesso',
        'Seu reinvestimento no valor de R$ 7,77 foi realizado no ativo TEST11. O débito em sua conta investimento ocorrerá em 2 dias úteis.',
      ),
    ).toEqual({
      kind: 'XP_REINVEST_DONE', type: null, amountCents: 777, amount: 7.77, description: 'Reinvestimento TEST11', ticker: 'TEST11',
    });
  });

  it('the execution cut before the debit sentence is still understood', () => {
    expect(parse('Reinvestimento de Proventos realizado com sucesso', 'Seu reinvestimento no valor de R$ 7,77 foi realizado no ativo TEST11.')).toMatchObject({
      kind: 'XP_REINVEST_DONE', amountCents: 777, ticker: 'TEST11',
    });
  });

  it('the title decides: the "será executado" text under the "realizado" title is study', () => {
    expect(parse('Reinvestimento de Proventos realizado com sucesso', 'Seu reinvestimento no valor de R$ 7,77 será executado no dia 24/11/2026 no ativo TEST11.')).toMatchObject({ kind: 'XP_STUDY' });
  });
});

describe('XP: everything else is "em estudo"', () => {
  it.each([
    ['Invista em renda fixa', 'Aproveite taxas de até 14% ao ano em CDBs selecionados.'],
    ['Seu extrato está disponível', 'Veja o saldo de R$ 100,00 na sua conta.'],
    [null, 'Oferta por tempo limitado.'],
    ['TEST11 anunciou dividendos', 'Você receberá R$ 5,00 em breve.'],
  ])('reads %j as study, with no amount and no description', (title, text) => {
    expect(parse(title, text)).toEqual({ kind: 'XP_STUDY', type: null, amountCents: null, amount: null, description: null });
  });

  it('a study reading never carries the amount of an advertisement, even when it quotes one', () => {
    const parsed = parse('Aproveite', 'Invista R$ 50,00 hoje e ganhe R$ 10,00.');
    expect(parsed?.amountCents).toBeNull();
    expect(parsed?.ticker).toBeUndefined();
  });

  it('the XP never answers null (not understood): there is no draft to fill by hand', () => {
    expect(parse('qualquer coisa', 'qualquer texto')).not.toBeNull();
  });
});

describe('XP parser version', () => {
  it('was bumped past the readers of the other apps, so older captures can be re-read', () => {
    expect(PARSER_VERSION).toBeGreaterThanOrEqual(6);
  });
});
