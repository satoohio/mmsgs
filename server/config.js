import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/**
 * Секрет подписи токенов. Берётся из окружения, иначе генерируется один раз
 * и persists в data/.secret — чтобы сессии не слетали при перезапуске.
 */
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(DATA_DIR, '.secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* первого запуска — файла ещё нет */
  }
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export const config = {
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 3000),
  dataDir: DATA_DIR,
  uploadDir: UPLOAD_DIR,
  dbFile: process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(DATA_DIR, 'mmsgs.sqlite'),
  jwtSecret: loadSecret(),
  tokenTtlSec: Number(process.env.TOKEN_TTL_SEC || 60 * 60 * 24 * 30), // 30 дней
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 8 * 1024 * 1024), // 8 МБ
  pageLimit: 50,
  maxPageLimit: 200,
};

export default config;
