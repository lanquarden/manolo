# Manolo

A small, separate replacement candidate for the household’s OpenClaw setup. One relay handles identities, routing and the web UI. Each agent runs a Pi Durable worker with its own SQLite volume, credentials and image pin. The first channel is a **new Telegram bot**; OpenClaw keeps Discord and WhatsApp.

## Try it without API keys

```sh
npm ci
npm test
npm run demo
```

Use Node 24. Open the printed URL and sign in with the temporary `owner` or `tester` login. The demo runs two real Pi Durable workers with a deterministic fixture model; use a separate browser profile to switch Basic Auth users. It opens only loopback listeners, contacts no provider or Telegram endpoint, and deletes its temporary state when stopped. The integration tests use a local fake Telegram API and kill/restart actual processes against their actual SQLite files.

## What the PoC can do

- **Telegram:** routes exact, allowlisted private user/chat IDs to one fixed agent. No username matching, fallback agent, group chats, attachments or forwarding. The relay persists admitted updates before acknowledging them to Telegram and replies to the original chat. It does not move Telegram conversation data into a web session.
- **Browser:** an owner can chat with their assigned worker, edit/preview/publish a dashboard draft, and roll back to a retained revision. The worker can propose headings and notes with `write_dashboard_draft` but cannot publish them or rewrite the trusted web shell. No generated HTML, scripts, actions or URLs are rendered. The current chat UI is a turn composer, not a browsable durable transcript.
- **Inter-agent inbox:** `send_inbox` can deliver text on explicitly enabled directed edges. The relay derives the sender from the worker credential, not the payload. The recipient’s owner can read it and decide what to do. Delivery does not prompt the recipient worker, open any tools, or trigger a reply. The sample enables `primary → canary` only.
- **Recovery:** restarting a worker on the same volume reopens its conversations and resumes unfinished runs. Worker submissions are deduplicated by turn ID. Side-effecting tools are not replayed after interruption. Telegram `sendMessage` has no idempotency key, so a crash or timeout after Telegram accepts a reply can cause a duplicate on retry. Replies longer than Telegram’s limit are truncated rather than sent in multiple parts.

## Stage a Kubernetes canary

[`deploy/helm/manolo`](deploy/helm/manolo) renders one relay and two independently pinned worker Deployments, each with its own PVC. It uses one replica and `Recreate` per volume; the processes also reject a second local writer. Ingress policy keeps worker HTTP behind the relay, the internal relay API behind worker credentials, and web ingress closed by default. This is not an egress sandbox or a hardened service for untrusted plug-ins. The chart does not publish an image, create credentials, add an HTTPRoute, or touch OpenClaw.

1. Build the supplied `Dockerfile`. Publish only to your chosen registry and set `relayImage`, `agents.primary.image` and `agents.canary.image` to the immutable digest(s). The same image supplies both entrypoints. `agents.<id>.fixture=true` is suitable for a credentialless worker smoke test; it disables relay-write tools in the Kubernetes fixture. For a real worker, specify a provider/catalog model and its API key. The PoC supports the explicit API-key providers in [`src/worker-runtime.mjs`](src/worker-runtime.mjs), not Pi CLI credential reuse or OAuth. A worker rejects switching provider/model against an existing data directory; use a fresh canary volume when testing a new model.
2. Use a dedicated namespace. Provision the existing Secret names in `values.yaml` (for `home-ops`, use ExternalSecrets backed by 1Password). Set independent random 32+ character values. The relay Secret contains `MANOLO_PRIMARY_TOKEN`, `MANOLO_CANARY_TOKEN`, `MANOLO_OWNER_PASSWORD`, `MANOLO_TESTER_PASSWORD` and, only when enabling Telegram, `MANOLO_TELEGRAM_TOKEN`. Each worker Secret has only its own matching value as `MANOLO_AGENT_TOKEN` plus its provider API key, e.g. `OPENAI_API_KEY`. Do not reuse OpenClaw tokens or credentials.
3. Create a bot with BotFather, start a DM to it, and obtain your numeric user/chat ID from a trusted Bot API `getUpdates` response. Use a bot with no webhook or other poller. Put exactly one entry in `relayConfig.routes`, e.g. `{transport: telegram, userId: '123456', chatId: '123456', agent: primary}` with your actual ID. Telegram retains undelivered updates for a limited time; the PoC has no automated cursor repair for a bot left idle for a week or more.
4. Review the rendered manifests before registering a release in Flux. Use a port-forward for the first browser smoke test (`kubectl -n manolo port-forward svc/manolo-relay 8080:8080`), never plaintext Basic Auth on a shared network. A family rollout should put the UI behind HTTPS and integrate the internal OIDC gateway rather than distribute permanent Basic credentials. Then verify a real Telegram DM on the new bot, a denied sender, a directed inbox note, and a canary-pod restart before adding any family accounts. Scale, backups and data retention should be settled before migration; worker PVCs contain conversation data.

### Where to extend it

`src/telegram.mjs` handles the Bot API. `src/relay.mjs` owns routing authorization, durable delivery and reply correlation. The normalized sender key is `(transport, userId, chatId)`, not an identity supplied to a model. Discord, WhatsApp and an XMPP bridge can sit at this boundary. An XMPP bridge should preserve authenticated upstream sender/conversation IDs and the return route; if it collapses everyone to one bridge account, there is no safe per-person route. No translation server is needed for the Telegram slice.

`src/worker.mjs` owns the Pi Durable state. `src/dashboard.mjs` owns per-agent dashboard revisions. No shared worker volume, shell, arbitrary network tool, agent plug-ins, scheduling, room membership, or device pairing in this slice. Nolan can use the browser from Windows; native Windows execution and scoped device enrollment are separate milestones. A paired desktop should not inherit a cluster or owner credential, or implicitly grant remote shell access.
