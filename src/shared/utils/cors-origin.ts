export interface CorsOriginOptions {
  isProduction: boolean;
  /** Comma-separated list of extra origins (exact match), from ALLOWED_ORIGINS. */
  allowedOrigins?: string;
}

export interface CorsOriginDecision {
  allowed: boolean;
  reason: 'localhost' | 'recta.app' | 'development' | 'allowed-origins' | 'rejected';
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const RECTA_HOST = 'recta.app';

/**
 * Decides whether a browser Origin may call the API. Hosts are compared exactly (parsed with `new URL`), never by
 * substring: `https://recta.app.evil.com` and `http://evil-localhost.x` are refused.
 * Local hosts keep any scheme and port (the Capacitor app sends `https://localhost` or `capacitor://localhost`).
 */
export function checkCorsOrigin(origin: string, options: CorsOriginOptions): CorsOriginDecision {
  let hostname: string | null = null;
  try {
    hostname = new URL(origin).hostname.toLowerCase();
  } catch {
    hostname = null;
  }

  if (hostname !== null) {
    if (LOCAL_HOSTS.has(hostname)) return { allowed: true, reason: 'localhost' };
    if (hostname === RECTA_HOST || hostname.endsWith(`.${RECTA_HOST}`)) return { allowed: true, reason: 'recta.app' };
  }

  if (!options.isProduction) return { allowed: true, reason: 'development' };

  const list = (options.allowedOrigins ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  if (list.includes(origin)) return { allowed: true, reason: 'allowed-origins' };

  return { allowed: false, reason: 'rejected' };
}
