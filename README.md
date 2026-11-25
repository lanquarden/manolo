# Manolo

A small, separate replacement candidate for the household’s OpenClaw setup. One relay handles identities, routing and the web UI. Each agent runs a Pi Durable worker with its own SQLite volume, credentials and image pin. Start with a **new Telegram bot**; opt-in Discord DMs use a separate Manolo bot so OpenClaw can keep its existing accounts.

## Try it without API keys

```sh
npm ci
npm test
npm run demo
```

Use Node 24. Open the printed URL, which redirects to the sign-in page, and sign in with `owner`/`owner` (primary) or `tester`/`tester` (canary). Those short logins work only because the demo runs the relay with `MANOLO_DEMO=1`, which relaxes the 32-character password minimum and is refused unless every listener is loopback. The demo turns off the `Secure` cookie attribute because it serves plain HTTP on loopback; every real deployment keeps it on. The demo runs two real Pi Durable workers with a deterministic fixture model; use a separate browser profile to switch Basic Auth users. It opens only loopback listeners, contacts no provider or Telegram endpoint, and deletes its temporary state when stopped. The integration tests use a local fake Telegram API and kill/restart actual processes against their actual SQLite files.

## What the PoC can do

- **Telegram:** routes exact, allowlisted private user/chat IDs to one fixed agent. Direct Bot API also supports [opt-in text rooms](#opt-in-telegram-rooms). No fallback agent, and no Telegram data moves into web history.
- **Discord (opt-in):** exact user ID and bot DM channel ID route to one worker, independently of Telegram. No guild messages or group conversations. Discord Gateway resumption is best effort; messages never received by the relay are not backfilled. Once admitted, replies survive relay restarts. Discord's short nonce window reduces duplicate sends, but it is not an exactly-once guarantee.
- **Sign-in:** `/login` is a plain HTML form (no script) that sets an in-memory, `HttpOnly`, `SameSite=Strict` session cookie; `/logout` revokes it. The sidebar shows the signed-in account. Ten failed attempts per address in ten minutes are throttled. Basic Auth still works for scripts and the Device API is unchanged. Sessions end when the relay restarts, so nothing durable holds a bearer token. Set `webProxyAuthHeader` (Helm) or `MANOLO_PROXY_AUTH_HEADER` (env) to an identity header your gateway already verifies, such as `x-auth-request-user` with Envoy Gateway Google OIDC; the header must name a configured owner, is ignored unless configured, and duplicate copies are refused. Behind such a gateway the sign-in form is bypassed entirely. Never expose the relay directly when that header is trusted.
- **Browser:** the owner can chat with their assigned worker and see the latest 30 browser turns after reload. A queued turn survives relay restart even if the worker was down when it was submitted. Telegram and Discord transcripts are separate; older conversations created before browser history was added keep their Pi Durable context, but their old turns aren't backfilled into the UI. The owner can edit, preview, publish, or roll back a dashboard. The worker can propose headings and notes with `write_dashboard_draft` but cannot publish them or rewrite the trusted web shell. No generated HTML, scripts, actions or URLs are rendered.
- **Per-agent instructions:** set `agents.<id>.instructions` in Helm (or `MANOLO_AGENT_INSTRUCTIONS` on the worker). Changing one worker's value rolls only that worker. Instructions are non-secret text, up to 4,000 UTF-16 code units; they are stored and sent to the model. A new turn adopts them without clearing conversation history. Restart and idempotent retries alone don't rewrite a pending turn's instructions; admitting a fresh turn can update instructions for queued work because Pi Durable stores them per conversation.
- **Inter-agent inbox:** `send_inbox` can deliver text on explicitly enabled directed edges. The relay derives the sender from the worker credential, not the payload. The recipient’s owner can read it and decide what to do. Delivery does not prompt the recipient worker, open any tools, or trigger a reply. The sample enables `primary → canary` only.
- **Worker tools:** workers offer `read`, `write`, `edit` and `bash` by default. Set Helm `agents.<id>.codingTools: false` (or `MANOLO_CODING_TOOLS=0`) to keep them unavailable. Relative paths resolve against the agent's workspace, `<MANOLO_DATA_DIR>/workspace` (`/data/workspace` in the image), which lives on the worker's own PVC so notes, scripts and self-updates survive a restart. `bash` defaults to a 30-minute timeout (`MANOLO_BASH_TIMEOUT_SECONDS`, 1–86400, overrides it), so a hung command cannot hold a turn forever. These tools are not a sandbox: `bash` can read anything the container's `node` user can read and reach any network the pod can, and the chart's NetworkPolicy only covers ingress. The shell gets an allowlist rather than the worker's environment: `PATH`, `HOME`, `USER`, `SHELL`, `TMPDIR`, `LANG`, `LC_ALL`, `TERM` and every name in `MANOLO_BASH_ENV` (Helm `agents.<id>.bashEnv`). `MANOLO_AGENT_TOKEN` and the provider key are refused even when named there, so `printenv` and `env` stay clean while other variables stay available. `cat /proc/self/environ` still bypasses that, so the container itself must be trusted. `read` prepares images with Photon in an idle-exiting worker thread: BMP becomes PNG, oversized or overweight images are scaled and re-encoded to the model's limits, and a text-only model sees a placeholder instead. In the sample image `/data` (harness state plus the workspace), `/home/node` and `/tmp` are writable and `/app` is read-only; the image ships `git`, `curl`, `wget`, `jq`, `yq` and `mise`, so a command can fetch and build inside the workspace.
- **Tool transcript:** a completed browser turn also stores the tool calls that produced it: name, bounded arguments, status, output tail, edit patch, diagnostics, duration and returned images. The chat renders each as a collapsible card; images are served per turn from the relay, never inlined into history JSON. Every stored string is redacted with the same worker secrets as the reply. Tool output is not sent to Telegram or Discord, which still receive only the answer text.
- **Live streaming:** while a browser turn runs, the worker reports what it has committed so far from `pi.live`: the answer text as it streams, a collapsed reasoning block, the current tool round with each call's status and running output (and how many earlier lines were dropped), and a retry notice when the model request backs off. The relay bounds and redacts that snapshot, keeps it in memory only (never the database), and drops it as soon as the turn ends. The chat polls roughly every 800 ms for up to ten minutes. Telegram and Discord still receive only the finished text.
- **Agent browser (opt-in):** `agents.<id>.browser.enabled` in Helm adds a headed Chromium sidecar to that worker's pod with its own persistent profile claim. The worker drives it over the DevTools protocol at the pod's loopback (`browser_open`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_key`, `browser_screenshot`, `browser_tabs`), and the owner watches and can act in the same window from a **Browser** tab in the workspace. The relay proxies the sidecar's noVNC frontend on `/desktop/` for the signed-in owner's own agent only, so the desktop adds no second origin, route, or credential. Refs such as `e7` come from the latest snapshot; typing uses the real input path, and screenshots are JPEG images in the transcript. Cookies, logins and restored tabs survive restarts on `/config`, which is credential-grade data. The relay learns which agents have a desktop from `MANOLO_BROWSER_URLS`, and the worker from `MANOLO_BROWSER_CDP`; the chart sets both. Enabling it adds the sidecar's own 2Gi limit to the pod and recreates the worker.
- **MCP servers:** each worker reads `mcp.json` from its own data volume, in the shared `mcpServers` shape (stdio `command/args/env/cwd`, or Streamable HTTP `url/headers`, plus `enabled`, `description`, `timeout`, `exposure` and `toolExposure`). The file is the source of truth: the owner edits it in the Dashboard, the agent can edit it with `write`, and the worker applies changes **without a restart** — the registry is live, so added, removed or reconnected servers reach the next model request (`pi`'s `codemode`, `deferred` and `direct` exposures map onto the registry's `callers`/`deferred`). A configuration that does not parse is reported and the previous set keeps running; an unreachable server costs only its tools. `${NAME}` in `env`/`headers` is resolved from the worker environment — names an MCP server uses are refused in `MANOLO_BASH_ENV` and their values are redacted from transcripts — and stdio servers never inherit the worker's environment, so they cannot see `MANOLO_AGENT_TOKEN` or the provider key. OAuth-protected HTTP servers sign in through `MANOLO_PUBLIC_URL` (`/mcp/oauth/callback` on the relay): the workspace offers the authorization link, tokens are stored on the volume in `mcp-auth.json`, and refreshes happen without a browser. MCP results are bounded like every other tool: text is cut at 20 KB with the full output saved under `mcp/` in the workspace, images become transcript images, and a server's `readOnlyHint` is the only thing that makes a call replay-safe.
- **Workspace targets (pi-env):** with `agents.<id>.remoteEnvs`, a conversation can move its **file and shell tools** onto another machine while storage, credentials and the conversation stay in the pod. The transport is [`@earendil-works/pi-env`](https://www.npmjs.com/package/@earendil-works/pi-env): a small Rust daemon deployed over SSH, verified by SHA-256 before it runs, with host keys pinned in the agent's own `known_hosts` under a fixed alias — or `kind: local`, a daemon over a pipe, which is also how the tests exercise the path. The agent asks with `workspace_targets` (list, `*` marks the active one) and `workspace_target {name}` (`pod` returns to the container); the choice is a conversation document, so it applies to the next tool call and survives a restart, and a second conversation starts in the pod. This is not `runtime_exec`: that calls one relay-mediated command on a paired device, while a target replaces the environment `read`/`write`/`edit`/`bash` run in, so ordinary tools, image preparation and the shell all behave as if the machine were the pod. The remote user's permissions are the boundary.
- **Work status:** web chat shows `Queued` until the worker accepts the turn and `Running` while the relay waits for its result. Telegram DMs get a best-effort native typing indicator during slower work (both direct mode and the XMPP bridge). The relay sends no progress messages; typing failures do not delay work or change reply delivery.
- **Recovery:** restarting a worker on the same volume reopens its conversations and resumes unfinished runs. Worker submissions are deduplicated by turn ID. Side-effecting tools are not replayed after interruption. Telegram `sendMessage` has no idempotency key, so a crash or timeout after Telegram accepts a reply can cause a duplicate on retry. Replies longer than Telegram’s limit are truncated rather than sent in multiple parts.

## Stage a Kubernetes canary

[`deploy/helm/manolo`](deploy/helm/manolo) renders one relay and two independently pinned worker Deployments, each with its own PVC. It uses one replica and `Recreate` per volume; the processes also reject a second local writer. Ingress policy keeps worker HTTP behind the relay, the internal relay API behind worker credentials, and web ingress closed by default. This is not an egress sandbox or a hardened service for untrusted plug-ins. The chart does not publish an image, create credentials, add an HTTPRoute, or touch OpenClaw.

1. Build the supplied `Dockerfile`. Publish only to your chosen registry and set `relayImage`, `agents.primary.image` and `agents.canary.image` to the immutable digest(s). The same image supplies both entrypoints. `agents.<id>.fixture=true` is suitable for a credentialless worker smoke test; it disables relay-write tools in the Kubernetes fixture. For a real worker, specify a provider/catalog model and its API key. The PoC supports the explicit API-key providers in [`src/worker-runtime.mjs`](src/worker-runtime.mjs), not Pi CLI credential reuse or OAuth. A worker rejects switching provider/model against an existing data directory; use a fresh canary volume when testing a new model.
2. Use a dedicated namespace. Provision the existing Secret names in `values.yaml` (for `home-ops`, use ExternalSecrets backed by 1Password). Set independent random 32+ character values. The relay Secret contains `MANOLO_PRIMARY_TOKEN`, `MANOLO_CANARY_TOKEN`, `MANOLO_OWNER_PASSWORD`, `MANOLO_TESTER_PASSWORD` and, only when enabling Telegram, `MANOLO_TELEGRAM_TOKEN`. Each worker Secret has only its own matching value as `MANOLO_AGENT_TOKEN` plus its provider API key, e.g. `OPENAI_API_KEY`. Do not reuse OpenClaw tokens or credentials. For a first throwaway smoke test you can instead set short owner passwords like `owner`/`owner` and `relayDemoCredentials: true`; the relay then loads them only because `MANOLO_DEMO_ALLOW_NETWORK=1` lets a non-loopback listener opt in, and it logs a warning at startup. Turn the flag off and restore 32+ character values before any real use or shared ingress. A worker browser is opt-in per agent: set `agents.<id>.browser.enabled: true` and `browser.image` to an immutable `jlesage/chromium` digest, or leave it off for a worker that should never run one. It is refused on a fixture worker, and the chart renders a `<name>-browser` claim, a `desktop` service port and a relay-only NetworkPolicy entry only for enabled agents.
3. Create a bot with BotFather, start a DM to it, and obtain your numeric user/chat ID from a trusted Bot API `getUpdates` response. Use a bot with no webhook or other poller. Put exactly one entry in `relayConfig.routes`, e.g. `{transport: telegram, userId: '123456', chatId: '123456', agent: primary}` with your actual ID. Telegram retains undelivered updates for a limited time; the PoC has no automated cursor repair for a bot left idle for a week or more.
4. Review the rendered manifests before registering a release in Flux. Use a port-forward for the first browser smoke test (`kubectl -n manolo port-forward svc/manolo-relay 8080:8080`), never plaintext Basic Auth on a shared network. A family rollout should put the UI behind HTTPS and integrate the internal OIDC gateway rather than distribute permanent Basic credentials. Then verify a real Telegram DM on the new bot, a denied sender, a directed inbox note, and a canary-pod restart before adding any family accounts. Scale, backups and data retention should be settled before migration; worker PVCs contain conversation data.

### MCP configuration

Each worker keeps its servers in `<data>/mcp.json`; Helm's `agents.<id>.mcpServers` is only a **seed** for a fresh volume. Edit the file in the Dashboard's **MCP servers** card (or let the agent write it) and the change applies in place:

```json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data/workspace"] },
    "docs": { "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer ${MCP_DOCS_TOKEN}" } },
    "sentry": { "url": "https://mcp.sentry.dev/mcp" }
  }
}
```

`exposure` is `direct` (declared to the model, also callable from code mode), `deferred` (found with `tool_search`), `codemode` (only reachable from a `codemode` script) or `hidden`; `toolExposure` overrides it per tool name or `prefix*`. Scripts can call the worker's own `read`, `write`, `edit` and `bash` as well, so one script can drive the workspace and several MCP servers in a loop. `codemode` is offered when a server asks for it or when the operator sets `agents.<id>.codemode: true`. Set `publicUrl` so OAuth sign-in can complete: the authorization server redirects the owner's browser to `<publicUrl>/mcp/oauth/callback`, and the relay forwards the code to that owner's worker. A server that needs a pre-registered client takes `oauth: { clientId, clientSecret, scope }`; everything else registers dynamically. Tokens live on the volume, so a restart keeps the sign-in.

### Workspace targets over SSH

```yaml
agents:
  primary:
    remoteEnvs:
      beast:
        kind: ssh
        host: beast
        user: lanquarden
        cwd: /home/lanquarden
        knownHostsFile: /data/ssh/known_hosts
        identityFile: /data/ssh/id_ed25519
```

The private key must be owner-readable only, so it cannot come from a Secret mount; put it on the agent's own volume as the runtime user:

```sh
umask 077
kubectl -n manolo exec -i manolo-primary-<pod> -- sh -c 'mkdir -p /data/ssh && cat > /data/ssh/id_ed25519' < ~/.ssh/id_ed25519
kubectl -n manolo exec manolo-primary-<pod> -- node src/remote-env.mjs list
kubectl -n manolo exec manolo-primary-<pod> -- node src/remote-env.mjs trust beast
```

`trust` prints the host's key fingerprints so you can compare one out of band before accepting it; pi-env refuses an unknown or changed key instead of connecting. `cwd`, `knownHostsFile` and `identityFile` may use `${NAME}` from the worker environment (there is nothing secret to put in `host`, `user` or `hostKeyAlias`, so references there are refused).
### Try work sessions on the web canary

Roll out the new relay and worker images, then set `workSessionAgent` in Helm to a comma-separated list of agent IDs (`MANOLO_WORK_SESSION_AGENT` on the relay), for example `primary,canary`. This is off by default; it enables delegation for authenticated browser turns for that agent, not Telegram, Discord, or device turns. Sign in to the canary and ask the agent to delegate a small task. Follow the work link from the chat turn, or open **Sessions** for active work and turn on ended sessions to inspect the transcript afterward. Access follows the browser owner's conversation scope; another owner of the same agent cannot read the transcript.

A work session is part of the same agent, but runs in its own Pi Durable conversation. It receives the pod's installed tools (with `codingTools` on: `read`, `write`, `edit`, `bash`) so a delegated task can inspect and change files in the worker's workspace. It cannot start further work sessions, and it has no paired-device authority: a parent turn's grants do not transfer. Set the worker's `codingTools: false` to cut that back. The conversation session can use `delegate_work`, `get_work_result`, and `inspect_manolo` (read-only app metadata, not source or environment access). `delegate_work` waits up to 90 seconds; a pending result can be checked with `get_work_result`. The explorer lists recent work, not every internal Pi Durable session.

To add a blueprint, put a named entry under the worker’s `agents.<id>.workBlueprints` in Helm (or set `MANOLO_WORK_BLUEPRINTS` to the equivalent JSON object):

```yaml
agents:
  canary:
    workBlueprints:
      review:
        description: Review short project notes
        instructions: Lead with the conclusion and flag any missing evidence.
```

`inspect_manolo` lists blueprint names and descriptions. `delegate_work` can select one by ID. The work session records the selected revision and keeps its instructions across worker restarts. This changes instructions only; blueprints do not grant tools or credentials. Do not include secrets in blueprint text.

For an enabled browser turn, the agent can ask a question with `request_human_input`. The question appears in **Inbox** and the current turn can finish. Answering queues a follow-up in the original conversation; retrying the same response does not create another turn. Declining closes the question without a follow-up. An answer supplies context, not a new execution grant. This does not suspend a running child session or approve actions.

This slice runs work in the pod; it does not add group routing, cross-channel conversation linking, or remote work-session targets.


### Debugging inside a pod

The image also ships `git`, `curl`, `wget`, `jq`, `yq` and [`mise`](https://mise.jdx.dev) for `kubectl exec` sessions and for a worker's own `bash` tool, which runs as the same user. `YQ_VERSION` and `MISE_VERSION` are pinned at the top of the `Dockerfile` so a rebuild does not silently change what is in the image; the build prints each version as it installs it.

Worker pods get a `1Gi` memory limit and a `256Mi` `/tmp`, because image preparation and builds happen inside the pod; the relay keeps its smaller limits. A worker browser is a second container with its own `2Gi` limit and memory-backed `/tmp` and `/run`, so add it to the pod's total rather than borrowing from the worker's budget; Chromium's profile lives on the `<name>-browser` claim, never on `/data`. Because the chart keeps `readOnlyRootFilesystem: true`, it mounts a `1Gi` `emptyDir` at `/home/node` so the runtime user has a writable home for `git config`, caches and mise-installed runtimes. `/data` holds the harness state and the agent workspace; `/home/node` and the `32Mi` `/tmp` mount are ephemeral scratch space. The home volume is ephemeral: a pod restart discards anything installed there, and its contents count against the pod's ephemeral storage rather than the PVC. For a one-off binary, prefer `mise x <tool>@<version> -- <command>` over a global install. Anything worth keeping belongs in the workspace. Sizing limits live in `deploy/helm/manolo/templates/workloads.yaml`.

### Enable Discord only after the Telegram smoke test

Create a separate Discord bot with no administrator permission. Use a small private server shared with the bot if needed to open the DM. Enable Developer Mode to copy your user ID and the DM channel ID. Add `MANOLO_DISCORD_TOKEN` to the relay Secret and a route such as `{transport: discord, userId: '123456789012345678', chatId: '234567890123456789', agent: primary}`. Keep both IDs quoted: they exceed JavaScript's safe integer range. Discord starts only if there is a Discord route and uses no public HTTP callback. No privileged Message Content intent is required for a DM with the bot. Test an allowed DM and verify that a different account and a guild channel don't receive a reply. Existing Telegram routing doesn't change.

### Opt-in Telegram rooms

Set `relayConfig.rooms` in Helm (the `rooms` array in `relay.json` outside Helm). Use one binding per room, with quoted numeric IDs:

```yaml
relayConfig:
  rooms:
    - transport: telegram
      chatId: '-1001234567890'
      agent: canary
      wake: mentions
      members: ['123456', '789012']
      instructions: 'Answer scheduling questions concisely.'
```

- Rooms require the direct Bot API; the relay refuses room config in XMPP mode. For `mentions`, set `MANOLO_TELEGRAM_BOT_USERNAME` in the relay environment (from `relaySecret` in Helm), without `@`. Only matching Telegram mention entities wake the agent; plain text, replies to the bot alone, and mentions with no remaining text do not. `all` wakes on eligible text from any allowlisted sender that Telegram delivers. BotFather privacy mode can suppress ordinary group traffic; disable it on a dedicated bot if you want `all` to see every eligible message.
- Rooms accept stand-alone human text only: no forwards, edits, service messages, anonymous senders, voice, or forum topics. The relay holds up to four active jobs per room session; overflow is silent. Replies attach to the triggering message. Typing is best effort and never posts a progress message.
- Members share an agent conversation, separate from other rooms, DMs and web. Replies are visible to everyone with room access, not just senders on the allowlist. Instructions are non-secret, at most 2,000 UTF-16 code units, and set through relay config, not through chat. Rooms don't inherit the private operator prompt and have no worker tools, paired runtime, work links, or web mirror.

### Where to extend it

`src/telegram.mjs` and `src/discord.mjs` translate messaging APIs. `src/relay.mjs` owns routing authorization, durable delivery and reply correlation. `src/browser-proxy.mjs` owns the owner-scoped `/desktop/` proxy, and `src/browser-tools.mjs` owns the DevTools client the worker offers as `browser_*` tools. `src/mcp-config.mjs`, `src/mcp.mjs` and `src/mcp-oauth.mjs` own the MCP file, the live registry reconciliation and the OAuth sign-in; the relay only forwards owner requests and receives the callback. `src/remote-env.mjs` owns pi-env targets: the configuration, the lazily connected `RemoteExecutionEnv` per target, the `workspace_target*` tools, and the `trust` command. The normalized sender key is `(transport, userId, chatId)`, not an identity supplied to a model. WhatsApp and an XMPP bridge can sit at this boundary. An XMPP bridge should preserve authenticated upstream sender/conversation IDs and the return route; if it collapses everyone to one bridge account, there is no safe per-person route. No translation server is needed for Telegram or Discord.

`src/worker.mjs` owns the Pi Durable state. `src/dashboard.mjs` owns per-agent dashboard revisions. No shared worker volume, agent plug-ins, scheduling, or room membership in this slice. For opt-in unattended commands on a paired Linux machine, see [Paired Linux runtimes](pilots/RUNTIME.md). The `read`/`write`/`edit`/`bash` tools run in each worker's own container and workspace; anything that needs a real boundary (per-user file access, a network sandbox, a second writer) belongs outside them, not in a path check the shell can walk around. Nolan can use the browser from Windows; native Windows execution and scoped device enrollment are separate milestones. A paired desktop should not inherit a cluster or owner credential, or implicitly grant remote shell access.
