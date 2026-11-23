# Paired Linux runtimes

A paired runtime lets one Manolo agent run unattended shell commands with the **companion user's full OS permissions**. Pod tools stay in the pod. Pair only an owner-controlled host and a trusted, web-only worker. The worker's existing container shell is not isolated from its worker credential, so do not add Telegram, Discord, Device API submit, or another less-trusted path to the paired worker. Command output goes to the model and can persist in Manolo's transcript. Pairing is not a desktop sandbox.

## Enable the relay

1. Use distinct random 32+ character credentials and set `relayDemoCredentials: false`. Confirm the paired agent has no messaging routes, no Device API submit grants, and no previously admitted untrusted work still running. Verify the owner interface is reachable only via your private HTTPS route.
2. Set `runtimeAgent` to the paired agent's ID and `runtimeIngressFrom` to the private ingress gateway's NetworkPolicy peers. Route only `devices.manolo.lanquarden.com` (TLS certificate for that exact name) to the `manolo-runtimes` ClusterIP, port 8084. Allow at least 8 seconds for its long poll. Do not route the worker, internal relay API, or owner interface from this hostname. The existing `manolo.lanquarden.com` web interface is unchanged. This listener is separate from the JWT-based [Device API](DEVICE.md).
3. Open **Dashboard → Paired runtimes** in the authenticated owner UI. Generate the single-use code (expires in ten minutes). The relay stores a hash of the companion's durable key in its existing SQLite PVC; restarting the relay does not require re-pairing.

## Pair and start on Linux

Run the following from the deployed Manolo source revision as the account whose OS permissions the agent should use. Use Node 24. Run the service only after enrollment succeeds.

```sh
install -D -m 0600 src/runtime-companion.mjs "$HOME/.local/lib/manolo/runtime-companion.mjs"
node "$HOME/.local/lib/manolo/runtime-companion.mjs" pair https://devices.manolo.lanquarden.com beast
```

Paste the code at the hidden prompt. The companion stores its credential at `~/.local/state/manolo-runtime/pairing.json` (0600). Never copy this file between machines or share it in a transcript. To start at boot, create `~/.local/share/systemd/user/manolo-runtime.service` from [`deploy/systemd/manolo-runtime.service`](../deploy/systemd/manolo-runtime.service) and replace `/usr/bin/node` with the absolute path from `command -v node`. Enable the unit with `systemctl --user daemon-reload && systemctl --user enable --now manolo-runtime`. Check `loginctl show-user "$USER" -p Linger`; a user manager needs lingering enabled to start before login. Keep the unit's stop action available even if Manolo is unreachable: `systemctl --user stop manolo-runtime`.

## Verify and revoke

- Refresh **Paired runtimes**; Beast should be online. In Manolo chat, ask it to use `bash` and `runtime_exec` to run `hostname` in the pod and on Beast. Inspect the two tool cards; the remote one identifies Beast and shows the actual command output.
- Restart the companion; it should come back online with the same device ID and without a code. Stop it; the next turn should no longer be offered the remote tool when there are no other runtimes. Revoke Beast in the Dashboard to invalidate its credential and block new calls. Revocation does not undo commands that might already have started.
- The relay never enqueues work for an offline or busy device. A lost result after dispatch is an unknown outcome and is not automatically replayed. A command may outlive a lost connection until its deadline; stopping the local service also stops its remaining processes.

Run `node --test test/runtime-relay.test.mjs test/runtime-companion.test.mjs` for the local process-level checks. Windows, browser and desktop-session control are not part of this slice.
