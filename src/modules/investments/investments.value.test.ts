import { describe, expect, it } from 'vitest';
import type { CalcMovement, MovementType } from './investments.calc.js';
import { valueFixedIncomePosition, valueStockPosition, type RateRow } from './investments.value.js';

// Invented data only. Every expected number below was worked out by hand (the arithmetic is in the comments).

let seq = 0;
const mv = (type: MovementType, date: string, amountCents: number, quantity: number | null = null): CalcMovement => ({
  id: `m${++seq}`,
  type,
  date,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)),
  quantity,
  amountCents,
});

describe('valueStockPosition (quantity x last close up to the date)', () => {
  // TEST11: opening 10 units for 100,00 on 2026-10-01, buy 5 units for 62,50 on 2026-11-10 -> 15 units.
  const movements = [mv('OPENING', '2026-10-01', 10000, 10), mv('BUY', '2026-11-10', 6250, 5)];
  const quotes = [
    { date: '2026-11-25', close: 12.5 },
    { date: '2026-11-20', close: 12.34 },
    { date: '2026-11-27', close: 99 }, // newer than the date asked: must never be used
  ];

  it('15 units x 12,50 (the close of the day asked) = 187,50', () => {
    const v = valueStockPosition({ movements, quotes, asOf: '2026-11-25' });
    expect(v.valueCents).toBe(18750);
    expect(v.mark).toBe('MARKET');
    expect(v.quote).toEqual({ price: 12.5, date: '2026-11-25' });
    expect(v.quantity).toBe(15);
  });

  it('a day without close uses the last one before it: 15 x 12,34 = 185,10, and says which day it was', () => {
    const v = valueStockPosition({ movements, quotes, asOf: '2026-11-24' });
    expect(v.valueCents).toBe(18510);
    expect(v.quote?.date).toBe('2026-11-20');
  });

  it('never uses a close newer than the date asked (the 99,00 of 11-27)', () => {
    const v = valueStockPosition({ movements, quotes, asOf: '2026-11-26' });
    expect(v.valueCents).toBe(18750);
    expect(v.valueCents).not.toBe(15 * 9900);
  });

  it('without any close up to the date: quantity x average price (= the cost), marked "no quote"', () => {
    // On 2026-11-05 the position holds 10 units that cost 100,00; both closes are in the future.
    const v = valueStockPosition({ movements, quotes, asOf: '2026-11-05' });
    expect(v.valueCents).toBe(10000);
    expect(v.mark).toBe('NO_QUOTE');
    expect(v.quote).toBeNull();
    expect(v.quantity).toBe(10);
  });

  it('no quote at all: the cost of the 15 units is 100,00 + 62,50 = 162,50', () => {
    const v = valueStockPosition({ movements, quotes: [], asOf: '2026-11-25' });
    expect(v.valueCents).toBe(16250);
    expect(v.costCents).toBe(16250);
    expect(v.mark).toBe('NO_QUOTE');
  });

  it('a fractional quantity rounds once, at the end: 0,333333 x 10,01 = 3,33666... -> 3,34', () => {
    const v = valueStockPosition({
      movements: [mv('OPENING', '2026-10-01', 333, 0.333333)],
      quotes: [{ date: '2026-11-25', close: 10.01 }],
      asOf: '2026-11-25',
    });
    expect(v.valueCents).toBe(334);
  });

  it('a unit price with six decimals is not rounded early: 3 x 1,234567 = 3,703701 -> 3,70', () => {
    const v = valueStockPosition({
      movements: [mv('OPENING', '2026-10-01', 400, 3)],
      quotes: [{ date: '2026-11-25', close: 1.234567 }],
      asOf: '2026-11-25',
    });
    expect(v.valueCents).toBe(370);
  });

  it('sold out: zero units are worth zero, whatever the quote', () => {
    const v = valueStockPosition({
      movements: [mv('OPENING', '2026-10-01', 10000, 10), mv('SELL', '2026-11-01', 12000, 10)],
      quotes,
      asOf: '2026-11-25',
    });
    expect(v.valueCents).toBe(0);
    expect(v.quantity).toBe(0);
    expect(v.mark).toBe('MARKET');
  });

  it('only movements up to the date count (a back-dated value ignores the later buy)', () => {
    // 2026-11-09: 10 units; the buy of 5 happens on 11-10. Close of 11-05 doesn't exist, the 11-20 one is newer.
    const v = valueStockPosition({ movements, quotes: [{ date: '2026-11-01', close: 11 }], asOf: '2026-11-09' });
    expect(v.valueCents).toBe(11000); // 10 x 11,00
  });

  it('before the opening the position is worth nothing', () => {
    expect(valueStockPosition({ movements, quotes, asOf: '2026-09-30' }).valueCents).toBe(0);
  });
});

/** Business days (Mon-Fri) from..to inclusive, each with the same daily rate in percent. */
function dailyRates(from: string, to: string, value: number): RateRow[] {
  const out: RateRow[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400000) {
    const d = new Date(t);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    out.push({ date: d.toISOString().slice(0, 10), value });
  }
  return out;
}

describe('valueFixedIncomePosition: % of the CDI (and of the Selic), compounded business day by business day', () => {
  // 2026-11-02 is a Monday. The CDI is 0,05% a day on every business day (an invented, round figure).
  const opening = [mv('OPENING', '2026-11-02', 100000)];
  const cdi = dailyRates('2026-11-02', '2026-11-30', 0.05);

  it('100% of the CDI, 5 business days (02..06): 1000 x 1,0005^5 = 1002,50250125 -> 1002,50', () => {
    // 1,0005^5 = 1 + 5(0,0005) + 10(0,0005^2) + 10(0,0005^3) = 1,00250250125
    const v = valueFixedIncomePosition({ movements: opening, indexer: 'CDI', rate: 100, maturityDate: null, anchor: null, rates: cdi, asOf: '2026-11-09' });
    expect(v.valueCents).toBe(100250);
    expect(v.mark).toBe('ESTIMATED');
    expect(v.estimated).toBe(true);
    expect(v.ratesCarried).toBe(false);
  });

  it('90% of the CDI: the daily rate is 0,05% x 0,90 = 0,045%; 1000 x 1,00045^5 = 1002,2520... -> 1002,25', () => {
    const v = valueFixedIncomePosition({ movements: opening, indexer: 'CDI', rate: 90, maturityDate: null, anchor: null, rates: cdi, asOf: '2026-11-09' });
    expect(v.valueCents).toBe(100225);
    // and not the 100% result
    expect(v.valueCents).not.toBe(100250);
  });

  it('the Selic works the same way with its own percentage: 100% of 0,05 a day gives the same 1002,50', () => {
    const v = valueFixedIncomePosition({ movements: opening, indexer: 'SELIC', rate: 100, maturityDate: null, anchor: null, rates: cdi, asOf: '2026-11-09' });
    expect(v.valueCents).toBe(100250);
  });

  it('weekends do not accrue: from Thu 11-05 to Tue 11-10 only 05, 06 and 09 count (3 days): 1000 x 1,0005^3 = 1001,50', () => {
    const v = valueFixedIncomePosition({
      movements: [mv('OPENING', '2026-11-05', 100000)],
      indexer: 'CDI', rate: 100, maturityDate: null, anchor: null, rates: cdi, asOf: '2026-11-10',
    });
    expect(v.valueCents).toBe(100150); // 1001,5007...
  });

  it('a business day without a stored rate inside the known range is a holiday and does not accrue', () => {
    // 11-04 is missing, but the rates go on to 11-30: 02, 03, 05, 06 and 09 accrue (5 days) up to Tue 11-10.
    const holes = cdi.filter((r) => r.date !== '2026-11-04');
    const v = valueFixedIncomePosition({ movements: opening, indexer: 'CDI', rate: 100, maturityDate: null, anchor: null, rates: holes, asOf: '2026-11-10' });
    expect(v.valueCents).toBe(100250); // 5 days again, not 6
    expect(v.ratesCarried).toBe(false);
  });

  it('after the last stored rate it carries the last known one and says so', () => {
    // 02..05 at 0,05; 06 at 0,06; nothing after. Up to Wed 11-11 the days 09 and 10 carry the 0,06.
    // 1000 x 1,0005^4 x 1,0006^3 = 1000 x 1,0020015005 x 1,0018010802 = 1003,806... -> 1003,81
    const rates: RateRow[] = [...dailyRates('2026-11-02', '2026-11-05', 0.05), { date: '2026-11-06', value: 0.06 }];
    const v = valueFixedIncomePosition({ movements: opening, indexer: 'CDI', rate: 100, maturityDate: null, anchor: null, rates, asOf: '2026-11-11' });
    expect(v.valueCents).toBe(100381);
    expect(v.ratesCarried).toBe(true);
    expect(v.estimated).toBe(true);
  });

  it('no rate stored at all: the value stays at the amount applied, marked as missing rates', () => {
    const v = valueFixedIncomePosition({ movements: opening, indexer: 'CDI', rate: 100, maturityDate: null, anchor: null, rates: [], asOf: '2026-11-11' });
    expect(v.valueCents).toBe(100000);
    expect(v.ratesMissing).toBe(true);
    expect(v.estimated).toBe(true);
  });

  it('a rate dated the asked day is not used yet (it accrues over that day): value on 11-03 has only 11-02', () => {
    const v = valueFixedIncomePosition({ movements: opening, indexer: 'CDI', rate: 100, maturityDate: null, anchor: null, rates: cdi, asOf: '2026-11-03' });
    expect(v.valueCents).toBe(100050); // 1000 x 1,0005
  });

  it('does not grow after the maturity: the value on a date past it equals the value on the maturity day', () => {
    const atMaturity = valueFixedIncomePosition({ movements: opening, indexer: 'CDI', rate: 100, maturityDate: '2026-11-06', anchor: null, rates: cdi, asOf: '2026-11-06' });
    const after = valueFixedIncomePosition({ movements: opening, indexer: 'CDI', rate: 100, maturityDate: '2026-11-06', anchor: null, rates: cdi, asOf: '2026-11-27' });
    // 02, 03, 04, 05 accrue (4 days): 1000 x 1,0005^4 = 1002,0015... -> 1002,00
    expect(atMaturity.valueCents).toBe(100200);
    expect(after.valueCents).toBe(100200);
    expect(after.estimated).toBe(true);
  });
});

describe('valueFixedIncomePosition: further applications, redemptions and the manual anchor', () => {
  const cdi = dailyRates('2026-11-02', '2026-11-30', 0.05);
  const base = { indexer: 'CDI' as const, rate: 100, maturityDate: null, rates: cdi };

  it('each application corrects from its own date: 1000 from 11-02 plus 500 from 11-04, on 11-09 = 1503,25', () => {
    // 1000 x 1,0005^2 (02, 03) = 1001,00025; + 500 = 1501,00025; x 1,0005^3 (04, 05, 06) = 1503,2528763 -> 1503,25
    const v = valueFixedIncomePosition({
      ...base, anchor: null, asOf: '2026-11-09',
      movements: [mv('OPENING', '2026-11-02', 100000), mv('BUY', '2026-11-04', 50000)],
    });
    expect(v.valueCents).toBe(150325);
    expect(v.costCents).toBe(150000);
  });

  it('a redemption takes its amount out of the estimate on its date: 1503,25 case with 300,00 out on 11-06 = 1203,10', () => {
    // at 11-04: 1501,00025 (as above); x 1,0005^2 (04, 05) = 1502,501625; - 300 = 1202,501625; x 1,0005 (06) = 1203,1028763
    const v = valueFixedIncomePosition({
      ...base, anchor: null, asOf: '2026-11-09',
      movements: [mv('OPENING', '2026-11-02', 100000), mv('BUY', '2026-11-04', 50000), mv('SELL', '2026-11-06', 30000)],
    });
    expect(v.valueCents).toBe(120310);
    expect(v.costCents).toBe(120000);
  });

  it('a redemption larger than the estimate leaves zero, never a negative value', () => {
    const v = valueFixedIncomePosition({
      ...base, anchor: null, asOf: '2026-11-09',
      movements: [mv('OPENING', '2026-11-02', 100000), mv('SELL', '2026-11-05', 200000)],
    });
    expect(v.valueCents).toBe(0);
  });

  it('an income on a fixed income position does not change its value', () => {
    const v = valueFixedIncomePosition({
      ...base, anchor: null, asOf: '2026-11-09',
      movements: [mv('OPENING', '2026-11-02', 100000), mv('INCOME', '2026-11-05', 5000)],
    });
    expect(v.valueCents).toBe(100250);
  });

  it('on the day of the manual anchor the value is the anchor itself, and it is not an estimate', () => {
    const v = valueFixedIncomePosition({
      ...base, asOf: '2026-11-09', movements: [mv('OPENING', '2026-11-02', 100000)],
      anchor: { amountCents: 105000, date: '2026-11-09' },
    });
    expect(v.valueCents).toBe(105000);
    expect(v.mark).toBe('ANCHOR');
    expect(v.estimated).toBe(false);
  });

  it('after the anchor the estimate starts from it: 1050,00 x 1,0005^2 (09, 10) = 1051,05 on 11-11', () => {
    const v = valueFixedIncomePosition({
      ...base, asOf: '2026-11-11', movements: [mv('OPENING', '2026-11-02', 100000)],
      anchor: { amountCents: 105000, date: '2026-11-09' },
    });
    expect(v.valueCents).toBe(105105); // 1051,0502625
    expect(v.mark).toBe('ESTIMATED');
    expect(v.estimated).toBe(true);
  });

  it('an application after the anchor adds on top of it and corrects from its own date', () => {
    // anchor 1050,00 on 11-09; buy 200,00 on 11-10. On 11-12: 1050 x 1,0005 (09) = 1050,525; + 200 = 1250,525; x 1,0005^2 (10, 11) = 1251,7771...
    const v = valueFixedIncomePosition({
      ...base, asOf: '2026-11-12',
      movements: [mv('OPENING', '2026-11-02', 100000), mv('BUY', '2026-11-10', 20000)],
      anchor: { amountCents: 105000, date: '2026-11-09' },
    });
    // 1250,525 x 1,00100025 = 1251,7771...
    expect(v.valueCents).toBe(125178);
  });

  it('movements dated on or before the anchor are already inside it (not counted twice)', () => {
    const v = valueFixedIncomePosition({
      ...base, asOf: '2026-11-09',
      movements: [mv('OPENING', '2026-11-02', 100000), mv('BUY', '2026-11-09', 50000)],
      anchor: { amountCents: 155000, date: '2026-11-09' },
    });
    expect(v.valueCents).toBe(155000);
  });

  it('a date before the anchor ignores it and estimates from the movements: 3 days from 11-02 = 1001,50', () => {
    const v = valueFixedIncomePosition({
      ...base, asOf: '2026-11-05', movements: [mv('OPENING', '2026-11-02', 100000)],
      anchor: { amountCents: 105000, date: '2026-11-09' },
    });
    expect(v.valueCents).toBe(100150);
  });

  it('before any application the position is worth nothing', () => {
    expect(valueFixedIncomePosition({ ...base, anchor: null, asOf: '2026-10-30', movements: [mv('OPENING', '2026-11-02', 100000)] }).valueCents).toBe(0);
  });
});

describe('valueFixedIncomePosition: IPCA + a rate a year', () => {
  // IPCA series are monthly, in percent, dated on the 1st of the reference month.
  const ipca: RateRow[] = [
    { date: '2026-01-01', value: 0.5 },
    { date: '2026-02-01', value: 0.4 },
  ];
  const base = { indexer: 'IPCA' as const, maturityDate: null, anchor: null };

  it('two whole months plus 6% a year pro rata: 2000 x 1,005 x 1,004 x 1,06^(59/365) = 2037,137 -> 2037,14', () => {
    // 1,005 x 1,004 = 1,00902; 1,06^(59/365) = e^(0,0582689 x 0,161644) = 1,0094637 -> 1,0185690... x 2000
    const v = valueFixedIncomePosition({ ...base, rate: 6, rates: ipca, asOf: '2026-03-01', movements: [mv('OPENING', '2026-01-01', 200000)] });
    expect(v.valueCents).toBe(203714);
    expect(v.mark).toBe('ESTIMATED');
    expect(v.ratesCarried).toBe(false);
  });

  it('IPCA without the yearly rate is not the same as with it (the rate counts)', () => {
    const v0 = valueFixedIncomePosition({ ...base, rate: 0, rates: ipca, asOf: '2026-03-01', movements: [mv('OPENING', '2026-01-01', 200000)] });
    // 2000 x 1,00902 = 2018,04
    expect(v0.valueCents).toBe(201804);
  });

  it('a partial month is pro rata by days, geometrically: 16 of 31 days of January = 1000 x 1,005^(16/31) = 1002,5775 -> 1002,58', () => {
    const v = valueFixedIncomePosition({ ...base, rate: 0, rates: ipca, asOf: '2026-02-01', movements: [mv('OPENING', '2026-01-16', 100000)] });
    expect(v.valueCents).toBe(100258);
  });

  it('a month not published yet carries the last known IPCA and says so (March on 04-01 uses 0,4)', () => {
    // 1000 x 1,005 x 1,004 x 1,004 = 1013,0... : (Jan, Feb known; Mar carried at 0,4) -> 1000 x 1,00902 x 1,004 = 1013,056...
    const v = valueFixedIncomePosition({ ...base, rate: 0, rates: ipca, asOf: '2026-04-01', movements: [mv('OPENING', '2026-01-01', 100000)] });
    expect(v.valueCents).toBe(101306);
    expect(v.ratesCarried).toBe(true);
  });

  it('no IPCA stored: only the yearly rate grows, and the missing rates are marked', () => {
    // 1000 x 1,06^(59/365) = 1009,46
    const v = valueFixedIncomePosition({ ...base, rate: 6, rates: [], asOf: '2026-03-01', movements: [mv('OPENING', '2026-01-01', 100000)] });
    expect(v.valueCents).toBe(100946);
    expect(v.ratesMissing).toBe(true);
  });
});

describe('valueFixedIncomePosition: prefixed (rate a year, 365 calendar days)', () => {
  const base = { indexer: 'PREFIXED' as const, rates: [], anchor: null };
  const opening = [mv('OPENING', '2026-01-01', 100000)];

  it('exactly one year at 12% a year is 12%: 1000 -> 1120,00', () => {
    const v = valueFixedIncomePosition({ ...base, rate: 12, maturityDate: null, movements: opening, asOf: '2027-01-01' });
    expect(v.valueCents).toBe(112000);
    expect(v.ratesMissing).toBe(false);
  });

  it('181 days at 12%: 1000 x 1,12^(181/365) = 1057,81', () => {
    const v = valueFixedIncomePosition({ ...base, rate: 12, maturityDate: null, movements: opening, asOf: '2026-07-01' });
    expect(v.valueCents).toBe(105781);
  });

  it('stops at the maturity: a date after it gives the value of the maturity day', () => {
    const v = valueFixedIncomePosition({ ...base, rate: 12, maturityDate: '2026-07-01', movements: opening, asOf: '2027-01-01' });
    expect(v.valueCents).toBe(105781);
    expect(v.estimated).toBe(true);
  });
});
