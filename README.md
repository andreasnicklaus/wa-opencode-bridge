# wa-opencode-bridge

[![Node](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Express](https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white)](https://expressjs.com/)

A tiny HTTP bridge that connects WhatsApp to [opencode](https://opencode.ai) running in server mode. Incoming WhatsApp messages arrive via an OpenWA webhook, are handed to a fresh one-shot opencode session, and the agent's reply is delivered back as a WhatsApp text message using its own WhatsApp MCP tools.

## Quick start

1. **Set up the two upstreams**
   - **OpenWA** — a WhatsApp gateway with the REST API and MCP enabled. You need the base URL (e.g. `https://openwa.example.com`) and an API key.
   - **opencode server** — run `opencode serve` (optionally with `OPENCODE_SERVER_PASSWORD` set for Basic auth) so `http://host:4096` responds. The bridge talks to the `POST /session` and `/session/<id>/message` endpoints.

2. **Write a production `docker-compose.yml`**

   A `compose.yaml` for production deployment pulls the published image from the GitHub Container Registry, wires the env vars, and persists state in a volume:

   ```yaml
   services:
     wa-opencode-bridge:
       image: ghcr.io/andreasnicklaus/wa-opencode-bridge:latest
       restart: unless-stopped
       ports:
         - "3210:3210"
       environment:
         OPENWA_BASE_URL: "https://openwa.example.com"
         OPENWA_API_KEY: "${OPENWA_API_KEY}"
         OPENWA_SESSION_ID: "${OPENWA_SESSION_ID}"
         OPENCODE_BASE_URL: "http://opencode.example.com:4096"
         STILL_WORKING_AFTER_MS: "60000"
       volumes:
         - wa-opencode-bridge-data:/data

   volumes:
     wa-opencode-bridge-data:
   ```

   Fill in the required values in a `.env` file next to it (or inline), then start it:

   ```bash
   docker compose up -d
   ```

   See [Configuration](#configuration) for the full list of variables.

3. **Point OpenWA's webhook at the bridge**

   Register `https://your-bridge.example.com/webhook/wa-message` as the incoming-message webhook for the session. The bridge acks with `200` immediately and processes the message asynchronously.

4. **Give the opencode agent WhatsApp MCP tools** — the bridge's prompt tells the agent to look up chat history and send replies via its WhatsApp MCP tools. Configure those (e.g. a remote MCP server in `opencode.json`); without them the agent can't deliver a reply.

Send a WhatsApp message to the session's number and the agent should reply.

## How it works

1. **Webhook** — OpenWA POSTs every incoming message to `/webhook/wa-message`. The bridge acks instantly, then works asynchronously.
2. **Dedup** — OpenWA delivers at-least-once, so messages are deduplicated by id within a 10-minute window.
3. **Guardrails** — a per-sender allowlist and a per-sender daily message cap are enforced before anything runs.
4. **One-shot session** — a fresh opencode session is created for the message (titled `wa:<chatId>:<timestamp>`) and the message text is injected into a prompt. No chatId→session mapping: if the agent needs prior context it pulls chat history itself via its WhatsApp MCP tools.
5. **Processing** — the bridge reacts with 👀, optionally sends a "Still working on it…" fallback if the agent runs long (when `STILL_WORKING_AFTER_MS` is set), and enforces a prompt timeout.
6. **Delivery** — the agent is instructed to reply by sending a WhatsApp text through its MCP send-text tool; that MCP call is the only real delivery. The bridge scans the session for a send-tool invocation as a sanity check.
7. **Safety net** — if the agent produced text but never invoked the send tool, the bridge sends the text itself so the user isn't left hanging.
8. **Cleanup** — the 👀 reaction is cleared and the throwaway session is deleted. The exchange is appended to `log.jsonl`.

Everything is stateless except the per-day usage counters persisted in the `DATA_DIR` (default `/data`).

## Configuration

| Variable                   | Default               | Description                                                                                                                            |
| -------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENWA_BASE_URL`          | _(required)_          | OpenWA base URL (e.g. `https://openwa.example.com`). The session URL is constructed from this + `OPENWA_SESSION_ID`.                   |
| `OPENWA_API_KEY`           | _(required)_          | Bearer token for the OpenWA REST API.                                                                                                  |
| `OPENWA_SESSION_ID`        | _(required)_          | WhatsApp session UUID (e.g. `3ccddb36-ad0b-4901-83d4-4d09bd72fb97`). Used for all OpenWA API calls and injected into the agent prompt. |
| `OPENCODE_BASE_URL`        | _(required)_          | opencode server URL, e.g. `http://opencode:4096`.                                                                                      |
| `OPENCODE_AGENT`           | _(none)_              | Optional named agent/mode to use for the bot, e.g. `whatsapp-assistant`.                                                               |
| `OPENCODE_SERVER_USERNAME` | `opencode`            | Basic-auth username for `opencode serve`.                                                                                              |
| `OPENCODE_SERVER_PASSWORD` | _(empty)_             | Basic-auth password; only sent when set.                                                                                               |
| `ALLOWED_SENDERS`          | _(empty = allow all)_ | Comma-separated phone numbers (no `+`), e.g. `4915112345678,491701234567`.                                                             |
| `MAX_MESSAGES_PER_DAY`     | `100`                 | Per-sender daily message cap.                                                                                                          |
| `PROMPT_TIMEOUT_MS`        | `300000`              | Max time to wait for the agent before erroring (default 5 min).                                                                       |
| `STILL_WORKING_AFTER_MS`   | _(none)_              | If set, send a "Still working on it…" interim message after this many ms.                                                             |
| `DATA_DIR`                 | `/data`               | Directory for `log.jsonl` and `usage.json`.                                                                                            |
| `KEEP_SESSIONS`            | _(empty)_             | If set to any non-empty value, sessions are not deleted after each message (for debugging).                                            |

A ready-made `docker-compose.yml` is included that wires up the env vars (with `OPENWA_SESSION_ID`, `OPENWA_API_KEY`, and `OPENCODE_SERVER_PASSWORD` read from your `.env`) and mounts `./data:/data`.

## Debugging

To debug session behavior, set `KEEP_SESSIONS=1` in your `.env` or docker-compose environment. This prevents the bridge from deleting opencode sessions after each message, allowing you to inspect them on the opencode server.

## Attribution

This project uses [opencode](https://opencode.ai) as its agent backend and [OpenWA](https://github.com/open-wa/openwa) as the WhatsApp gateway.
