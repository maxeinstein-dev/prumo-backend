/** A capture as the pairing rules see it: the stored reading is read defensively (it is JSON). */
export interface PairCandidate {
  id: string;
  package: string;
  status: string;
  postedAt: Date;
  parsed: unknown;
}

export interface Reading {
  kind: string;
  cents: number;
  warning: string | null;
}

/** kind, positive integer cents and the warning of a stored reading, or null when it has none of the first two. */
export function readingOf(parsed: unknown): Reading | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const { kind, amountCents, warning } = parsed as { kind?: unknown; amountCents?: unknown; warning?: unknown };
  if (typeof kind !== 'string' || typeof amountCents !== 'number' || !Number.isSafeInteger(amountCents) || amountCents <= 0) return null;
  return { kind, cents: amountCents, warning: typeof warning === 'string' ? warning : null };
}

/**
 * One to one, the closest pair first: every (left, right) of the same amount at most `windowMs` apart that `allowed`
 * accepts is a candidate; they are taken by the smallest gap (then the earlier left, then the id), skipping a side
 * already used. So two Pix of the same amount in the same minutes stay two pairs. Pure.
 */
export function pairClosest<L extends PairCandidate, R extends PairCandidate>(
  lefts: readonly L[],
  rights: readonly R[],
  windowMs: number,
  allowed: (left: L, right: R) => boolean = () => true,
): { left: L; right: R }[] {
  const options: { left: L; right: R; gap: number }[] = [];
  for (const left of lefts) {
    const cents = readingOf(left.parsed)!.cents;
    for (const right of rights) {
      if (readingOf(right.parsed)!.cents !== cents || !allowed(left, right)) continue;
      const gap = Math.abs(left.postedAt.getTime() - right.postedAt.getTime());
      if (gap <= windowMs) options.push({ left, right, gap });
    }
  }
  options.sort((a, b) => a.gap - b.gap || a.left.postedAt.getTime() - b.left.postedAt.getTime() || a.left.id.localeCompare(b.left.id));
  const usedLeft = new Set<string>();
  const usedRight = new Set<string>();
  const chosen: { left: L; right: R }[] = [];
  for (const option of options) {
    if (usedLeft.has(option.left.id) || usedRight.has(option.right.id)) continue;
    usedLeft.add(option.left.id);
    usedRight.add(option.right.id);
    chosen.push(option);
  }
  return chosen.sort((a, b) => a.left.postedAt.getTime() - b.left.postedAt.getTime() || a.left.id.localeCompare(b.left.id));
}
