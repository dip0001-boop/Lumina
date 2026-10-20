# Lumina-1.0 web service

This project packages the existing `LUMINA-2.0-SYNTHESIS-NEXUS.html` application as a full-stack web service. The frontend remains HTML, CSS, and vanilla JavaScript. `server.js` serves the frontend files directly from the project root and provides the protected, same-origin API. All project files are kept flat in the root; there are no `public/` or `tests/` subdirectories.

## What's implemented

- Existing Lumina chat and coding workspace retained, with chat and code-generation requests routed through the backend to Groq.
- Internal inference model defaults to `openai/gpt-oss-120b`; the user-facing selector reads **Lumina-1.0**.
- Groq credentials are read only from the server's `GROQ_API_KEY` environment variable.
- Streaming chat completion responses, request validation, same-origin checks, timeouts, basic per-IP rate limits, and a health endpoint (`/api/health`).
- The old browser trainer is hidden from the ordinary UI. **Alt + Shift + 9** opens the Fine-Tuning Studio.
- JSONL validation reads a `File` stream instead of converting a large dataset into one giant JavaScript string. The browser uploads the raw file stream through the backend.
- Fine-tuning API routes require `FINE_TUNE_ADMIN_TOKEN`; the worker's own token stays server-side. Job create/status/cancel requests are proxied to a configured training worker.
- No actual Groq key, training service credential, or administrator token is included.

## Local run

Requires Node.js 20 or newer.

1. Copy `.env.example` to `.env` in your own environment, or set the variables directly in the server process. Never commit `.env` or put API keys in `index.html`.
2. Set `GROQ_API_KEY` to your own Groq key.
3. Run `npm start` and open `http://localhost:3000`.
4. Open browser DevTools and call `/api/health` or visit it directly to check whether the provider and fine-tuning worker are configured. The health response intentionally reports configuration status only, never secret values.

The frontend has no build step or browser-side package dependencies.

## Deployment

`render.yaml` is included for a Render Node web service. Deploy through a hosting account that can build and run a Node.js web service:

- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/api/health`
- Configure `GROQ_API_KEY` in the hosting provider's secret/environment settings.
- Keep `GROQ_MODEL_ID` as `openai/gpt-oss-120b` unless you deliberately configure another supported model.
- Do not put the Groq key in static-site environment variables, browser config, query strings, or source files.

The hosting platform must support a persistent server-side Node process, HTTPS, environment variables, and streaming response bodies. Static HTML-only hosting does not meet those requirements. Public web-service hosting commonly requires a repository or connected hosting account; `render.yaml` is configuration, not a deployment by itself.

Free service tiers can sleep when idle and may impose execution, bandwidth, or upload limits. This is a deployment target for testing; review the host's current limitations before using it as a production service.

## Fine-tuning worker: required contract

Groq inference does **not** mean the GPT-OSS-120B weights can be fine-tuned through the chat-completions endpoint. The Fine-Tuning Studio needs a separately hosted training worker that can genuinely train the selected model and can deploy the resulting adapter/model to a compatible inference endpoint.

Set all three server-side variables below to enable the Studio's real job requests:

- `FINE_TUNING_SERVICE_URL`: HTTPS base URL of the worker API (without `/jobs` on the end).
- `FINE_TUNING_SERVICE_TOKEN`: credential the backend sends to the worker.
- `FINE_TUNE_ADMIN_TOKEN`: independent password/token that the Studio operator enters in the hidden UI.

The worker must implement these endpoints:

### `POST /jobs`

Receives the JSONL dataset as a streaming `application/x-ndjson` request body. The backend adds these headers:

- `Authorization: Bearer <FINE_TUNING_SERVICE_TOKEN>`
- `X-Dataset-Filename`: sanitized filename
- `X-Base-Model-Id: openai/gpt-oss-120b`
- `X-Training-Method: lora` or `qlora`
- `X-Training-Config`: JSON containing `epochs`, `learningRate`, and `batchSize`
- `X-Application: Lumina-1.0`

On acceptance, return JSON such as `{"id":"worker-job-id","status":"queued"}`. Validate the real dataset, resources, model compatibility, and method; reject unsupported model/method combinations rather than accepting a fake job.

### `GET /jobs/:id`

Return the worker's current job record as JSON, including a real `status`, and actual metrics/logs/artifact metadata when available. Use states such as `queued`, `running`, `completed`, `failed`, or `cancelled`.

### `POST /jobs/:id/cancel`

Request cancellation and return the real worker response. The UI will continue to distinguish a cancellation request from a confirmed cancelled state.

A completed job should provide an artifact reference and model compatibility/deployment details. Do not tell the application an artifact is usable until the worker has confirmed it can be loaded by the configured inference runtime.

The server streams uploaded JSONL through without buffering the entire file. The default server upload ceiling is 2 GiB (`MAX_TUNING_DATASET_BYTES`), but the host or worker may impose lower limits. The dataset validator currently reports the first 12 malformed records and refuses submission until the file is valid. JSONL record formats supported by the validator include `messages[]`, `prompt` + `completion`, `instruction` + `output`, or `conversations[]`.

## Testing

Run:

```sh
npm test
```

`service.test.js` uses local mock provider and worker servers to verify server-side credential use, GPT-OSS model routing, SSE passthrough, origin checks, JSONL streaming to a worker, fine-tuning authentication, job status/cancellation proxying, and frontend JavaScript syntax. They do not use a real Groq key or prove external hosting is live.

## Security and production notes

- The hidden keyboard shortcut is a UI affordance, **not** a security boundary. The backend independently authenticates fine-tuning calls.
- The fine-tuning admin token is held in page memory and sent to the same-origin backend only when the operator uses the Studio; it is not saved in browser storage.
- Basic IP-based rate limits are kept in process memory; multiple instances do not share counters. Use account-level auth and a distributed limiter before opening the service to substantial public traffic.
- The existing workspace includes local code execution and client-side plan UI. Those browser features are not a security sandbox for hostile users, nor are client-side plan labels real payment enforcement. Use this as a personal/testing deployment until multi-user isolation and server-side entitlements are added.
- This deliverable is deploy-ready, but it cannot create a public URL without a connected hosting account and authorization to create the service. No live URL should be assumed until the host confirms deployment.
