/** Today as a UTC date-only value, comparable with @db.Date columns (stored as UTC midnight). */
export function utcToday(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
