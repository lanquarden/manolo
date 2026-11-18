#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"

# A unique project prevents cleanup from touching another run.
project="manolo-slidge-${BASHPID}"
compose=(docker compose --project-name "$project" -f compose.yaml)
cleanup() { "${compose[@]}" down --volumes >/dev/null; }
trap cleanup EXIT
"${compose[@]}" up -d
probe() {
  "${compose[@]}" exec -T prosody openssl x509 -in /etc/prosody/certs/localhost.crt -outform PEM \
    | "${compose[@]}" exec -T slidge sh -c 'umask 077; tee /tmp/pilot-prosody-ca.pem >/dev/null' \
    && "${compose[@]}" exec -T -e PROSODY_CA=/tmp/pilot-prosody-ca.pem slidge /venv/bin/python - < discover.py
}
for ((attempt = 0; attempt < 5; attempt++)); do
  if output=$(probe 2>&1); then
    printf '%s\n' "$output"
    exit 0
  fi
  sleep 2
done
printf '%s\n' "$output" >&2
"${compose[@]}" logs --tail 20 >&2
exit 1
