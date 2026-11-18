#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")/../.."
project="manolo-telegram-${BASHPID}"
compose=(docker compose --project-name "$project" -f pilots/slidge/telegram-compose.yaml)
ca=$(mktemp)
cleanup() { "${compose[@]}" down --volumes >/dev/null; rm -f "$ca"; }
trap cleanup EXIT
"${compose[@]}" up -d
"${compose[@]}" exec -T prosody openssl x509 -in /etc/prosody/certs/localhost.crt -outform PEM >"$ca"
port=$("${compose[@]}" port prosody 5223)
for ((i = 0; i < 40; i++)); do
  if timeout 1 openssl s_client -connect "$port" -servername localhost -verify_hostname localhost -verify_return_error -CAfile "$ca" </dev/null >/dev/null 2>&1; then
    TEST_MANOLO_XMPP_SERVICE="xmpps://localhost:${port##*:}" NODE_EXTRA_CA_CERTS="$ca" \
      node --test --test-concurrency=1 test/relay.test.mjs test/relay-voice.test.mjs
    exit
  fi
  sleep .25
done
"${compose[@]}" logs >&2
exit 1
