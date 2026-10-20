
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { createReadStream, statSync } from 'node:fs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';

const PUBLIC_FILES = new Set([
  'index.html',
  'style.css',
  'app.js'
]);

// The only required Groq environment variable.
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

// Internal model configuration. The browser only displays Lumina-1.0.
const GROQ_MODEL_ID = 'openai/gpt-oss-120b';
const GROQ_URL =
  'https://api.groq.com/openai/v1/chat/completions';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

const rateLimits = new Map();

const MAX_BODY_BYTES = 256 * 1024;
const INPUT_TOKEN_BUDGET = 4800;
const MAX_OUTPUT_TOKENS = 2048;

// Keep product messaging separate from the internal model identifier.
const SYSTEM_PROMPTS = {
  chat:
    'You are Lumina-1.0, developed by Reason Intelligence, founded by Vince Dipisa. ' +
    'Be helpful, accurate and candid. Identify the product as Lumina-1.0. ' +
    'Do not unnecessarily disclose internal routing identifiers. ' +
    'Never claim to have performed an action unless it actually happened.',

  code:
    'You are Lumina-1.0 in coding mode. ' +
    'Provide complete files with filenames when creating software. ' +
    'Keep explanations outside code blocks. Never claim code was executed, ' +
    'tested or deployed unless it actually happened. ' +
    'Prefer maintainable HTML, CSS and JavaScript where suitable. ' +
    'Lumina-1.0 is developed by Reason Intelligence, founded by Vince Dipisa. ' +
    'Identify the product as Lumina-1.0.'
};

function json(res, status, data, additionalHeaders = {}) {
  if (res.writableEnded) return;

  const bytes = Buffer.from(JSON.stringify(data));

  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': bytes.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...additionalHeaders
  });

  res.end(bytes);
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()'
  );
}

function checkOrigin(req, res) {
  const origin = req.headers.origin;

  // Requests without Origin are allowed for non-browser clients.
  if (!origin) return true;

  try {
    const originHost = new URL(origin).host.toLowerCase();
    const requestHost = String(req.headers.host || '').toLowerCase();

    if (originHost === requestHost) return true;
  } catch {
    // Reject malformed origins below.
  }

  json(res, 403, { error: 'Cross-origin request rejected.' });
  return false;
}

function rateLimit(req, res, name, perMinute = 30, perDay = 200) {
  const key = `${name}:${req.socket?.remoteAddress || 'unknown'}`;
  const now = Date.now();
  const day = Math.floor(now / 86400000);

  let bucket = rateLimits.get(key);

  if (!bucket || bucket.day !== day) {
    bucket = {
      day,
      minuteStart: now,
      minuteCount: 0,
      dayCount: 0
    };
  }

  if (now - bucket.minuteStart >= 60000) {
    bucket.minuteStart = now;
    bucket.minuteCount = 0;
  }

  bucket.minuteCount++;
  bucket.dayCount++;
  rateLimits.set(key, bucket);

  if (rateLimits.size > 10000) {
    for (const [storedKey, value] of rateLimits) {
      if (now - value.minuteStart > 86400000) {
        rateLimits.delete(storedKey);
      }
    }
  }

  if (
    bucket.minuteCount > perMinute ||
    bucket.dayCount > perDay
  ) {
    json(
      res,
      429,
      { error: 'Rate limit reached. Please retry shortly.' },
      { 'Retry-After': '60' }
    );

    return false;
  }

  return true;
}

async function readJSON(req) {
  const declared = Number(req.headers['content-length'] || 0);

  if (declared > MAX_BODY_BYTES) {
    throw Object.assign(
      new Error('Request body is too large.'),
      { status: 413 }
    );
  }

  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;

    if (total > MAX_BODY_BYTES) {
      throw Object.assign(
        new Error('Request body is too large.'),
        { status: 413 }
      );
    }

    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(
      new Error('Request body must be valid JSON.'),
      { status: 400 }
    );
  }
}

function validateMessages(body) {
  if (
    !body ||
    !Array.isArray(body.messages) ||
    body.messages.length < 1 ||
    body.messages.length > 40
  ) {
    throw Object.assign(
      new Error('messages must contain between 1 and 40 messages.'),
      { status: 400 }
    );
  }

  let totalCharacters = 0;

  const messages = body.messages.map((message, index) => {
    if (
      !message ||
      typeof message !== 'object' ||
      !['user', 'assistant'].includes(message.role) ||
      typeof message.content !== 'string'
    ) {
      throw Object.assign(
        new Error(`Invalid message ${index + 1}.`),
        { status: 400 }
      );
    }

    const content = message.content.trim();

    if (!content || content.length > 50000) {
      throw Object.assign(
        new Error(`Message ${index + 1} is empty or too large.`),
        { status: 400 }
      );
    }

    totalCharacters += content.length;

    return { role: message.role, content };
  });

  if (totalCharacters > 180000) {
    throw Object.assign(
      new Error('Conversation is too large.'),
      { status: 413 }
    );
  }

  return messages;
}

// Conservative token estimate: this is not the model's exact tokenizer.
function estimateTokens(value) {
  return Math.ceil(Buffer.byteLength(String(value), 'utf8') / 2.5);
}

function shortenText(text, maxBytes) {
  const source = String(text);

  if (Buffer.byteLength(source, 'utf8') <= maxBytes) {
    return source;
  }

  const marker = '\n\n[Earlier or excess text omitted]\n\n';
  const available = Math.max(
    0,
    maxBytes - Buffer.byteLength(marker, 'utf8')
  );

  const chars = Array.from(source);
  const leftBudget = Math.floor(available * 0.7);
  const rightBudget = available - leftBudget;

  let left = '';
  let leftBytes = 0;

  for (const char of chars) {
    const size = Buffer.byteLength(char, 'utf8');

    if (leftBytes + size > leftBudget) break;

    left += char;
    leftBytes += size;
  }

  let right = '';
  let rightBytes = 0;

  for (let i = chars.length - 1; i >= 0; i--) {
    const char = chars[i];
    const size = Buffer.byteLength(char, 'utf8');

    if (rightBytes + size > rightBudget) break;

    right = char + right;
    rightBytes += size;
  }

  return left + marker + right;
}

function fitConversation(messages, systemPrompt) {
  let remaining =
    INPUT_TOKEN_BUDGET - estimateTokens(systemPrompt) - 100;

  remaining = Math.max(256, remaining);

  const newestFirst = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const cost = estimateTokens(message.content) + 8;

    if (cost <= remaining) {
      newestFirst.push(message);
      remaining -= cost;
      continue;
    }

    // Preserve the latest user request even when it is unusually long.
    if (newestFirst.length === 0) {
      const maxBytes = Math.max(256, Math.floor(remaining * 2.5));

      newestFirst.push({
        role: message.role,
        content: shortenText(message.content, maxBytes)
      });
    }

    break;
  }

  return newestFirst.reverse();
}

function sanitizeText(text) {
  return String(text)
    .replace(
      /(?:openai\s*\/\s*)?gpt[\s_-]*oss(?:[\s_-]*model)?[\s_-]*120b/gi,
      'Lumina-1.0'
    )
    .replace(/\bopenai\b/gi, 'inference provider');
}

function sanitizePayload(value, key = '') {
  if (
    /^(?:model|model_id|model_name|base_model|base_model_id)$/i
      .test(key)
  ) {
    return 'Lumina-1.0';
  }

  if (typeof value === 'string') {
    return sanitizeText(value);
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitizePayload(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(
        ([name, item]) => [name, sanitizePayload(item, name)]
      )
    );
  }

  return value;
}

// Convert each complete SSE event to public-safe JSON.
function publicStreamFilter() {
  let buffer = '';

  function processEvent(eventText) {
    const lines = eventText.split(/\r?\n/);
    const dataLines = lines.filter(line => line.startsWith('data:'));

    if (!dataLines.length) {
      return sanitizeText(eventText) + '\n\n';
    }

    const raw = dataLines
      .map(line => line.slice(5).replace(/^ /, ''))
      .join('\n');

    if (raw.trim() === '[DONE]') {
      return 'data: [DONE]\n\n';
    }

    try {
      const payload = sanitizePayload(JSON.parse(raw));
      const metadata = lines.filter(line => !line.startsWith('data:'));
      const prefix = metadata.length
        ? metadata.join('\n') + '\n'
        : '';

      return prefix + 'data: ' + JSON.stringify(payload) + '\n\n';
    } catch {
      return 'data: ' + sanitizeText(raw) + '\n\n';
    }
  }

  return new Transform({
    transform(chunk, encoding, callback) {
      buffer += chunk.toString('utf8');

      const output = [];

      let boundary;

      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        output.push(processEvent(buffer.slice(0, boundary)));
        buffer = buffer.slice(boundary + 2);
      }

      callback(null, output.join(''));
    },

    flush(callback) {
      let output = '';

      if (buffer.trim()) {
        output += processEvent(buffer);
      }

      callback(null, output);
    }
  });
}

async function handleChat(req, res) {
  if (!checkOrigin(req, res)) return;

  if (!rateLimit(req, res, 'chat', 30, Number(process.env.CHAT_DAILY_LIMIT || 200))) {
    return;
  }

  if (!GROQ_API_KEY) {
    return json(res, 503, {
      error: 'Chat is not configured. Add GROQ_API_KEY to the server environment.'
    });
  }

  let body;

  try {
    body = await readJSON(req);
  } catch (error) {
    return json(res, error.status || 400, { error: error.message });
  }

  let messages;

  try {
    messages = validateMessages(body);
  } catch (error) {
    return json(res, error.status || 400, { error: error.message });
  }

  const mode = body.mode === 'code' ? 'code' : 'chat';
  const systemPrompt = SYSTEM_PROMPTS[mode];
  const boundedMessages = fitConversation(messages, systemPrompt);

  const requestedTokens = Number(body.max_completion_tokens);
  const maxTokens =
    Number.isFinite(requestedTokens) && requestedTokens > 0
      ? Math.min(MAX_OUTPUT_TOKENS, Math.max(256, Math.floor(requestedTokens)))
      : MAX_OUTPUT_TOKENS;

  const payload = {
    model: GROQ_MODEL_ID,
    messages: [
      { role: 'system', content: systemPrompt },
      ...boundedMessages
    ],
    stream: body.stream !== false,
    max_completion_tokens: maxTokens,
    reasoning_effort: ['low', 'medium', 'high'].includes(body.effort)
      ? body.effort
      : 'medium'
  };

  let upstream;

  try {
    upstream = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: payload.stream
          ? 'text/event-stream'
          : 'application/json'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120000)
    });
  } catch (error) {
    return json(res, 502, {
      error: error.name === 'TimeoutError'
        ? 'Lumina request timed out. Please retry.'
        : 'Could not connect to the configured chat service.'
    });
  }

  if (!upstream.ok) {
    let details = '';

    try {
      const result = await upstream.json();

      details = String(
        result?.error?.message || result?.message || ''
      );
    } catch {
      // Do not expose arbitrary upstream response content.
    }

    if (
      upstream.status === 413 ||
      /request too large|tokens per minute|\bTPM\b|requested \d+.*limit/i.test(details)
    ) {
      return json(res, 413, {
        error:
          'This conversation exceeded the available request budget. ' +
          'Lumina trims older conversation history automatically. ' +
          'Retry or start a new chat.'
      });
    }

    return json(res, 502, {
      error: `Lumina could not complete the request (HTTP ${upstream.status}). Please retry shortly.`
    });
  }

  if (!payload.stream) {
    const result = await upstream.json().catch(() => null);

    if (!result) {
      return json(res, 502, {
        error: 'The chat service returned an unreadable response.'
      });
    }

    return json(res, 200, sanitizePayload(result));
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff'
  });

  res.flushHeaders?.();

  try {
    Readable.fromWeb(upstream.body)
      .pipe(publicStreamFilter())
      .pipe(res);
  } catch {
    if (!res.headersSent) {
      json(res, 502, { error: 'Could not stream the response.' });
    } else {
      res.end();
    }
  }

  res.on('close', () => {
    if (!res.writableEnded) {
      upstream.body?.cancel?.().catch?.(() => {});
    }
  });
}

function health(_req, res) {
  json(res, 200, {
    status: 'ok',
    product: 'Lumina-1.0',
    modelLabel: 'Lumina-1.0',
    chatReady: Boolean(GROQ_API_KEY),
    timestamp: new Date().toISOString()
  });
}

function serveStatic(req, res) {
  let pathname;

  try {
    pathname = decodeURIComponent(
      new URL(req.url, 'http://localhost').pathname
    );
  } catch {
    return json(res, 400, { error: 'Invalid URL.' });
  }

  if (pathname === '/') pathname = '/index.html';

  const filename = pathname.startsWith('/')
    ? pathname.slice(1)
    : pathname;

  // Only expose the public browser app files.
  if (
    !PUBLIC_FILES.has(filename) ||
    filename.includes('/') ||
    filename.includes('\\')
  ) {
    return json(res, 404, { error: 'Not found.' });
  }

  const fullPath = path.join(ROOT, filename);
  let stat;

  try {
    stat = statSync(fullPath);
  } catch {
    return json(res, 404, { error: 'Not found.' });
  }

  if (!stat.isFile()) {
    return json(res, 404, { error: 'Not found.' });
  }

  res.writeHead(200, {
    'Content-Type': MIME[path.extname(fullPath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': path.extname(fullPath) === '.html' ? 'no-store' : 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff'
  });

  if (req.method === 'HEAD') return res.end();

  createReadStream(fullPath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  setSecurityHeaders(res);

  try {
    const url = new URL(
      req.url,
      `http://${req.headers.host || 'localhost'}`
    );

    if (url.pathname === '/api/health' && req.method === 'GET') {
      return health(req, res);
    }

    if (url.pathname === '/api/chat' && req.method === 'POST') {
      return await handleChat(req, res);
    }

    if (url.pathname.startsWith('/api/')) {
      return json(res, 404, { error: 'API route not found.' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(
        res,
        405,
        { error: 'Method not allowed.' },
        { Allow: 'GET, HEAD' }
      );
    }

    return serveStatic(req, res);
  } catch (error) {
    if (res.headersSent) return res.end();

    return json(res, error.status || 500, {
      error: error.status ? error.message : 'Unexpected server error.'
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Lumina-1.0 listening on ${HOST}:${PORT}`);
  console.log(`Groq API key configured: ${Boolean(GROQ_API_KEY)}`);
});

export { server };
