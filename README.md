# wa-opencode-bridge

[![Node](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Express](https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white)](https://expressjs.com/)

A tiny HTTP bridge that connects WhatsApp to [opencode](https://opencode.ai) running in server mode. Incoming WhatsApp messages arrive via an OpenWA webhook, are handed to a fresh one-shot opencode session, and the agent's reply is delivered back as a WhatsApp text message using its own WhatsApp MCP tools.

## Quick start

1. **Set up the two upstreams**

   - **OpenWA** — a WhatsApp gateway with the REST API and MCP enabled. You need the session's base URL (`https://…/api/sessions/<session-uuid>`) and an API key.
   - **opencode server** — run `opencode serve` (optionally with `OPENCODE_SERVER_PASSWORD` set for Basic auth) so `http://host:4096` responds. The bridge talks to the `POST /session` and `/session/<id>/message` endpoints.

2. **Configure via environment variables** — see [Configuration](#configuration). At minimum:

   ```bash
   export OPENWA_BASE_URL="https://openwa.example.com/api/sessions/<session-uuid>"
   export OPENWA_API_KEY="your-openwa-api-key"
   export OPENCODE_BASE_URL="http://localhost:4096"
   ```

3. **Run it**

   ```bash
   npm install
   npm start
   ```

   or with Docker:

   ```bash
   docker compose up -d
   ```

4. **Point OpenWA's webhook at the bridge**

   Register `https://your-bridge.example.com/webhook/wa-message` as the incoming-message webhook for the session. The bridge acks with `200` immediately and processes the message asynchronously.

5. **Give the opencode agent WhatsApp MCP tools** — the bridge's prompt tells the agent to look up chat history and send replies via its WhatsApp MCP tools. Configure those (e.g. a remote MCP server in `opencode.json`); without them the agent can't deliver a reply.

Send a WhatsApp message to the session's number and the agent should reply.

## How it works

1. **Webhook** — OpenWA POSTs every incoming message to `/webhook/wa-message`. The bridge acks instantly, then works asynchronously.
2. **Dedup** — OpenWA delivers at-least-once, so messages are deduplicated by id within a 10-minute window.
3. **Guardrails** — a per-sender allowlist and a per-sender daily message cap are enforced before anything runs.
4. **One-shot session** — a fresh opencode session is created for the message (titled `wa:<chatId>:<timestamp>`) and the message text is injected into a prompt. No chatId→session mapping: if the agent needs prior context it pulls chat history itself via its WhatsApp MCP tools.
5. **Processing** — the bridge reacts with 👀, sends a "Still working on it…" fallback if the agent runs long, and enforces a prompt timeout.
6. **Delivery** — the agent is instructed to reply by sending a WhatsApp text through its MCP send-text tool; that MCP call is the only real delivery. The bridge scans the session for a send-tool invocation as a sanity check.
7. **Safety net** — if the agent produced text but never invoked the send tool, the bridge sends the text itself so the user isn't left hanging.
8. **Cleanup** — the 👀 reaction is cleared and the throwaway session is deleted. The exchange is appended to `log.jsonl`.

Everything is stateless except the per-day usage counters persisted in the `DATA_DIR` (default `/data`).

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `OPENWA_BASE_URL` | *(required)* | OpenWA session base URL, e.g. `https://openwa.example.com/api/sessions/<session-uuid>`. |
| `OPENWA_API_KEY` | *(required)* | Bearer token for the OpenWA REST API. |
| `OPENCODE_BASE_URL` | *(required)* | opencode server URL, e.g. `http://opencode:4096`. |
| `OPENCODE_AGENT` | *(none)* | Optional named agent/mode to use for the bot, e.g. `whatsapp-assistant`. |
| `OPENCODE_SERVER_USERNAME` | `opencode` | Basic-auth username for `opencode serve`. |
| `OPENCODE_SERVER_PASSWORD` | *(empty)* | Basic-auth password; only sent when set. |
| `ALLOWED_SENDERS` | *(empty = allow all)* | Comma-separated phone numbers (no `+`), e.g. `4915112345678,491701234567`. |
| `MAX_MESSAGES_PER_DAY` | `100` | Per-sender daily message cap. |
| `PROMPT_TIMEOUT_MS` | `60000` | Max time to wait for the agent before erroring. |
| `STILL_WORKING_AFTER_MS` | `15000` | How long before a "Still working on it…" interim message is sent. |
| `DATA_DIR` | `/data` | Directory for `log.jsonl` and `usage.json`. |

A ready-made `docker-compose.yml` is included that wires up the env vars (with `OPENWA_SESSION_ID`, `OPENWA_API_KEY`, and `OPENCODE_SERVER_PASSWORD` read from your `.env`) and mounts `./data:/data`.

## Attribution

This project uses [opencode](https://opencode.ai) as its agent backend and [OpenWA](https://github.com/open-wa/openwa) as the WhatsApp gateway.
