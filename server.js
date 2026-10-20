
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

// Only one required environment variable for Groq chat.
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

// The model and endpoint are configured in this file.
const GROQ_MODEL_ID = 'openai/gpt-oss-120b';

const GROQ_CHAT_COMPLETIONS_URL =
  'https://api.groq.com/openai/v1/chat/completions';

// Optional fine-tuning worker configuration.
// These are not required for ordinary Groq chat.
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

  return Number.isSafeInteger(n) && n > 0
    ? n
    : fallback;
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
  res.setHeader(
    'Referrer-Policy',
    'strict-origin-when-cross-origin'
  );
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()'
  );

  res.setHeader(
    'Cross-Origin-Resource-Policy',
    'same-origin'
  );
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

  // Requests without Origin can still be made by non-browser clients.
  if (!origin) return true;

  try {
    return (
      new URL(origin).host.toLowerCase() ===
      String(req.headers.host || '').toLowerCase()
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
  const declared = Number(
    req.headers['content-length'] || 0
  );

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

    if (!content || content.length > 50_000) {
      throw Object.assign(
        new Error(
          `Message ${index + 1} is empty or too large.`
        ),
        { status: 400 }
      );
    }

    totalChars += content.length;

    return {
      role: message.role,
      content
    };
  });

  if (totalChars > 180_000) {
    throw Object.assign(
      new Error('Conversation is too large.'),
      { status: 413 }
    );
  }

  return messages;
}

const BASE_SYSTEM_PROMPT =
  'You are Lumina-1.0, developed by Reason Intelligence, ' +
  'founded by Vince Dipisa. Be helpful, precise, and candid. ' +
  'Answer honestly. Do not claim to have performed actions ' +
  'that you have not actually performed.';

const CODE_SYSTEM_PROMPT =
  'You are Lumina-1.0 operating in a coding workflow. ' +
  'Provide complete files with filenames when creating software. ' +
  'Keep explanations outside code blocks. Do not claim code was ' +
  'executed, tested, or deployed unless that actually occurred. ' +
  'Prefer maintainable HTML, CSS, and JavaScript where suitable. ' +
  'Lumina-1.0 is developed by Reason Intelligence, founded by Vince Dipisa.';

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
      error:
        'Groq is not configured. Add GROQ_API_KEY to the server environment.'
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
    messages = safeMessageList(body);
  } catch (error) {
    return json(res, error.status || 400, {
      error: error.message
    });
  }

  const mode = body.mode === 'code' ? 'code' : 'chat';

  const allowedEfforts = ['low', 'medium', 'high'];

  const reasoningEffort = allowedEfforts.includes(body.effort)
    ? body.effort
    : 'medium';

  const requestedTokens = Number(
    body.max_completion_tokens
  );

  const maxCompletionTokens = Number.isFinite(requestedTokens)
    ? Math.max(128, Math.min(8192, Math.floor(requestedTokens)))
    : 4096;

  const payload = {
    model: GROQ_MODEL_ID,

    messages: [
      {
        role: 'system',
        content: mode === 'code'
          ? CODE_SYSTEM_PROMPT
          : BASE_SYSTEM_PROMPT
      },
      ...messages
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
      signal: AbortSignal.timeout(120_000)
    });
  } catch (error) {
    return json(res, 502, {
      error: error.name === 'TimeoutError'
        ? 'Groq request timed out.'
        : 'Could not connect to Groq. Check the server network.'
    });
  }

  if (!upstream.ok) {
    let detail = '';

    try {
      const data = await upstream.json();

      detail = String(
        data?.error?.message ||
        data?.message ||
        ''
      ).slice(0, 500);
    } catch {
      // Do not echo arbitrary upstream response bodies.
    }

    return json(
      res,
      upstream.status >= 400 && upstream.status < 600
        ? upstream.status
        : 502,
      {
        error: `Groq returned HTTP ${upstream.status}.`,
        ...(detail ? { details: detail } : {})
      }
    );
  }

  if (!payload.stream) {
    const data = await upstream.json().catch(() => null);

    if (!data) {
      return json(res, 502, {
        error: 'Groq returned an unreadable response.'
      });
    }

    return json(res, 200, data);
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
    Readable.fromWeb(upstream.body).pipe(res);
  } catch {
    if (!res.headersSent) {
      json(res, 502, {
        error: 'Failed to stream the Groq response.'
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

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));

  if (left.length !== right.length) {
    timingSafeEqual(left, Buffer.alloc(left.length));
    return false;
  }

  return timingSafeEqual(left, right);
}

function fineTuneConfigured() {
  return Boolean(
    FINE_TUNING_SERVICE_URL &&
    FINE_TUNING_SERVICE_TOKEN &&
    FINE_TUNE_ADMIN_TOKEN
  );
}

function authorizeFineTune(req, res) {
  if (!fineTuneConfigured()) {
    json(res, 503, {
      error:
        'Fine-tuning is not configured. Configure a compatible training worker and its server-side credentials.'
    });

    return false;
  }

  const auth = String(req.headers.authorization || '');

  const token = auth.startsWith('Bearer ')
    ? auth.slice(7)
    : '';

  if (
    !token ||
    !constantTimeEqual(token, FINE_TUNE_ADMIN_TOKEN)
  ) {
    json(res, 401, {
      error: 'Fine-Tuning Studio authentication failed.'
    });

    return false;
  }

  if (!sameOriginGuard(req, res)) return false;

  return true;
}

function workerUrl(endpoint) {
  const base = new URL(FINE_TUNING_SERVICE_URL);

  if (
    !['https:', 'http:'].includes(base.protocol) ||
    (
      base.protocol === 'http:' &&
      !['localhost', '127.0.0.1', '::1']
        .includes(base.hostname)
    )
  ) {
    throw new Error(
      'FINE_TUNING_SERVICE_URL must use HTTPS in production.'
    );
  }

  return `${FINE_TUNING_SERVICE_URL}/${endpoint.replace(/^\/+/, '')}`;
}

function sanitizeFileName(name) {
  const cleaned = String(name || 'dataset.jsonl')
    .replace(/[^\p{L}\p{N}._-]/gu, '_')
    .slice(0, 160);

  return cleaned || 'dataset.jsonl';
}

function proxyWorkerResponse(upstream, res) {
  const contentType =
    upstream.headers.get('content-type') ||
    'application/json; charset=utf-8';

  res.writeHead(upstream.status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });

  if (!upstream.body) return res.end();

  Readable.fromWeb(upstream.body).pipe(res);
}

async function proxyFineTuneJobCreate(req, res) {
  if (!authorizeFineTune(req, res)) return;
  if (!sameOriginGuard(req, res)) return;

  if (!rateLimit(req, res, 'fine-tune', 10, 100)) {
    return;
  }

  const contentType = String(
    req.headers['content-type'] || ''
  ).split(';')[0].trim().toLowerCase();

  if (
    contentType !== 'application/x-ndjson' &&
    contentType !== 'application/jsonl'
  ) {
    return json(res, 415, {
      error:
        'Upload the validated JSONL dataset as application/x-ndjson.'
    });
  }

  const baseModel = String(
    req.headers['x-base-model-id'] || GROQ_MODEL_ID
  ).trim();

  if (
    !baseModel ||
    baseModel.length > 256 ||
    /[\r\n]/.test(baseModel)
  ) {
    return json(res, 400, {
      error: 'Invalid base model identifier.'
    });
  }

  const method = String(
    req.headers['x-training-method'] || 'lora'
  ).toLowerCase();

  if (!['lora', 'qlora'].includes(method)) {
    return json(res, 400, {
      error: 'Training method must be lora or qlora.'
    });
  }

  let config;

  try {
    config = JSON.parse(
      String(req.headers['x-training-config'] || '{}')
    );

    if (
      !config ||
      typeof config !== 'object' ||
      Array.isArray(config)
    ) {
      throw new Error();
    }
  } catch {
    return json(res, 400, {
      error: 'Training configuration header is invalid JSON.'
    });
  }

  const epochs = Number(config.epochs ?? 1);
  const learningRate = Number(
    config.learningRate ?? 0.0001
  );
  const batchSize = Number(config.batchSize ?? 1);

  if (
    !Number.isFinite(epochs) ||
    epochs < 1 ||
    epochs > 20 ||
    !Number.isFinite(learningRate) ||
    learningRate < 1e-6 ||
    learningRate > 0.01 ||
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 128
  ) {
    return json(res, 400, {
      error:
        'Training configuration is outside the permitted range.'
    });
  }

  const declaredLength = Number(
    req.headers['content-length'] || 0
  );

  if (declaredLength > MAX_DATASET_BYTES) {
    return json(res, 413, {
      error:
        `Dataset exceeds the upload limit of ${MAX_DATASET_BYTES} bytes.`
    });
  }

  let datasetTooLarge = false;

  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      this.count = (this.count || 0) + chunk.length;

      if (this.count > MAX_DATASET_BYTES) {
        datasetTooLarge = true;

        callback(
          Object.assign(
            new Error('Dataset upload size limit reached.'),
            { code: 'DATASET_TOO_LARGE' }
          )
        );
      } else {
        callback(null, chunk);
      }
    }
  });

  req.pipe(limiter);

  let upstream;

  try {
    upstream = await fetch(workerUrl('jobs'), {
      method: 'POST',

      headers: {
        Authorization: `Bearer ${FINE_TUNING_SERVICE_TOKEN}`,
        'Content-Type': 'application/x-ndjson',
        'X-Dataset-Filename': sanitizeFileName(
          req.headers['x-dataset-filename']
        ),
        'X-Base-Model-Id': baseModel,
        'X-Training-Method': method,
        'X-Training-Config': JSON.stringify({
          epochs,
          learningRate,
          batchSize
        }),
        'X-Application': 'Lumina-1.0'
      },

      body: Readable.toWeb(limiter),
      duplex: 'half',
      signal: AbortSignal.timeout(30 * 60 * 1000)
    });
  } catch (error) {
    if (
      datasetTooLarge ||
      error.code === 'DATASET_TOO_LARGE'
    ) {
      return json(res, 413, {
        error:
          `Dataset exceeds the ${MAX_DATASET_BYTES}-byte upload limit.`
      });
    }

    return json(res, 502, {
      error:
        'Could not submit the training job. Check the configured training worker.'
    });
  }

  proxyWorkerResponse(upstream, res);
}

async function proxyFineTuneControl(req, res, jobId, action) {
  if (!authorizeFineTune(req, res)) return;

  if (!sameOriginGuard(req, res)) return;

  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(jobId)) {
    return json(res, 400, {
      error: 'Invalid training job ID.'
    });
  }

  if (action === 'cancel' && req.method !== 'POST') {
    return json(res, 405, {
      error: 'Use POST to cancel a training job.'
    });
  }

  if (action === 'status' && req.method !== 'GET') {
    return json(res, 405, {
      error: 'Use GET to check a training job.'
    });
  }

  if (
    action === 'cancel' &&
    !rateLimit(req, res, 'fine-tune', 10, 100)
  ) {
    return;
  }

  try {
    const suffix = action === 'cancel'
      ? '/cancel'
      : '';

    const upstream = await fetch(
      workerUrl(
        `jobs/${encodeURIComponent(jobId)}${suffix}`
      ),
      {
        method: action === 'cancel' ? 'POST' : 'GET',

        headers: {
          Authorization: `Bearer ${FINE_TUNING_SERVICE_TOKEN}`,
          Accept: 'application/json',
          'X-Application': 'Lumina-1.0'
        },

        signal: AbortSignal.timeout(30_000)
      }
    );

    proxyWorkerResponse(upstream, res);
  } catch {
    json(res, 502, {
      error: 'Could not reach the configured training worker.'
    });
  }
}

function health(req, res) {
  json(res, 200, {
    status: 'ok',
    product: 'Lumina-1.0',
    provider: 'Groq',
    modelLabel: 'Lumina-1.0',
    providerConfigured: Boolean(GROQ_API_KEY),
    modelConfigured: Boolean(GROQ_MODEL_ID),
    endpointConfigured: true,
    chatReady: Boolean(GROQ_API_KEY),
    fineTuningConfigured: fineTuneConfigured(),
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

  // Only the three public frontend files are served.
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
    mimeTypes[path.extname(fullPath).toLowerCase()] ||
    'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control':
      path.extname(fullPath) === '.html'
        ? 'no-store'
        : 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff'
  });

  if (req.method === 'HEAD') return res.end();

  createReadStream(fullPath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  securityHeaders(res);

  try {
    const url = new URL(
      req.url,
      `http://${req.headers.host || 'localhost'}`
    );

    if (
      url.pathname === '/api/health' &&
      req.method === 'GET'
    ) {
      return health(req, res);
    }

    if (
      url.pathname === '/api/chat' &&
      req.method === 'POST'
    ) {
      return await handleChat(req, res);
    }

    if (
      url.pathname === '/api/fine-tune/jobs' &&
      req.method === 'POST'
    ) {
      return await proxyFineTuneJobCreate(req, res);
    }

    const statusMatch = url.pathname.match(
      /^\/api\/fine-tune\/jobs\/([^/]+)$/
    );

    const cancelMatch = url.pathname.match(
      /^\/api\/fine-tune\/jobs\/([^/]+)\/cancel$/
    );

    if (statusMatch) {
      return await proxyFineTuneControl(
        req,
        res,
        statusMatch[1],
        'status'
      );
    }

    if (cancelMatch) {
      return await proxyFineTuneControl(
        req,
        res,
        cancelMatch[1],
        'cancel'
      );
    }

    if (url.pathname.startsWith('/api/')) {
      return json(res, 404, {
        error: 'API route not found.'
      });
    }

    if (
      req.method !== 'GET' &&
      req.method !== 'HEAD'
    ) {
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
      error: error.status
        ? error.message
        : 'Unexpected server error.'
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    `Lumina-1.0 listening on ${HOST}:${PORT}`
  );

  console.log(
    `Groq API key configured: ${Boolean(GROQ_API_KEY)}`
  );

  console.log(
    `Groq model: ${GROQ_MODEL_ID}`
  );

  console.log(
    `Fine-tuning worker configured: ${fineTuneConfigured()}`
  );
});

export { server };
