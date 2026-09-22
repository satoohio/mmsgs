import crypto from 'node:crypto';
import config from './config.js';

/* ------------------------------- Пароли ---------------------------------- */
/*
 * scrypt из node:crypto — без bcrypt/argon2 и нативной компиляции.
 * Формат хэша: scrypt$N$r$p$salt$hash (всё в hex/base64url), чтобы параметры
 * можно было менять без миграции старых записей.
 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(hashB64, 'base64url');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: 256 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/* --------------------------------- JWT ------------------------------------ */
/* Минимальная реализация HS256: header.payload.signature, base64url. */

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function sign(data) {
  return crypto.createHmac('sha256', config.jwtSecret).update(data).digest('base64url');
}

export function signToken(payload, ttlSec = config.tokenTtlSec) {
  const issued = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: issued, exp: issued + ttlSec };
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const data = `${head}.${b64u(JSON.stringify(body))}`;
  return `${data}.${sign(data)}`;
}

export function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const expected = sign(data);
  const a = Buffer.from(expected);
  const b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/* ------------------------------ Из запроса -------------------------------- */

export function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  // Для WebSocket-аплоадов и preview-ссылок допускаем ?token=
  if (req.query && typeof req.query.token === 'string') return req.query.token;
  return null;
}

/** Express- middleware: кладёт payload токена в req.auth, иначе 401. */
export function requireAuth(req, res, next) {
  const payload = verifyToken(extractToken(req));
  if (!payload || !payload.sub) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  req.auth = payload;
  req.userId = Number(payload.sub);
  next();
}

/* ------------------------------ Валидация --------------------------------- */

export const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,24}$/;
export const PASSWORD_MIN = 6;

export function validateRegistration({ username, password, displayName }) {
  const errors = [];
  if (!USERNAME_RE.test(String(username || ''))) {
    errors.push('Логин: 3–24 символа, только латиница, цифры, . _ -');
  }
  if (String(password || '').length < PASSWORD_MIN) {
    errors.push(`Пароль: минимум ${PASSWORD_MIN} символов`);
  }
  const name = String(displayName || username || '').trim();
  if (name.length < 2 || name.length > 48) errors.push('Имя: от 2 до 48 символов');
  return { errors, username: String(username || '').trim(), name };
}

export function sanitizeText(value, max = 4000) {
  return String(value ?? '')
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, max);
}

/** Псевдослучайный, но детерминированный цвет аватара из имени. */
export function colorFor(seed) {
  const palette = [
    '#6c8cff', '#ff7ab6', '#4fd1c5', '#f6ad55', '#a78bfa',
    '#f56565', '#48bb78', '#38bdf8', '#facc15', '#fb7185',
  ];
  const h = crypto.createHash('sha1').update(String(seed)).digest();
  return palette[h[0] % palette.length];
}
