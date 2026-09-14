"""codexm registry server — a minimal account-bundle repository.

Design constraints:
  * stores the EXACT JSON produced by `codexm export` (bundle format untouched)
  * no business logic: validation of the bundle stays in the Node client
  * Bearer token auth, append-only audit log
  * no lease/lock: last writer wins (see README for the tradeoff)

Data layout (<data-dir>/):
  accounts/<name>.json   raw share bundle
  index.json             metadata for listing (never contains tokens)
  audit.jsonl            who did what, when
  token.txt              bearer token, generated on first run

Environment:
  CODEXM_REGISTRY_DATA   data directory (default: ./registry-data)
  CODEXM_REGISTRY_TOKEN  bearer token (default: read or generate <data>/token.txt)
  PORT                   listen port (default: 8787)

Run (dev):
  flask --app server run --port 8787
Run (prod):
  gunicorn -w 1 -b 127.0.0.1:8787 server:app     # single worker: JSON file storage
"""

from __future__ import annotations

import base64
import hmac
import json
import os
import re
import secrets
import time
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_file

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024  # bundles are a few KB

DATA = Path(os.environ.get("CODEXM_REGISTRY_DATA", "./registry-data"))
ACCOUNTS = DATA / "accounts"
INDEX = DATA / "index.json"
AUDIT = DATA / "audit.jsonl"
TOKEN_FILE = DATA / "token.txt"

# Same pattern the Node client uses for account names (keeps paths safe).
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

ACCOUNTS.mkdir(parents=True, exist_ok=True)


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def resolve_token() -> str:
    """Bearer token from env, or persisted in <data>/token.txt."""
    token = os.environ.get("CODEXM_REGISTRY_TOKEN", "").strip()
    if token:
        return token
    if TOKEN_FILE.exists():
        return TOKEN_FILE.read_text(encoding="utf-8").strip()
    generated = secrets.token_urlsafe(32)
    TOKEN_FILE.write_text(generated, encoding="utf-8")
    try:
        os.chmod(TOKEN_FILE, 0o600)
    except OSError:
        pass
    print(f"[registry] generated token -> {TOKEN_FILE}: {generated}")
    return generated


TOKEN = resolve_token()


def audit(action: str, name: str, ok: bool = True, note: str = "") -> None:
    entry = {
        "ts": now_iso(),
        "ip": request.remote_addr,
        "action": action,
        "account": name,
        "ok": ok,
        "note": note,
    }
    with AUDIT.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry) + "\n")


def load_index() -> dict:
    if not INDEX.exists():
        return {}
    try:
        data = json.loads(INDEX.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def save_index(index: dict) -> None:
    tmp = INDEX.with_suffix(".tmp")
    tmp.write_text(json.dumps(index, indent=2), encoding="utf-8")
    os.replace(tmp, INDEX)


def jwt_exp_iso(token: object) -> str | None:
    """Read a JWT's exp claim without verifying the signature.

    Metadata only: this tells clients which copy of an account is fresher so
    `codexm remote sync` never rewinds a token another machine just refreshed.
    """
    if not isinstance(token, str):
        return None
    parts = token.split(".")
    if len(parts) < 2:
        return None
    payload = parts[1]
    try:
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except Exception:
        return None
    exp = claims.get("exp") if isinstance(claims, dict) else None
    if not isinstance(exp, (int, float)):
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(exp))


def summarize(bundle: dict) -> dict:
    """Metadata only — never index token material."""
    auth = bundle.get("auth") or {}
    profile = auth.get("profile") or {}
    tokens = (auth.get("auth_json") or {}).get("tokens") or {}
    return {
        "kind": auth.get("kind"),
        "plan_type": profile.get("plan"),
        "account_id": tokens.get("account_id"),
        "token_expires_at": jwt_exp_iso(tokens.get("id_token"))
        or jwt_exp_iso(tokens.get("access_token")),
    }


@app.before_request
def check_auth():
    if request.path == "/healthz":
        return None
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return jsonify(error="missing bearer token"), 401
    if not TOKEN or not hmac.compare_digest(header[7:], TOKEN):
        return jsonify(error="invalid token"), 403
    return None


@app.get("/healthz")
def healthz():
    return jsonify(ok=True, accounts=len(load_index()))


@app.get("/v1/accounts")
def list_accounts():
    index = load_index()
    return jsonify(accounts=[{"name": name, **meta} for name, meta in index.items()])


@app.get("/v1/accounts/<name>")
def get_account(name: str):
    if not NAME_RE.match(name):
        abort(400, description="invalid account name")
    path = ACCOUNTS / f"{name}.json"
    if not path.exists():
        return jsonify(error="not found"), 404

    index = load_index()
    if name in index:
        index[name]["last_downloaded_at"] = now_iso()
        save_index(index)
    audit("download", name)
    return send_file(path, mimetype="application/json")


@app.put("/v1/accounts/<name>")
def put_account(name: str):
    if not NAME_RE.match(name):
        abort(400, description="invalid account name")
    bundle = request.get_json(force=True, silent=True)
    if not isinstance(bundle, dict) or bundle.get("kind") != "auth_bundle":
        audit("upload", name, ok=False, note="invalid bundle")
        return jsonify(error="invalid bundle: expected kind=auth_bundle"), 400

    tmp = ACCOUNTS / f"{name}.json.tmp"
    payload = json.dumps(bundle, indent=2)
    tmp.write_text(payload, encoding="utf-8")
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, ACCOUNTS / f"{name}.json")

    index = load_index()
    index[name] = {
        **summarize(bundle),
        "updated_at": now_iso(),
        "last_downloaded_at": index.get(name, {}).get("last_downloaded_at"),
        "size": len(payload),
    }
    save_index(index)
    audit("upload", name)
    return jsonify(ok=True, name=name)


@app.delete("/v1/accounts/<name>")
def delete_account(name: str):
    if not NAME_RE.match(name):
        abort(400, description="invalid account name")
    path = ACCOUNTS / f"{name}.json"
    if not path.exists():
        return jsonify(error="not found"), 404
    path.unlink()
    index = load_index()
    index.pop(name, None)
    save_index(index)
    audit("delete", name)
    return jsonify(ok=True)


@app.get("/v1/audit")
def get_audit():
    limit = request.args.get("limit", "100")
    try:
        limit = max(1, min(int(limit), 1000))
    except ValueError:
        limit = 100
    if not AUDIT.exists():
        return jsonify(entries=[])
    lines = AUDIT.read_text(encoding="utf-8").splitlines()[-limit:]
    entries = []
    for line in lines:
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return jsonify(entries=entries)


if __name__ == "__main__":
    # Default to loopback. Set HOST=0.0.0.0 to expose to your LAN — only do
    # that on a trusted network, since bundles carry live refresh tokens.
    app.run(
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "8787")),
    )
