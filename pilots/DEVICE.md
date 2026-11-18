# Device API (opt-in, not exposed by default)

Set `MANOLO_DEVICE_CONFIG` to a JSON file with `issuer`, `audience`, public Ed25519 `keys` (JWK objects, each with a distinct `kid`), and `grants` such as `{ "nolan-laptop": { "primary": ["submit", "get"] } }`. A grant names an existing agent. The listener defaults to `127.0.0.1:8083`; override with `MANOLO_DEVICE_HOST` and `MANOLO_DEVICE_PORT`. With no config there is no device listener. Use `manolo-device-api` as a dedicated audience. Keep private keys with the issuer, never in Manolo or devices.

Pass an EdDSA-signed JWT in `Authorization: Bearer ...` with `iss`, `aud`, `sub`, `exp`, and optional `nbf`. The signed subject selects grants from config; token claims cannot broaden them. The API has no browser or internal-worker authentication fallback. It exposes only:

- `POST /v1/agents/:agent/turns` with `{ "id": "caller-chosen-id", "text": "message" }`.
- `GET /v1/agents/:agent/turns/:id` to read the submitting device's turn.

Turns are durable and isolated by subject and agent, and do not appear in browser history. Queue dispatch checks the current grant again. Scopes are configured on the relay; the token need not contain a scope claim.

To expose this on the cluster, provision signing/renewal/revocation and real device grants, give the listener a separate ClusterIP Service, allow only internal Envoy to reach it, and add required JWT policy with the same audience and public keys. `device.manolo.lanquarden.com` needs an internal HTTPS listener with a certificate for that exact name; the existing `*.lanquarden.com` wildcard does not cover it. Do not expose worker or internal relay ports.
