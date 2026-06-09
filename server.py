import base64
import binascii
import hashlib
import json
import os
import secrets
import threading
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request as UrlRequest
from urllib.request import urlopen

import uvicorn
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

ROOT = Path(__file__).resolve().parent
IS_VERCEL = bool(os.environ.get("VERCEL"))
DEFAULT_DATA_DIR = Path("/tmp/cubing-assistant") if IS_VERCEL else ROOT / ".local"
LOCAL_DIR = Path(os.environ.get("CUBING_ASSISTANT_DATA_DIR", DEFAULT_DATA_DIR))
TOKENS_FILE = LOCAL_DIR / "google_tokens.json"
SESSIONS_FILE = LOCAL_DIR / "sessions.json"
DRIVE_FILENAME = "cubing-assistant-data.json"
SESSION_COOKIE = "cubing_assistant_session"
SESSION_FILE_VERSION = 2
SESSION_LOCK = threading.RLock()
MAX_JSON_BODY_BYTES = 2_000_000


def load_dotenv():
    env_file = ROOT / ".env"
    if not env_file.exists():
        return

    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


load_dotenv()
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
SUPABASE_SECRET = os.environ.get("SUPABASE_SECRET", "").strip()
TOKEN_ENCRYPTION_KEY = os.environ.get("TOKEN_ENCRYPTION_KEY", "")
SUPABASE_ENABLED = bool(SUPABASE_URL and SUPABASE_SECRET)


class PersistentStorageError(RuntimeError):
    pass


if bool(SUPABASE_URL) != bool(SUPABASE_SECRET):
    raise RuntimeError("SUPABASE_URL and SUPABASE_SECRET must be configured together.")
if SUPABASE_ENABLED and not TOKEN_ENCRYPTION_KEY:
    raise RuntimeError("TOKEN_ENCRYPTION_KEY is required when Supabase storage is enabled.")


def require_persistent_auth_storage():
    if IS_VERCEL and not SUPABASE_ENABLED:
        raise PersistentStorageError("Persistent authentication is not configured. Set SUPABASE_URL, "
                                     "SUPABASE_SECRET, and TOKEN_ENCRYPTION_KEY for this Vercel environment, then redeploy.")


def read_positive_int_env(name, default, minimum):
    try:
        return max(minimum, int(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


SESSION_TTL_SECONDS = read_positive_int_env("SESSION_TTL_SECONDS", 90 * 24 * 60 * 60, 3600)
SESSION_RENEW_AFTER_SECONDS = read_positive_int_env("SESSION_RENEW_AFTER_SECONDS", 24 * 60 * 60, 60)
SESSION_RENEW_AFTER_SECONDS = min(SESSION_RENEW_AFTER_SECONDS, max(60, SESSION_TTL_SECONDS // 2))
SESSION_COOKIE_SECURE = os.environ.get("SESSION_COOKIE_SECURE", "auto").strip().lower()


def read_json_file(path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return default


def write_json_file(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        path.parent.chmod(0o700)
    except OSError:
        pass

    temp_path = path.with_suffix(".tmp")
    temp_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    try:
        temp_path.chmod(0o600)
    except OSError:
        pass
    temp_path.replace(path)
    try:
        path.chmod(0o600)
    except OSError:
        pass


def supabase_request(table, *, method="GET", query=None, payload=None, prefer=None):
    if not SUPABASE_ENABLED:
        raise RuntimeError("Supabase storage is not configured.")

    url = f"{SUPABASE_URL}/rest/v1/{table}"
    if query:
        url = f"{url}?{urlencode(query, safe='(),.*')}"

    data = None
    headers = {
        "Accept": "application/json",
        "apikey": SUPABASE_SECRET,
    }
    if not SUPABASE_SECRET.startswith("sb_secret_"):
        headers["Authorization"] = f"Bearer {SUPABASE_SECRET}"
    if payload is not None:
        data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if prefer:
        headers["Prefer"] = prefer

    request = UrlRequest(url, data=data, method=method, headers=headers)
    try:
        with urlopen(request, timeout=15) as response:
            body = response.read().decode("utf-8")
            return json.loads(body) if body else None
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Supabase request failed ({error.code}): {body}") from error
    except URLError as error:
        raise RuntimeError(f"Supabase request failed: {error.reason}") from error


def token_cipher():
    key = hashlib.sha256(TOKEN_ENCRYPTION_KEY.encode("utf-8")).digest()
    return AESGCM(key)


def encrypt_refresh_token(subject, refresh_token):
    nonce = secrets.token_bytes(12)
    ciphertext = token_cipher().encrypt(nonce, refresh_token.encode("utf-8"), subject.encode("utf-8"))
    return base64.urlsafe_b64encode(nonce + ciphertext).decode("ascii")


def decrypt_refresh_token(subject, encrypted_token):
    try:
        value = base64.urlsafe_b64decode(encrypted_token.encode("ascii"))
        plaintext = token_cipher().decrypt(value[:12], value[12:], subject.encode("utf-8"))
        return plaintext.decode("utf-8")
    except (binascii.Error, InvalidTag, ValueError, UnicodeDecodeError) as error:
        raise RuntimeError("Stored Google authorization could not be decrypted.") from error


def session_storage_key(session_id):
    return hashlib.sha256(session_id.encode("utf-8")).hexdigest()


def load_sessions():
    payload = read_json_file(SESSIONS_FILE, {})
    stored_sessions = payload.get("sessions", {}) if isinstance(payload, dict) else {}
    file_version = payload.get("version", 1) if isinstance(payload, dict) else 1
    if not isinstance(stored_sessions, dict):
        return {}

    sessions = {}
    for stored_id, session in stored_sessions.items():
        if not isinstance(stored_id, str) or not isinstance(session, dict):
            continue
        try:
            expires_at = int(session.get("expires_at", 0))
            created_at = int(session.get("created_at", 0))
            last_seen_at = int(session.get("last_seen_at", created_at))
        except (TypeError, ValueError):
            continue
        if not session.get("sub") or expires_at <= 0:
            continue

        storage_key = session_storage_key(stored_id) if file_version < 2 else stored_id
        sessions[storage_key] = {
            **session,
            "created_at": created_at,
            "last_seen_at": last_seen_at,
            "expires_at": expires_at,
        }

    if file_version < SESSION_FILE_VERSION and sessions:
        write_json_file(SESSIONS_FILE, {
            "version": SESSION_FILE_VERSION,
            "sessions": sessions,
        }, )
    return sessions


def save_sessions_locked():
    write_json_file(SESSIONS_FILE, {
        "version": SESSION_FILE_VERSION,
        "sessions": SESSIONS,
    }, )


def prune_expired_sessions(now=None):
    now = int(time.time() if now is None else now)
    if SUPABASE_ENABLED:
        deleted = supabase_request("auth_sessions", method="DELETE", query={
            "expires_at": f"lte.{now}",
            "select": "session_hash"
        }, prefer="return=representation", )
        return len(deleted or [])

    with SESSION_LOCK:
        expired_ids = [session_id for session_id, session in SESSIONS.items() if
                       int(session.get("expires_at", 0)) <= now]
        if not expired_ids:
            return 0
        for session_id in expired_ids:
            del SESSIONS[session_id]
        save_sessions_locked()
        return len(expired_ids)


def create_session(profile, now=None):
    require_persistent_auth_storage()
    now = int(time.time() if now is None else now)
    session_id = secrets.token_urlsafe(32)
    session = {
        "sub": profile["sub"],
        "name": profile.get("name", ""),
        "email": profile.get("email", ""),
        "picture": profile.get("picture", ""),
        "created_at": now,
        "last_seen_at": now,
        "expires_at": now + SESSION_TTL_SECONDS,
    }
    storage_key = session_storage_key(session_id)
    if SUPABASE_ENABLED:
        supabase_request("auth_sessions", method="POST", query={
            "on_conflict": "session_hash"
        }, payload={
            "session_hash": storage_key,
            "google_sub": session["sub"],
            "name": session["name"],
            "email": session["email"],
            "picture": session["picture"],
            "created_at": session["created_at"],
            "last_seen_at": session["last_seen_at"],
            "expires_at": session["expires_at"],
        }, prefer="resolution=merge-duplicates,return=minimal", )
    else:
        with SESSION_LOCK:
            SESSIONS[storage_key] = session
            save_sessions_locked()
    return session_id, session.copy()


def lookup_session(session_id, now=None):
    require_persistent_auth_storage()
    if not session_id:
        return None, False

    now = int(time.time() if now is None else now)
    storage_key = session_storage_key(session_id)
    if SUPABASE_ENABLED:
        rows = supabase_request("auth_sessions", query={
            "session_hash": f"eq.{storage_key}",
            "select": "google_sub,name,email,picture,created_at,last_seen_at,expires_at",
            "limit": "1",
        }, )
        if not rows:
            return None, False

        row = rows[0]
        session = {
            "sub": row["google_sub"],
            "name": row.get("name") or "",
            "email": row.get("email") or "",
            "picture": row.get("picture") or "",
            "created_at": int(row["created_at"]),
            "last_seen_at": int(row["last_seen_at"]),
            "expires_at": int(row["expires_at"]),
        }
        if session["expires_at"] <= now:
            delete_session(session_id)
            return None, False

        renewed = now - session["last_seen_at"] >= SESSION_RENEW_AFTER_SECONDS
        if renewed:
            session["last_seen_at"] = now
            session["expires_at"] = now + SESSION_TTL_SECONDS
            supabase_request("auth_sessions", method="PATCH", query={
                "session_hash": f"eq.{storage_key}"
            }, payload={
                "last_seen_at": session["last_seen_at"],
                "expires_at": session["expires_at"],
            }, prefer="return=minimal", )
        return session, renewed

    with SESSION_LOCK:
        session = SESSIONS.get(storage_key)
        if not session:
            return None, False
        if int(session.get("expires_at", 0)) <= now:
            del SESSIONS[storage_key]
            save_sessions_locked()
            return None, False

        last_seen_at = int(session.get("last_seen_at", session.get("created_at", 0)))
        renewed = now - last_seen_at >= SESSION_RENEW_AFTER_SECONDS
        if renewed:
            session["last_seen_at"] = now
            session["expires_at"] = now + SESSION_TTL_SECONDS
            save_sessions_locked()
        return session.copy(), renewed


def delete_session(session_id):
    if not session_id:
        return False

    storage_key = session_storage_key(session_id)
    if SUPABASE_ENABLED:
        deleted = supabase_request("auth_sessions", method="DELETE", query={
            "session_hash": f"eq.{storage_key}",
            "select": "session_hash"
        }, prefer="return=representation", )
        return bool(deleted)

    with SESSION_LOCK:
        if storage_key not in SESSIONS:
            return False
        del SESSIONS[storage_key]
        save_sessions_locked()
        return True


SESSIONS = {} if SUPABASE_ENABLED else load_sessions()
if not SUPABASE_ENABLED:
    prune_expired_sessions()


def google_json(url, *, method="GET", data=None, headers=None):
    request_headers = {
        "Accept": "application/json", **(headers or {})
    }
    request = UrlRequest(url, data=data, method=method, headers=request_headers)
    try:
        with urlopen(request, timeout=15) as response:
            body = response.read().decode("utf-8")
            return json.loads(body) if body else {}
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Google API request failed ({error.code}): {body}") from error


def google_form(url, payload):
    return google_json(url, method="POST", data=urlencode(payload).encode("utf-8"), headers={
        "Content-Type": "application/x-www-form-urlencoded"
    }, )


def load_tokens():
    return read_json_file(TOKENS_FILE, {})


def save_tokens(tokens):
    write_json_file(TOKENS_FILE, tokens)


def get_user_tokens(subject):
    if SUPABASE_ENABLED:
        rows = supabase_request("google_tokens", query={
            "google_sub": f"eq.{subject}",
            "select": "refresh_token_ciphertext,scope,updated_at",
            "limit": "1",
        }, )
        if not rows:
            return None
        row = rows[0]
        try:
            refresh_token = decrypt_refresh_token(subject, row["refresh_token_ciphertext"])
        except RuntimeError:
            supabase_request("google_tokens", method="DELETE", query={
                "google_sub": f"eq.{subject}"
            }, prefer="return=minimal", )
            return None
        return {
            "refresh_token": refresh_token,
            "scope": row.get("scope") or "",
            "updated_at": int(row["updated_at"]),
        }
    return load_tokens().get(subject)


def store_user_tokens(subject, token_response):
    existing = get_user_tokens(subject) or {}
    refresh_token = token_response.get("refresh_token") or existing.get("refresh_token")
    if not refresh_token:
        raise RuntimeError("Google did not return a refresh token. Revoke access and connect Drive again.")

    stored = {
        "refresh_token": refresh_token,
        "scope": token_response.get("scope", existing.get("scope", "")),
        "updated_at": int(time.time() * 1000),
    }
    if SUPABASE_ENABLED:
        supabase_request("google_tokens", method="POST", query={
            "on_conflict": "google_sub"
        }, payload={
            "google_sub": subject,
            "refresh_token_ciphertext": encrypt_refresh_token(subject, stored["refresh_token"]),
            "scope": stored["scope"],
            "updated_at": stored["updated_at"],
        }, prefer="resolution=merge-duplicates,return=minimal", )
        return

    tokens = load_tokens()
    tokens[subject] = stored
    save_tokens(tokens)


def delete_user_tokens(subject):
    if SUPABASE_ENABLED:
        supabase_request("google_tokens", method="DELETE", query={
            "google_sub": f"eq.{subject}"
        }, prefer="return=minimal", )
        return

    tokens = load_tokens()
    if subject in tokens:
        del tokens[subject]
        save_tokens(tokens)


def refresh_access_token(subject):
    stored = get_user_tokens(subject)
    if not stored:
        raise RuntimeError("Drive is not connected.")

    response = google_form("https://oauth2.googleapis.com/token", {
        "client_id": GOOGLE_CLIENT_ID,
        "client_secret": GOOGLE_CLIENT_SECRET,
        "refresh_token": stored["refresh_token"],
        "grant_type": "refresh_token",
    }, )
    return response["access_token"]


def drive_request(subject, url, *, method="GET", data=None, headers=None):
    access_token = refresh_access_token(subject)
    return google_json(url, method=method, data=data, headers={
        "Authorization": f"Bearer {access_token}", **(headers or {})
    }, )


def find_drive_snapshot(subject):
    query = quote(f"name = '{DRIVE_FILENAME}'")
    response = drive_request(subject,
                             f"https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q={query}&fields=files(id,name)", )
    files = response.get("files", [])
    return files[0]["id"] if files else None


def read_drive_snapshot(subject):
    file_id = find_drive_snapshot(subject)
    if not file_id:
        return {
            "schemaVersion": 2,
            "solves": [],
            "sessions": [],
            "sessionScrambleIndexes": {}
        }

    access_token = refresh_access_token(subject)
    request = UrlRequest(f"https://www.googleapis.com/drive/v3/files/{file_id}?alt=media", headers={
        "Authorization": f"Bearer {access_token}"
    }, )
    try:
        with urlopen(request, timeout=15) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Drive download failed ({error.code}): {body}") from error


def write_drive_snapshot(subject, snapshot):
    file_id = find_drive_snapshot(subject)
    content = json.dumps(snapshot, separators=(",", ":")).encode("utf-8")
    access_token = refresh_access_token(subject)

    if file_id:
        request = UrlRequest(f"https://www.googleapis.com/upload/drive/v3/files/{file_id}?uploadType=media",
                             data=content, method="PATCH", headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
            }, )
    else:
        boundary = f"cubing-assistant-{secrets.token_hex(12)}"
        metadata = json.dumps({
            "name": DRIVE_FILENAME,
            "parents": ["appDataFolder"]
        }).encode("utf-8")
        content = (f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n".encode(
            "utf-8") + metadata + f"\r\n--{boundary}\r\nContent-Type: application/json\r\n\r\n".encode(
            "utf-8") + content + f"\r\n--{boundary}--".encode("utf-8"))
        request = UrlRequest("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", data=content,
                             method="POST", headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": f"multipart/related; boundary={boundary}",
            }, )

    try:
        with urlopen(request, timeout=15) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Drive upload failed ({error.code}): {body}") from error


def record_updated_at(record):
    return int(
        record.get("updatedAt") or record.get("deletedAt") or record.get("redoneAt") or record.get("createdAt") or 0)


def choose_record(left, right, mode):
    if mode == "local":
        return right
    if mode == "drive":
        return left
    return right if record_updated_at(right) >= record_updated_at(left) else left


def merge_snapshots(left, right, mode="newest"):
    merged_solves = {}
    for solve in [*left.get("solves", []), *right.get("solves", [])]:
        solve_id = solve.get("id")
        if not solve_id:
            continue
        current = merged_solves.get(solve_id)
        merged_solves[solve_id] = solve if not current else choose_record(current, solve, mode)

    sessions = {}
    for session in [*left.get("sessions", []), *right.get("sessions", [])]:
        session_id = session.get("id")
        if not session_id:
            continue
        current = sessions.get(session_id)
        sessions[session_id] = session if not current else choose_record(current, session, mode)

    if mode == "drive":
        session_scramble_indexes = {
            **right.get("sessionScrambleIndexes", {}), **left.get("sessionScrambleIndexes", {}),
        }
    else:
        session_scramble_indexes = {
            **left.get("sessionScrambleIndexes", {}), **right.get("sessionScrambleIndexes", {}),
        }

    left_theme = left.get("theme") or {}
    right_theme = right.get("theme") or {}
    theme = choose_record(left_theme, right_theme, mode) if (left_theme or right_theme) else {}
    return {
        "schemaVersion": 2,
        "updatedAt": int(time.time() * 1000),
        "sessions": list(sessions.values()),
        "sessionScrambleIndexes": session_scramble_indexes,
        "solves": list(merged_solves.values()),
        "theme": theme,
    }


class ApiError(Exception):
    def __init__(self, message, status_code=400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
app.mount("/logo", StaticFiles(directory=ROOT / "logo"), name="logo")
app.mount("/scramble", StaticFiles(directory=ROOT / "scramble"), name="scramble")


@app.exception_handler(ApiError)
async def handle_api_error(_request, error):
    return JSONResponse({
        "error": error.message
    }, status_code=error.status_code)


@app.middleware("http")
async def add_response_headers(request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    renewed_session_id = getattr(request.state, "renewed_session_id", None)
    if renewed_session_id:
        set_session_cookie(response, request, renewed_session_id)
    return response


def request_is_https(request):
    if SESSION_COOKIE_SECURE in {"1", "true", "yes", "on"}:
        return True
    if SESSION_COOKIE_SECURE in {"0", "false", "no", "off"}:
        return False
    forwarded_proto = request.headers.get("x-forwarded-proto", "").split(",", 1)[0].strip().lower()
    return forwarded_proto == "https" or request.url.scheme == "https"


def set_session_cookie(response, request, session_id, max_age=SESSION_TTL_SECONDS):
    response.set_cookie(key=SESSION_COOKIE, value=session_id, max_age=max_age, expires=max_age, path="/",
                        secure=request_is_https(request), httponly=True, samesite="lax", )


async def get_session(request):
    session_id = request.cookies.get(SESSION_COOKIE)
    try:
        session, renewed = await run_in_threadpool(lookup_session, session_id)
    except PersistentStorageError as error:
        raise ApiError(str(error), 503) from error
    if renewed:
        request.state.renewed_session_id = session_id
    return session


async def require_session(request):
    session = await get_session(request)
    if not session:
        raise ApiError("Sign in with Google first.", 401)
    return session


async def read_json_body(request):
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_JSON_BODY_BYTES:
                raise ApiError("Request body is too large.", 413)
        except ValueError as error:
            raise ApiError("Invalid Content-Length header.") from error

    body = await request.body()
    if len(body) > MAX_JSON_BODY_BYTES:
        raise ApiError("Request body is too large.", 413)
    try:
        return json.loads(body.decode("utf-8") or "{}")
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ApiError("Request body must be valid JSON.") from error


def page_response(filename):
    return FileResponse(ROOT / "static" / filename)


@app.get("/")
@app.get("/timer")
@app.get("/solve")
async def solve_page():
    return page_response("index.html")


@app.get("/analytics")
async def analytics_page():
    return page_response("analytics.html")


@app.get("/manage")
async def manage_page():
    return page_response("manage.html")


@app.get("/appearance")
async def appearance_page():
    return page_response("appearance.html")


@app.get("/login")
async def login_page():
    return page_response("login.html")


@app.get("/api/config")
async def config():
    return {
        "googleClientId": GOOGLE_CLIENT_ID,
        "storageBackend": "supabase" if SUPABASE_ENABLED else "local",
        "persistentAuthConfigured": SUPABASE_ENABLED,
    }


@app.get("/api/storage/status")
async def storage_status():
    if not SUPABASE_ENABLED:
        return JSONResponse({
            "backend": "local",
            "configured": False,
            "reachable": not IS_VERCEL,
            "message": (
                "Supabase environment variables are missing from this Vercel deployment." if IS_VERCEL else "Using local JSON storage."),
        }, status_code=503 if IS_VERCEL else 200, )

    try:
        await run_in_threadpool(supabase_request, "auth_sessions", query={
            "select": "session_hash",
            "limit": "1"
        }, )
        await run_in_threadpool(supabase_request, "google_tokens", query={
            "select": "google_sub",
            "limit": "1"
        }, )
    except RuntimeError as error:
        return JSONResponse({
            "backend": "supabase",
            "configured": True,
            "reachable": False,
            "message": str(error),
        }, status_code=503, )

    return {
        "backend": "supabase",
        "configured": True,
        "reachable": True,
        "message": "Supabase authentication storage is available.",
    }


@app.get("/api/auth/status")
async def auth_status(request: Request):
    session = await get_session(request)
    if not session:
        return {
            "signedIn": False
        }
    drive_connected = await run_in_threadpool(get_user_tokens, session["sub"])
    return {
        "signedIn": True, **session,
        "driveConnected": bool(drive_connected),
    }


@app.post("/api/auth/google")
async def google_login(request: Request):
    payload = await read_json_body(request)
    try:
        credential = payload["credential"]
        query = urlencode({
            "id_token": credential
        })
        profile = await run_in_threadpool(google_json, f"https://oauth2.googleapis.com/tokeninfo?{query}", )
        if profile.get("aud") != GOOGLE_CLIENT_ID:
            raise RuntimeError("Google token audience did not match this app.")

        existing_session_id = request.cookies.get(SESSION_COOKIE)
        if existing_session_id:
            await run_in_threadpool(delete_session, existing_session_id)
        session_id, session = await run_in_threadpool(create_session, profile)
    except PersistentStorageError as error:
        raise ApiError(str(error), 503) from error
    except (KeyError, RuntimeError, ValueError) as error:
        raise ApiError(str(error)) from error

    drive_connected = await run_in_threadpool(get_user_tokens, session["sub"])
    response = JSONResponse({
        **session,
        "driveConnected": bool(drive_connected),
    })
    set_session_cookie(response, request, session_id)
    return response


@app.post("/api/auth/logout")
async def logout(request: Request):
    session_id = request.cookies.get(SESSION_COOKIE)
    if session_id:
        await run_in_threadpool(delete_session, session_id)

    response = JSONResponse({
        "ok": True
    })
    response.delete_cookie(SESSION_COOKIE, path="/", secure=request_is_https(request), httponly=True, samesite="lax", )
    return response


@app.get("/api/google/status")
async def drive_status(request: Request):
    session = await require_session(request)
    connected = await run_in_threadpool(get_user_tokens, session["sub"])
    return {
        "connected": bool(connected)
    }


@app.post("/api/google/code")
async def drive_code(request: Request):
    session = await require_session(request)
    payload = await read_json_body(request)
    try:
        code = payload["code"]
        redirect_uri = request.headers.get("origin") or str(request.base_url).rstrip("/")
        token_response = await run_in_threadpool(google_form, "https://oauth2.googleapis.com/token", {
            "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": redirect_uri,
        }, )
        await run_in_threadpool(store_user_tokens, session["sub"], token_response)
        return {
            "connected": True
        }
    except (KeyError, RuntimeError, ValueError) as error:
        raise ApiError(str(error)) from error


@app.post("/api/google/disconnect")
async def drive_disconnect(request: Request):
    session = await require_session(request)
    await run_in_threadpool(delete_user_tokens, session["sub"])
    return {
        "connected": False
    }


@app.get("/api/sync")
async def sync_download(request: Request):
    session = await require_session(request)
    try:
        return await run_in_threadpool(read_drive_snapshot, session["sub"])
    except RuntimeError as error:
        raise ApiError(str(error)) from error


@app.post("/api/sync")
async def sync_upload(request: Request, mode: str = "newest"):
    session = await require_session(request)
    if mode not in {"newest", "local", "drive"}:
        mode = "newest"
    incoming = await read_json_body(request)
    try:
        remote = await run_in_threadpool(read_drive_snapshot, session["sub"])
        merged = merge_snapshots(remote, incoming, mode)
        await run_in_threadpool(write_drive_snapshot, session["sub"], merged)
        return merged
    except RuntimeError as error:
        raise ApiError(str(error)) from error


def main():
    uvicorn.run("server:app", host="127.0.0.1", port=8000, reload=False)


if __name__ == "__main__":
    main()