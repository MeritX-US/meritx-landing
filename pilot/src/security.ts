import type { Request, Response, NextFunction } from 'express';
import type { PilotConfig } from './config';

export const ROBOTS_TXT = 'User-agent: *\nDisallow: /\n';
export const X_ROBOTS = 'noindex, nofollow, noarchive, nosnippet, noimageindex';

/** Security + noindex headers on every response (static, API, errors). */
export function securityHeaders(cfg: PilotConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Robots-Tag', X_ROBOTS);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
      "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
    if (cfg.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.removeHeader('X-Powered-By');
    next();
  };
}

/** In production behind a TLS-terminating proxy, refuse plain HTTP. */
export function requireHttps(cfg: PilotConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (cfg.secureCookies && cfg.trustProxy && req.headers['x-forwarded-proto'] === 'http') {
      return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
    }
    next();
  };
}

function sameOrigin(req: Request, origin: string): boolean {
  const host = req.headers.host;
  if (!host) return false;
  const proto = req.protocol; // honours trust proxy
  return origin === `${proto}://${host}`;
}

/**
 * Strict CORS: no wildcard, ever. Cross-origin access only for origins listed in
 * PILOT_ALLOWED_ORIGINS (normally empty: the UI is served same-origin).
 * Also acts as CSRF defence: a state-changing request carrying a foreign Origin is rejected.
 */
export function strictCors(cfg: PilotConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (!origin) return next(); // non-browser client or same-origin GET
    const allowed = sameOrigin(req, origin) || cfg.allowedOrigins.includes(origin);
    if (!allowed) {
      if (req.method === 'OPTIONS' || !['GET', 'HEAD'].includes(req.method)) {
        return res.status(403).json({ error: 'origin not allowed' });
      }
      return next(); // GET from foreign origin: no CORS headers => browser blocks reading
    }
    if (!sameOrigin(req, origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Max-Age', '600');
        return res.status(204).end();
      }
    }
    next();
  };
}
