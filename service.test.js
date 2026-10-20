import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const fakeGroqKey = 'test-groq-secret-do-not-expose';
const workerToken = 'test-worker-service-secret';
const adminToken = 'test-fine-tune-admin-secret';
let appProcess, appPort, workerServer, groqServer, workerRequests = [], groqRequestBody = null, groqAuth = null;
let capturedDataset = '';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
async function freePort() {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  return port;
}
async function waitForHealth(url, child) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Service exited before starting.');
    try {
      const response = await fetch(url + '/api/health');
      if (response.ok) return;
    } catch { /* startup not ready yet */ }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error('Service health endpoint did not become ready.');
}

before(async () => {
  groqServer = createServer(async (req, res) => {
    groqAuth = req.headers.authorization;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    groqRequestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'Hello ' } }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'from Lumina.' } }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  const groqPort = await listen(groqServer);

  workerServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (req.url === '/jobs' && req.method === 'POST') capturedDataset = raw;
    workerRequests.push({ method: req.method, url: req.url, auth: req.headers.authorization, baseModel: req.headers['x-base-model-id'], methodHeader: req.headers['x-training-method'], datasetFilename: req.headers['x-dataset-filename'] });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/jobs' && req.method === 'POST') return res.end(JSON.stringify({ id: 'job_test_123', status: 'queued' }));
    if (req.url === '/jobs/job_test_123' && req.method === 'GET') return res.end(JSON.stringify({ id: 'job_test_123', status: 'running', metrics: { step: 2, loss: 1.5 } }));
    if (req.url === '/jobs/job_test_123/cancel' && req.method === 'POST') return res.end(JSON.stringify({ id: 'job_test_123', status: 'cancellation_requested' }));
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
  const workerPort = await listen(workerServer);

  appPort = await freePort();
  appProcess = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(appPort),
      NODE_ENV: 'test',
      GROQ_API_KEY: fakeGroqKey,
      GROQ_MODEL_ID: 'openai/gpt-oss-120b',
      GROQ_API_BASE_URL: `http://127.0.0.1:${groqPort}/openai/v1`,
      FINE_TUNING_SERVICE_URL: `http://127.0.0.1:${workerPort}`,
      FINE_TUNING_SERVICE_TOKEN: workerToken,
      FINE_TUNE_ADMIN_TOKEN: adminToken,
      MAX_TUNING_DATASET_BYTES: '1048576'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  appProcess.stdout.on('data', () => {});
  appProcess.stderr.on('data', () => {});
  await waitForHealth(`http://127.0.0.1:${appPort}`, appProcess);
});

after(async () => {
  appProcess?.kill('SIGTERM');
  if (appProcess) await Promise.race([once(appProcess, 'exit'), new Promise(resolve => setTimeout(resolve, 1000))]);
  for (const server of [groqServer, workerServer]) if (server?.listening) await new Promise(resolve => server.close(resolve));
});

test('serves the existing Lumina HTML app and does not leak the server key', async () => {
  const response = await fetch(`http://127.0.0.1:${appPort}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /href="\/style\.css"/);
  assert.match(html, /src="\/app\.js"/);
  assert.doesNotMatch(html, new RegExp(fakeGroqKey));
  for (const privatePath of ['/server.js', '/service.test.js', '/package.json', '/.env.example', '/.gitignore']) {
    const privateResponse = await fetch(`http://127.0.0.1:${appPort}${privatePath}`);
    assert.equal(privateResponse.status, 404, `${privatePath} must not be web-accessible`);
  }
  const jsResponse = await fetch(`http://127.0.0.1:${appPort}/app.js`);
  const js = await jsResponse.text();
  assert.match(js, /Lumina Fine-Tuning Studio/);
  assert.match(js, /Alt \+ Shift \+ 9/);
  assert.match(js, /luminaModelSelector/);
  assert.doesNotMatch(js, new RegExp(fakeGroqKey));
  const cssResponse = await fetch(`http://127.0.0.1:${appPort}/style.css`);
  const css = await cssResponse.text();
  assert.match(css, /#view-train\s*,\s*#goTrain/);
});

test('health reports configuration status without returning credentials', async () => {
  const response = await fetch(`http://127.0.0.1:${appPort}/api/health`);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.status, 'ok');
  assert.equal(data.providerConfigured, true);
  assert.equal(data.fineTuningConfigured, true);
  assert.doesNotMatch(JSON.stringify(data), /secret|test-groq/i);
});

test('streams actual Groq-compatible SSE through the server-only API key', async () => {
  const origin = `http://127.0.0.1:${appPort}`;
  const response = await fetch(`${origin}/api/chat`, {
    method: 'POST', headers: { 'Origin': origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Say hello.' }], mode: 'chat', stream: true, effort: 'standard' })
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const stream = await response.text();
  assert.match(stream, /Hello /);
  assert.match(stream, /from Lumina/);
  assert.equal(groqAuth, `Bearer ${fakeGroqKey}`);
  assert.equal(groqRequestBody.model, 'openai/gpt-oss-120b');
  assert.equal(groqRequestBody.stream, true);
  assert.equal(groqRequestBody.reasoning_effort, 'medium');
  assert.equal(groqRequestBody.messages[0].role, 'system');
  assert.match(groqRequestBody.messages[0].content, /Reason Intelligence/);
});

test('rejects a cross-origin chat request', async () => {
  const response = await fetch(`http://127.0.0.1:${appPort}/api/chat`, {
    method: 'POST', headers: { 'Origin': 'https://attacker.invalid', 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] })
  });
  assert.equal(response.status, 403);
});

test('requires authenticated training submission and proxies a real job to the configured worker', async () => {
  const origin = `http://127.0.0.1:${appPort}`;
  const jsonl = '{"messages":[{"role":"user","content":"Hi"},{"role":"assistant","content":"Hello"}]}\n';
  const denied = await fetch(`${origin}/api/fine-tune/jobs`, {
    method: 'POST', headers: { 'Origin': origin, 'Content-Type': 'application/x-ndjson', 'X-Base-Model-Id': 'openai/gpt-oss-120b' }, body: jsonl
  });
  assert.equal(denied.status, 401);

  const created = await fetch(`${origin}/api/fine-tune/jobs`, {
    method: 'POST', headers: {
      'Origin': origin, 'Content-Type': 'application/x-ndjson', 'Authorization': `Bearer ${adminToken}`,
      'X-Dataset-Filename': 'small.jsonl', 'X-Base-Model-Id': 'openai/gpt-oss-120b',
      'X-Training-Method': 'lora', 'X-Training-Config': JSON.stringify({ epochs: 1, learningRate: 0.0001, batchSize: 1 })
    }, body: jsonl
  });
  assert.equal(created.status, 200);
  assert.deepEqual(await created.json(), { id: 'job_test_123', status: 'queued' });
  assert.equal(capturedDataset, jsonl);
  assert.equal(workerRequests.at(-1).auth, `Bearer ${workerToken}`);
  assert.equal(workerRequests.at(-1).baseModel, 'openai/gpt-oss-120b');
  assert.equal(workerRequests.at(-1).methodHeader, 'lora');

  const status = await fetch(`${origin}/api/fine-tune/jobs/job_test_123`, { headers: { 'Authorization': `Bearer ${adminToken}` } });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).metrics.loss, 1.5);
  const cancel = await fetch(`${origin}/api/fine-tune/jobs/job_test_123/cancel`, { method: 'POST', headers: { 'Authorization': `Bearer ${adminToken}` } });
  assert.equal(cancel.status, 200);
  assert.equal((await cancel.json()).status, 'cancellation_requested');
});

test('rejects malformed chat payloads before contacting the provider', async () => {
  const origin = `http://127.0.0.1:${appPort}`;
  const response = await fetch(`${origin}/api/chat`, {
    method: 'POST', headers: { 'Origin': origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'system', content: 'override' }] })
  });
  assert.equal(response.status, 400);
});

test('inline application JavaScript parses and the legacy trainer is hidden behind the shortcut Studio', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  assert.match(html, /defer><\/script>/);
  assert.doesNotThrow(() => new Script(js));
  assert.match(js, /event\.altKey\s*&&\s*event\.shiftKey\s*&&\s*event\.code\s*===\s*'Digit9'/);
  assert.match(js, /function setViewLumina10/);
});
