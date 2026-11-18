# Slidge-WhatsApp voice-note pilot

This is a standalone, offline spike. It uses stock Slidge-WhatsApp `0.5.1.post1` and the upstream dev Prosody image, both pinned by digest. The Docker network has no external egress or published ports. Its fixture XMPP login and component secret are deliberately not production credentials. No WhatsApp registration, OpenClaw state, or cluster resources are used.

## Run the offline checks

From the Manolo repo:

```sh
bash pilots/slidge/smoke.sh
```

This starts the actual Prosody and Slidge containers, trusts the fixture Prosody certificate, signs in as the fixture XMPP user, and requires the component to respond to XMPP service discovery as a WhatsApp gateway. An offline fetch of the WhatsApp avatar may fail harmlessly. The script removes its own containers, volumes, and network.

The outbound audio probe runs the exact pinned Go bridge converter without changing upstream source. It needs Go 1.26+, `jq`, `ffmpeg` (with Opus and Vorbis encoders), and `ffprobe`:

```sh
pilot="$PWD/pilots/slidge"
upstream="$HOME/repos/slidge-whatsapp-manolo-pilot"
# If not already cloned:
# git clone --depth 1 --branch v0.5.1post1 https://codeberg.org/slidge/slidge-whatsapp.git "$upstream"
test "$(git -C "$upstream" rev-parse HEAD)" = 9c19eb47aa5f99514f519d705b3e6c32a4ab1e31
(
  cd "$upstream/slidge_whatsapp"
  overlay=$(mktemp)
  trap 'rm -f "$overlay"' EXIT
  jq -n --arg target "$PWD/manolo_voice_probe_test.go" \
    --arg source "$pilot/voice_probe_test.go" '{Replace:{($target):$source}}' > "$overlay"
  go test -overlay "$overlay" -run '^TestManoloPilotVoiceFormat$' -v .
)
```

Synthetic Ogg/Opus must take the stock MIME branch that the WhatsApp sender uses to set PTT. The Ogg/Vorbis control must not take it. This proves the converter and MIME condition, not a real upload or native rendering on a phone.

## Next: paired test account

Prepare an isolated egress-enabled instance with private credentials and persistent bridge state. Pair only a spare WhatsApp account with the bridge QR. Do not reuse OpenClaw's linked session or the production number. A second sender is needed to test group identity. Use harmless synthetic messages and recordings.

1. Send one recorded WhatsApp note and one attached audio file; inspect the trusted XMPP gateway's envelope. Capture component, stable chat/sender identifiers and event IDs, not phone numbers or audio in general logs. Record whether the native note metadata is distinguishable; test sender rename and reconnect.
2. Exercise one exact DM and one explicitly assigned group with two allowlisted senders. Confirm replies stay in the originating chat, DM and group contexts are distinct, an unknown sender is rejected before STT, and replay does not invoke a worker twice. Do not use display-text mentions as policy input.
3. Transcribe with the local ASR and use the local TTS to produce Ogg/Opus. Confirm the reply renders as a native playable WhatsApp voice note, not a generic file. Compare failures with the upstream voice-note reports before proposing a patch. Keep live calling and production accounts out of scope.

## Service boundaries under consideration

- `manolo.lanquarden.com`: human web UI and session APIs behind browser auth.
- `device.manolo.lanquarden.com`: proposed device-facing listener or service, JWT-required, with a dedicated audience and explicit per-device scopes. No browser session, Basic Auth fallback, or public worker routes. This requires an internal HTTPS route and TLS coverage for the full nested name.
- Private connector and service ingress: authenticated XMPP bridge and agent inbox traffic. Both use the same deterministic route rules as the web and device surfaces where appropriate, but never inherit a human login or share a browser-cookie boundary. Keep one source of truth for agent access and route decisions; split entrypoints before deciding whether they need separate deployments.

No hostname, device auth, or gateway integration is added by this spike.
