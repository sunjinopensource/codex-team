# codexm registry server

A tiny account-bundle repository for `codexm`, so several machines can share
managed accounts without copying files around by hand.

It stores the **exact JSON produced by `codexm export`** — no new format, no
re-encoding. Bundle validation stays in the Node client (`parseShareBundle`),
so this server never needs to understand the bundle contents beyond a few
metadata fields used for listing.

```
client (codexm remote pull)  ──►  GET  /v1/accounts/<name>   raw bundle
client (codexm remote push)  ──►  PUT  /v1/accounts/<name>   raw bundle
UI / CLI listing             ──►  GET  /v1/accounts          metadata only
```

## Run

```bash
pip install -r requirements.txt

# dev
export CODEXM_REGISTRY_DATA=./registry-data
flask --app server run --port 8787

# prod (single worker — JSON file storage is not multi-writer safe)
export CODEXM_REGISTRY_TOKEN=<a-long-random-string>
gunicorn -w 1 -b 127.0.0.1:8787 server:app
```

On first run without `CODEXM_REGISTRY_TOKEN`, a token is generated and written
to `<data-dir>/token.txt`. Copy it into your password manager and into each
client's `codexm remote add --token`.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `CODEXM_REGISTRY_DATA` | `./registry-data` | where bundles, index and audit log live |
| `CODEXM_REGISTRY_TOKEN` | `<data>/token.txt` | bearer token required by every `/v1` route |
| `PORT` | `8787` | only used by `python server.py` |

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/healthz` | unauthenticated liveness check |
| GET | `/v1/accounts` | list metadata (name, kind, plan, account_id, updated_at, last_downloaded_at) |
| GET | `/v1/accounts/<name>` | download the raw bundle; records `last_downloaded_at` |
| PUT | `/v1/accounts/<name>` | upload/overwrite a bundle |
| DELETE | `/v1/accounts/<name>` | remove an account |
| GET | `/v1/audit?limit=100` | recent audit entries |

All `/v1` routes require `Authorization: Bearer <token>`.

## Security notes

* **The bundles contain live refresh tokens.** Anyone with the token can
  download every account. Treat this host as a credential store.
* Serve over HTTPS or keep it on a private network (Tailscale/WireGuard/VPN).
  Plain HTTP on a public IP is not acceptable.
* Behind a reverse proxy, terminate TLS there (Caddy does this automatically:
  `caddy reverse-proxy --from registry.example.com --to :8787`).
* `gunicorn -w 1`: multiple workers would race on `index.json`. Switch to
  SQLite before scaling out.
* The audit log is append-only and records IP, action and account for every
  upload/download/delete.

## Known tradeoff

There is no lease/lock: two clients can download the same account and use it at
the same time. Because ChatGPT refresh tokens rotate, the first client to
refresh invalidates the other's refresh token. This mirrors what `codexm
export`/`import` already does today; `last_downloaded_at` is exposed so the UI
can warn when an account was recently pulled by someone else.
