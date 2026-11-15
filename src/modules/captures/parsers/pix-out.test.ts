import { describe, expect, it } from 'vitest';
import { parseDotDecimalCents } from './amount.js';
import { isAllowedGmailSender } from './gmail.js';
import { parseCapture } from './index.js';

// Invented data only, in the mold of the notifications seen on the phone on 15/11/2026 (values and names changed).
const MP = 'com.mercadopago.wallet';
const GM = 'com.google.android.gm';
const mpSent = (value: string, tail = 'MARIA FICTICIA DA SILVA, CPF: ∗∗∗.123.456-∗∗.') => `O Pix de R$ ${value} foi feito para ${tail}`;

describe('parseDotDecimalCents (amount written with a decimal point)', () => {
  it('reads two decimals after a point, with or without comma thousands', () => {
    expect(parseDotDecimalCents('10.00')).toBe(1000);
    expect(parseDotDecimalCents('0.29')).toBe(29);
    expect(parseDotDecimalCents('1234.56')).toBe(123456);
    expect(parseDotDecimalCents('1,234.56')).toBe(123456);
    expect(parseDotDecimalCents('12,345,678.90')).toBe(1234567890);
  });

  it('refuses anything ambiguous or malformed: no decimals, one or three decimals, Brazilian commas', () => {
    for (const raw of ['10', '1.000', '10.5', '10.555', '1,00', '1.234,56', '1,23.45', '', 'abc', '-1.00']) {
      expect(parseDotDecimalCents(raw), raw).toBeNull();
    }
  });
});

describe('Mercado Pago: Pix sent, notified by the app', () => {
  it('reads it as an outflow by Pix, the receiver as the description, never the CPF', () => {
    const parsed = parseCapture({ package: MP, title: 'Seu Pix foi enviado', text: mpSent('10.00') });
    expect(parsed).toEqual({
      kind: 'PIX_OUT', type: 'EXPENSE', amountCents: 1000, amount: 10, method: 'PIX',
      merchant: 'MARIA FICTICIA DA SILVA', description: 'MARIA FICTICIA DA SILVA',
    });
    expect(JSON.stringify(parsed)).not.toContain('123.456');
  });

  it('reads thousands in both ways of writing them, a CNPJ, and a receiver with no document', () => {
    expect(parseCapture({ package: MP, title: null, text: mpSent('1,234.56') })).toMatchObject({ amountCents: 123456 });
    expect(parseCapture({ package: MP, title: null, text: mpSent('1.234,56') })).toMatchObject({ amountCents: 123456 });
    expect(parseCapture({ package: MP, title: null, text: mpSent('50.00', 'LOJA FICTICIA LTDA, CNPJ: 12.345.678/0001-90.') }))
      .toMatchObject({ description: 'LOJA FICTICIA LTDA' });
    expect(parseCapture({ package: MP, title: null, text: mpSent('50.00', 'JOAO FICTICIO.') })).toMatchObject({ description: 'JOAO FICTICIO' });
  });

  it('falls back to "Pix enviado" without a name, and does not understand a text without a readable amount', () => {
    expect(parseCapture({ package: MP, title: null, text: 'O Pix de R$ 7.50 foi feito para , CPF: ∗∗∗.123.456-∗∗.' })).toMatchObject({ description: 'Pix enviado' });
    expect(parseCapture({ package: MP, title: null, text: mpSent('1.0') })).toBeNull();
    expect(parseCapture({ package: MP, title: null, text: 'O Pix foi feito para MARIA.' })).toBeNull();
  });

  it('keeps reading the Pix deposit as before', () => {
    expect(parseCapture({ package: MP, title: null, text: 'Você depositou R$ 10,00 via Pix e o valor já está rendendo na sua conta.' }))
      .toMatchObject({ kind: 'PIX_IN', type: 'INCOME', amountCents: 1000 });
  });
});

describe('Gmail: which senders are read', () => {
  it('accepts only the senders that have a reader: Google Pay and Mercado Pago, in any case and spacing', () => {
    for (const s of ['Google Pay', ' google pay ', 'Mercado Pago', 'MERCADO PAGO']) {
      expect(isAllowedGmailSender(s), s).toBe(true);
    }
  });

  it('refuses anyone else, the banks without a reader, a grouped notification and a missing title', () => {
    for (const s of ['Maria Silva', 'XP Investimentos', 'XP', 'Nubank', 'Inter', 'Banco Inter', 'PagBank', 'PagSeguro', 'Internacional FC', '2 novas mensagens', 'Google', 'Pay', '', null]) {
      expect(isAllowedGmailSender(s), String(s)).toBe(false);
    }
  });
});

describe('Gmail: Pix paid with Google Pay', () => {
  const text = (value: string) => `Seu Pix de R$${value} no Google Pay foi realizado com sucesso. Veja os detalhes no app.`;

  it('reads an outflow by Pix of its own kind, with no account and no receiver (the e-mail names neither)', () => {
    expect(parseCapture({ package: GM, title: 'Google Pay', text: text('10,00') })).toEqual({
      kind: 'WALLET_PIX_OUT', type: 'EXPENSE', amountCents: 1000, amount: 10, method: 'PIX', description: 'Pix pelo Google Pay',
    });
    expect(parseCapture({ package: GM, title: 'Google Pay', text: text(' 1.234,56') })).toMatchObject({ amountCents: 123456 });
    expect(parseCapture({ package: GM, title: 'Google Pay', text: text('10.00') })).toMatchObject({ amountCents: 1000 });
  });

  it('reads the body of the e-mail too, when the notification carries the body without the subject (print of 15/11)', () => {
    const body = 'Seu Pix foi concluído com sucesso.\nR$37,50\nPagamento concluído! Você pode conferir mais detalhes sobre essa transação na Carteira do Google ou no app da sua inst…';
    expect(parseCapture({ package: GM, title: 'Google Pay', text: body })).toEqual({
      kind: 'WALLET_PIX_OUT', type: 'EXPENSE', amountCents: 3750, amount: 37.5, method: 'PIX', description: 'Pix pelo Google Pay',
    });
    const both = 'Seu Pix de R$37,50 no Google Pay foi realizado com sucesso\nConfira mais detalhes na Carteira do Google\n\n' + body;
    expect(parseCapture({ package: GM, title: 'Google Pay', text: both })).toMatchObject({ amountCents: 3750 });
    expect(parseCapture({ package: GM, title: 'Google Pay', text: 'Seu Pix foi concluído com sucesso.' })).toBeNull();
    expect(parseCapture({ package: GM, title: 'Maria Silva', text: body })).toBeNull();
  });

  it('reads the sentence in any line of the e-mail preview', () => {
    expect(parseCapture({ package: GM, title: 'Google Pay', text: `Pix realizado\n${text('25,00')}` })).toMatchObject({ amountCents: 2500 });
  });

  it('does not understand another Google Pay e-mail, nor this text from another sender', () => {
    expect(parseCapture({ package: GM, title: 'Google Pay', text: 'Novidades do Google Pay: até R$ 50,00 de volta.' })).toBeNull();
    expect(parseCapture({ package: GM, title: 'Maria Silva', text: text('10,00') })).toBeNull();
  });

  it('reads nothing from a bank sender without a reader', () => {
    expect(parseCapture({ package: GM, title: 'PagBank', text: 'Você recebeu um Pix de R$ 10,00.' })).toBeNull();
  });
});
