import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = __dirname;
const PUBLIC_FILES = new Set(['index.html', 'style.css', 'app.js']);

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL_ID = (process.env.GROQ_MODEL_ID || '').trim();
const GROQ_CHAT_COMPLETIONS_URL =
  (process.env.GROQ_CHAT_COMPLETIONS_URL || '').trim();

const FINE_TUNING_SERVICE_URL =
  (process.env.FINE_TUNING_SERVICE_URL || '').replace(/\/+$/, '');

const FINE_TUNING_SERVICE_TOKEN =
  process.env.FINE_TUNING_SERVICE_TOKEN || '';

const FINE_TUNE_ADMIN_TOKEN =
  process.env.FINE_TUNE_ADMIN_TOKEN || '';

const MAX_DATASET_BYTES = parseByteLimit(
  process.env.MAX_TUNING_DATASET_BYTES,
  2 * 1024 * 1024 * 1024
);

function parseByteLimit(raw, fallback) {
  if (!raw) return fallback;

  const n = Number(raw);

  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

const rateWindows = new Map();

function json(res, status, value, extraHeaders = {}) {
  const bytes = Buffer.from(JSON.stringify(value));

  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': bytes.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  });

  res.end(bytes);
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()'
  );
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

function clientIp(req) {
  return req.socket?.remoteAddress || 'unknown';
}

function rateLimit(req, res, bucketName, perMinute, perDay = 300) {
  const key = `${bucketName}:${clientIp(req)}`;
  const now = Date.now();
  const day = Math.floor(now / 86_400_000);

  let bucket = rateWindows.get(key);

  if (!bucket || bucket.day !== day) {
    bucket = {
      day,
      minuteStart: now,
      minuteCount: 0,
      dayCount: 0
    };
  }

  if (now - bucket.minuteStart >= 60_000) {
    bucket.minuteStart = now;
    bucket.minuteCount = 0;
  }

  bucket.minuteCount += 1;
  bucket.dayCount += 1;

  rateWindows.set(key, bucket);

  if (rateWindows.size > 20_000) {
    for (const [k, v] of rateWindows) {
      if (now - v.minuteStart > 86_400_000) {
        rateWindows.delete(k);
      }
    }
  }

  if (
    bucket.minuteCount > perMinute ||
    bucket.dayCount > perDay
  ) {
    const wait = Math.max(
      1,
      Math.ceil(
        (60_000 - (now - bucket.minuteStart)) / 1000
      )
    );

    json(
      res,
      429,
      { error: 'Rate limit reached. Please try again later.' },
      { 'Retry-After': String(wait) }
    );

    return false;
  }

  return true;
}

function originIsAllowed(req) {
  const origin = req.headers.origin;

  if (!origin) return true;

  const host = req.headers.host;

  try {
    return (
      new URL(origin).host.toLowerCase() ===
      String(host || '').toLowerCase()
    );
  } catch {
    return false;
  }
}

function sameOriginGuard(req, res) {
  if (originIsAllowed(req)) return true;

  json(res, 403, {
    error: 'Cross-origin request rejected.'
  });

  return false;
}

async function readJson(req, maxBytes = 256 * 1024) {
  const declared = Number(req.headers['content-length'] || 0);

  if (declared > maxBytes) {
    throw Object.assign(
      new Error('Request body is too large.'),
      { status: 413 }
    );
  }

  let total = 0;
  const chunks = [];

  for await (const chunk of req) {
    total += chunk.length;

    if (total > maxBytes) {
      throw Object.assign(
        new Error('Request body is too large.'),
        { status: 413 }
      );
    }

    chunks.push(chunk);
  }

  try {
    return JSON.parse(
      Buffer.concat(chunks).toString('utf8')
    );
  } catch {
    throw Object.assign(
      new Error('Request body must be valid JSON.'),
      { status: 400 }
    );
  }
}

function safeMessageList(body) {
  if (
    !body ||
    !Array.isArray(body.messages) ||
    body.messages.length < 1 ||
    body.messages.length > 40
  ) {
    throw Object.assign(
      new Error('messages must contain 1–40 messages.'),
      { status: 400 }
    );
  }

  let totalChars = 0;

  const messages = body.messages.map((message, index) => {
    if (
      !message ||
      typeof message !== 'object' ||
      !['user', 'assistant'].includes(message.role) ||
      typeof message.content !== 'string'
    ) {
      throw Object.assign(
        new Error(`Invalid message at position ${index + 1}.`),
        { status: 400 }
      );
    }

    const content = message.content.trim();

    if (!content || content.length > 50_000) {
      throw Object.assign(
