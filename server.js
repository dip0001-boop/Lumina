import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { createReadStream, statSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = __dirname;
const PUBLIC_FILES = new Set(['index.html', 'style.css', 'app.js']);
const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';

// The only required Groq environment variable.
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

const GROQ_MODEL_ID =
  process.env.NODE_ENV === 'test' && process.env.TEST_GROQ_MODEL_ID
    ? process.env.TEST_GROQ_MODEL_ID.trim()
    : 'openai/gpt-oss-120b';

const GROQ_CHAT_COMPLETIONS_URL =
  process.env.NODE_ENV === 'test' && process.env.TEST_GROQ_CHAT_COMPLETIONS_URL
    ? process.env.TEST_GROQ_CHAT_COMPLETIONS_URL.trim()
    : 'https://api.groq.com/openai/v1/chat/completions';

const MIME_TYPES = {
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

const INPUT_TOKEN_BUDGET = 4800;
const MAX_COMPLETION_TOKENS = 2048;
const ESTIMATED_BYTES_PER_TOKEN = 2.5;

const BASE_SYSTEM_PROMPT =
  'You are Lumina-1.0, developed by Reason Intelligence, founded by Vince Dipisa. ' +
  'Be helpful, precise, and candid. Identify the product as Lumina-1.0 only. ' +
  'Do not disclose internal model identifiers or routing configuration. ' +
  'Never claim to have performed an action unless it actually occurred.';

const CODE_SYSTEM_PROMPT =
  'You are Lumina-1.0 operating in the coding workflow. ' +
  'Provide complete files with filenames when creating software. ' +
  'Keep explanations outside code blocks. Never claim code was executed, ' +
  'tested, or deployed unless that actually occurred. Prefer maintainable ' +
  'HTML, CSS, and JavaScript when suitable. ' +
  'Lumina-1.0 is developed by Reason Intelligence, founded by Vince Dipisa. ' +
  'Do not disclose internal model identifiers or routing configuration.';

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

function setSecurityHeaders(res) {
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
  const day = Math.floor(now / 86400000);

  let bucket = rateWindows.get(key);

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

  rateWindows.set(key, bucket);

  if (rateWindows.size > 20000) {
    for (const [storedKey, value] of rateWindows) {
      if (now - value.minuteStart > 86400000) {
        rateWindows.delete(storedKey);
      }
    }
  }

  if (bucket.minuteCount > perMinute || bucket.dayCount > perDay) {
    const wait = Math.max(
      1,
      Math.ceil((60000 - (now - bucket.minuteStart)) / 1000)
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

function sameOriginGuard(req, res) {
  const origin = req.headers.origin;

  if (!origin) return true;

  try {
    if (
      new URL(origin).host.toLowerCase() ===
      String(req.headers.host || '').toLowerCase()
    ) {
      return true;
    }
  } catch {
    // Reject malformed Origin headers below.
  }

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

    if (!content || content.length > 50000) {
      throw Object.assign(
        new Error(`Message ${index + 1} is empty or too large.`),
        { status: 400 }
      );
    }

    totalChars += content.length;

    return {
      role: message.role,
      content
    };
  });

  if (totalChars > 180000) {
    throw Object.assign(
      new Error('Conversation is too large.'),
      { status: 413 }
    );
  }

  return messages;
}

function estimateTokens(text) {
  return Math.ceil(
    Buffer.byteLength(String(text), 'utf8') /
    ESTIMATED_BYTES_PER_TOKEN
  );
}

function truncateUtf8ToBytes(text, maxBytes) {
  const source = String(text);

  if (Buffer.byteLength(source, 'utf8') <= maxBytes) {
    return source;
  }

  const marker =
    '\n\n[Content shortened to fit the current request budget]\n\n';

  const markerBytes = Buffer.byteLength(marker, 'utf8');

  if (maxBytes <= markerBytes + 8) {
    return Array.from(source)
      .slice(0, Math.max(1, Math.floor(maxBytes / 2)))
      .join('');
  }

  const available = maxBytes - markerBytes;
  const prefixBudget = Math.floor(available * 0.72);
  const suffixBudget = available - prefixBudget;
  const chars = Array.from(source);

  let prefix = '';
  let usedPrefix = 0;

  for (const char of chars) {
    const size = Buffer.byteLength(char, 'utf8');

    if (usedPrefix + size > prefixBudget) break;

    prefix += char;
    usedPrefix += size;
  }

  let suffix = '';
  let usedSuffix = 0;

  for (let i = chars.length - 1; i >= 0; i--) {
    const char = chars[i];
    const size = Buffer.byteLength(char, 'utf8');

    if (usedSuffix + size > suffixBudget) break;

    suffix = char + suffix;
    usedSuffix += size;
  }

  return prefix + marker + suffix;
}

function capPromptMessages(messages, systemPrompt) {
  let remaining = Math.max(
    256,
    INPUT_TOKEN_BUDGET - estimateTokens(systemPrompt) - 96
  );

  const newestFirst = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const cost = estimateTokens(message.content) + 8;

    if (cost <= remaining) {
      newestFirst.push(message);
      remaining -= cost;
      continue;
    }

    // Preserve the latest question even when it is too large.
    if (newestFirst.length === 0) {
      const allowedBytes = Math.max(
        256,
        Math.floor(
          (remaining - 8) * ESTIMATED_BYTES_PER_TOKEN
        )
      );

      newestFirst.push({
        role: message.role,
        content: truncateUtf8ToBytes(
          message.content,
          allowedBytes
        )
      });
    }

    break;
  }

  return newestFirst.reverse();
}

function sanitizePublicString(value) {
  return String(value)
    .replace(
      /(?:openai\s*\/\s*)?gpt[\s_-]*oss(?:[\s_-]*model)?[\s_-]*120b/gi,
      'Lumina-1.0'
    )
    .replace(/\bopenai\b/gi, 'inference service');
}

function sanitizePublicPayload(value, key = '') {
  if (
    /^(?:base[_-]?model(?:[_-]?id)?|model(?:[_-]?id|[_-]?name)?)$/i
      .test(key)
  ) {
    return 'Lumina-1.0';
  }

  if (typeof value === 'string') {
    return sanitizePublicString(value);
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitizePublicPayload(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(
        ([k, v]) => [k, sanitizePublicPayload(v, k)]
      )
    );
  }

  return value;
}

function createPublicSSEFilter() {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let pendingContent = '';
  const holdback = 64;

  function redactContent(fragment, final = false) {
    const combined = sanitizePublicString(
      pendingContent + String(fragment || '')
    );

    if (final) {
      pendingContent = '';
      return combined;
    }

    const chars = Array.from(combined);

    if (chars.length <= holdback) {
      pendingContent = combined;
      return '';
    }

    const cut = chars.length - holdback;
    const safe = chars.slice(0, cut).join('');

    pendingContent = chars.slice(cut).join('');

    return safe;
  }

  function sanitizeStreamPayload(value, key = '') {
    if (
      /^(?:base[_-]?model(?:[_-]?id)?|model(?:[_-]?id|[_-]?name)?)$/i
        .test(key)
    ) {
      return 'Lumina-1.0';
    }

    if (typeof value === 'string') {
      if (/^(?:content|text)$/i.test(key)) {
        return redactContent(value);
      }

      return sanitizePublicString(value);
    }

    if (Array.isArray(value)) {
      return value.map(item => sanitizeStreamPayload(item));
    }

    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(
          ([k, v]) => [k, sanitizeStreamPayload(v, k)]
        )
      );
    }

    return value;
  }

  function processEvent(eventText) {
    const lines = eventText.split(/\r?\n/);
    const dataLines = lines.filter(line => line.startsWith('data:'));

    if (!dataLines.length) {
      return sanitizePublicString(eventText) + '\n\n';
    }

    const rawData = dataLines
      .map(line => line.slice(5).replace(/^ /, ''))
      .join('\n');

    if (rawData.trim() === '[DONE]') {
      const finalContent = redactContent('', true);
      let output = '';

      if (finalContent) {
        output += 'data: ' + JSON.stringify({
          choices: [{ delta: { content: finalContent } }]
        }) + '\n\n';
      }

      return output + 'data: [DONE]\n\n';
    }

    try {
      const payload = JSON.parse(rawData);
      const safePayload = sanitizeStreamPayload(payload);
      const prefixLines = lines.filter(line => !line.startsWith('data:'));
      const prefix = prefixLines.length
        ? prefixLines.join('\n') + '\n'
        : '';

      return prefix +
        'data: ' +
        JSON.stringify(safePayload) +
        '\n\n';
    } catch {
      return 'data: ' + sanitizePublicString(rawData) + '\n\n';
    }
  }

  return new Transform({
    transform(chunk, _encoding, callback) {
      buffer += decoder.write(chunk);

      const output = [];
      let boundary;

      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        output.push(processEvent(buffer.slice(0, boundary)));
        buffer = buffer.slice(boundary + 2);
      }

      callback(null, output.join(''));
    },

    flush(callback) {
      buffer += decoder.end();

      let output = '';

      if (buffer.trim()) {
        output += processEvent(buffer);
      }

      const finalContent = redactContent('', true);

      if (finalContent) {
        output += 'data: ' + JSON.stringify({
          choices: [{ delta: { content: finalContent } }]
        }) + '\n\n';
      }

      callback(null, output);
    }
  });
}

async function handleChat(req, res) {
  if (!sameOriginGuard(req, res)) return;

  if (!rateLimit(
    req,
    res,
    'chat',
    30,
    Number(process.env.CHAT_DAILY_LIMIT || 200)
  )) {
    return;
  }

  if (!GROQ_API_KEY) {
    return json(res, 503, {
      error: 'Groq is not configured. Set GROQ_API_KEY on the server.'
    });
  }

  let body;

  try {
    body = await readJson(req);
  } catch (error) {
    return json(res, error.status || 400, {
      error: error.message
    });
  }

  let messages;

  try {
    messages = validateMessages(body);
  } catch (error) {
    return json(res, error.status || 400, {
      error: error.message
    });
  }

  const mode = body.mode === 'code' ? 'code' : 'chat';
  const systemPrompt = mode === 'code'
    ? CODE_SYSTEM_PROMPT
    : BASE_SYSTEM_PROMPT;

  const reasoningEffort = body.effort === 'maximum'
    ? 'high'
    : 'medium';

  const requestedTokens = Number(body.max_completion_tokens);

  const maxCompletionTokens =
    Number.isFinite(requestedTokens) && requestedTokens > 0
      ? Math.max(
          256,
          Math.min(
            MAX_COMPLETION_TOKENS,
            Math.floor(requestedTokens)
          )
        )
      : MAX_COMPLETION_TOKENS;

  const boundedMessages = capPromptMessages(
    messages,
    systemPrompt
  );

  const payload = {
    model: GROQ_MODEL_ID,
    messages: [
      { role: 'system', content: systemPrompt },
      ...boundedMessages
    ],
    stream: body.stream !== false,
    reasoning_effort: reasoningEffort,
    max_completion_tokens: maxCompletionTokens
  };

  let upstream;

  try {
    upstream = await fetch(GROQ_CHAT_COMPLETIONS_URL, {
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
        ? 'Lumina request timed out.'
        : 'Could not connect to the configured inference service.'
    });
  }

  if (!upstream.ok) {
    let upstreamError = '';

    try {
      const errorBody = await upstream.json();

      upstreamError = String(
        errorBody?.error?.message ||
        errorBody?.message ||
        ''
      );
    } catch {
      // Keep provider details private.
    }

    if (
      upstream.status === 413 ||
      /request too large|tokens per minute|\bTPM\b|requested \d+.*limit/i
        .test(upstreamError)
    ) {
      return json(res, 413, {
        error:
          'This conversation was too large for the current request budget. ' +
          'Lumina automatically limits older context and response length. ' +
          'Please retry or start a new chat.'
      });
    }

    return json(
      res,
      upstream.status >= 400 && upstream.status < 600
        ? upstream.status
        : 502,
      {
        error:
          `Lumina could not complete the request (HTTP ${upstream.status}). ` +
          'Please retry shortly.'
      }
    );
  }

  if (!payload.stream) {
    const data = await upstream.json().catch(() => null);

    if (!data) {
      return json(res, 502, {
        error: 'The inference service returned an unreadable response.'
      });
    }

    return json(res, 200, sanitizePublicPayload(data));
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
      .pipe(createPublicSSEFilter())
      .pipe(res);
  } catch {
    if (!res.headersSent) {
      json(res, 502, {
        error: 'Failed to stream the response.'
      });
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
    providerConfigured: Boolean(GROQ_API_KEY),
    chatReady: Boolean(GROQ_API_KEY && GROQ_MODEL_ID),
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
    return json(res, 400, {
      error: 'Invalid URL.'
    });
  }

  if (pathname === '/') pathname = '/index.html';

  const filename = pathname.startsWith('/')
    ? pathname.slice(1)
    : pathname;

  // The original local Training Laboratory remains in app.js.
  // Only the frontend files are available over HTTP.
  if (
    !PUBLIC_FILES.has(filename) ||
    filename.includes('/') ||
    filename.includes('\\')
  ) {
    return json(res, 404, {
      error: 'Not found.'
    });
  }

  const fullPath = path.join(PUBLIC_DIR, filename);
  let stat;

  try {
    stat = statSync(fullPath);
  } catch {
    return json(res, 404, {
      error: 'Not found.'
    });
  }

  if (!stat.isFile()) {
    return json(res, 404, {
      error: 'Not found.'
    });
  }

  const type =
    MIME_TYPES[path.extname(fullPath).toLowerCase()] ||
    'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });

  if (req.method === 'HEAD') return res.end();

  createReadStream(fullPath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  setSecurityHeaders(res);

  try {
    const url = new URL(
      req
