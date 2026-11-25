import { z } from 'zod';

const todayUtcDay = (): string => new Date().toISOString().slice(0, 10);

const isRealDay = (value: string): boolean => {
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
};

/** 'YYYY-MM-DD', a real calendar day. */
export const dayString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine(isRealDay, 'Not a valid calendar day');

export const pastOrToday = dayString.refine((v) => v <= todayUtcDay(), 'The date cannot be in the future');

/** No coercion of null/false to 0: only a number or a plain numeric string. */
const numeric = (message: string) =>
  z.preprocess((v) => (typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : v), z.number({ invalid_type_error: message }).finite());

const decimalPlaces = (n: number, places: number): boolean => Math.abs(Math.round(n * 10 ** places) - n * 10 ** places) < 1e-6;

/** Money in reais with at most two decimals; it becomes integer cents before any arithmetic. */
export const money = numeric('Expected a number')
  .refine((n) => n > 0, 'Must be greater than zero')
  .refine((n) => n < 1e11, 'Out of range')
  .refine((n) => decimalPlaces(n, 2), 'At most two decimal places');

export const quantity = numeric('Expected a number')
  .refine((n) => n > 0, 'Must be greater than zero')
  .refine((n) => n < 1e9, 'Out of range')
  .refine((n) => decimalPlaces(n, 6), 'At most six decimal places');

const unitPrice = numeric('Expected a number')
  .refine((n) => n > 0, 'Must be greater than zero')
  .refine((n) => n < 1e8, 'Out of range')
  .refine((n) => decimalPlaces(n, 6), 'At most six decimal places');

const rate = numeric('Expected a number')
  .refine((n) => n > 0, 'Must be greater than zero')
  .refine((n) => n < 100000, 'Out of range')
  .refine((n) => decimalPlaces(n, 4), 'At most four decimal places');

export const investmentKindSchema = z.enum(['STOCK_EXCHANGE', 'FIXED_INCOME']);
export const indexerSchema = z.enum(['CDI', 'IPCA', 'SELIC', 'PREFIXED']);
export const movementTypeSchema = z.enum(['OPENING', 'BUY', 'SELL', 'INCOME']);

const ticker = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9.\-]{0,19}$/, 'Invalid ticker');
const name = z.string().trim().min(1).max(120);

/** Fields of a movement as the client sends them. Which ones are needed depends on the position kind (service). */
const movementFields = {
  type: movementTypeSchema,
  date: pastOrToday,
  quantity: quantity.optional(),
  unitPrice: unitPrice.optional(),
  amount: money.optional(),
  notes: z.string().trim().max(255).optional(),
  sourceRef: z.string().trim().min(1).max(120).optional(),
};

export const createMovementSchema = z.object(movementFields).strict();
export type CreateMovementInput = z.infer<typeof createMovementSchema>;

/** The initial load of a new position: an OPENING movement. */
const openingSchema = z
  .object({
    date: pastOrToday,
    quantity: movementFields.quantity,
    unitPrice: movementFields.unitPrice,
    amount: movementFields.amount,
    notes: movementFields.notes,
  })
  .strict();

const anchorSchema = z.object({ amount: z.preprocess((v) => (typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : v), z.number().finite().min(0).lt(1e11).refine((n) => decimalPlaces(n, 2), 'At most two decimal places')), date: pastOrToday }).strict();

export const createPositionSchema = z
  .object({
    kind: investmentKindSchema,
    ticker: ticker.optional(),
    name,
    savingsGoalId: z.string().uuid().nullable().optional(),
    indexer: indexerSchema.optional(),
    rate: rate.optional(),
    maturityDate: dayString.nullable().optional(),
    anchor: anchorSchema.nullable().optional(),
    opening: openingSchema.optional(),
  })
  .strict();
export type CreatePositionInput = z.infer<typeof createPositionSchema>;

export const updatePositionSchema = z
  .object({
    name: name.optional(),
    savingsGoalId: z.string().uuid().nullable().optional(),
    indexer: indexerSchema.optional(),
    rate: rate.optional(),
    maturityDate: dayString.nullable().optional(),
    anchor: anchorSchema.nullable().optional(),
    /** true ends the position (closedAt = today); false reopens it. */
    closed: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdatePositionInput = z.infer<typeof updatePositionSchema>;

export const accountParamsSchema = z.object({ accountId: z.string().uuid() });
export const positionParamsSchema = z.object({ positionId: z.string().uuid() });
export const movementParamsSchema = z.object({ positionId: z.string().uuid(), movementId: z.string().uuid() });
export const listPositionsQuerySchema = z.object({
  includeClosed: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});
