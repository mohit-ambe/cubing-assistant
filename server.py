import hashlib
import json
import os
import secrets
import threading
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request as UrlRequest
from urllib.request import urlopen

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

ROOT = Path(__file__).resolve().parent
DEFAULT_DATA_DIR = Path("/tmp/cubing-assistant") if os.environ.get("VERCEL") else ROOT / ".local"
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
    with SESSION_LOCK:
        SESSIONS[session_storage_key(session_id)] = session
        save_sessions_locked()
    return session_id, session.copy()


def lookup_session(session_id, now=None):
    if not session_id:
        return None, False

    now = int(time.time() if now is None else now)
    storage_key = session_storage_key(session_id)
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
    with SESSION_LOCK:
        if storage_key not in SESSIONS:
            return False
        del SESSIONS[storage_key]
        save_sessions_locked()
        return True


SESSIONS = load_sessions()
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
    return load_tokens().get(subject)


def store_user_tokens(subject, token_response):
    tokens = load_tokens()
    existing = tokens.get(subject, {})
    refresh_token = token_response.get("refresh_token") or existing.get("refresh_token")
    if not refresh_token:
        raise RuntimeError("Google did not return a refresh token. Revoke access and connect Drive again.")

    tokens[subject] = {
        "refresh_token": refresh_token,
        "scope": token_response.get("scope", existing.get("scope", "")),
        "updated_at": int(time.time() * 1000),
    }
    save_tokens(tokens)


def delete_user_tokens(subject):
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


def get_session(request):
    session_id = request.cookies.get(SESSION_COOKIE)
    session, renewed = lookup_session(session_id)
    if renewed:
        request.state.renewed_session_id = session_id
    return session


def require_session(request):
    session = get_session(request)
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
        "googleClientId": GOOGLE_CLIENT_ID
    }


@app.get("/api/auth/status")
async def auth_status(request: Request):
    session = get_session(request)
    if not session:
        return {
            "signedIn": False
        }
    return {
        "signedIn": True, **session,
        "driveConnected": bool(get_user_tokens(session["sub"])),
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
            delete_session(existing_session_id)
        session_id, session = create_session(profile)
    except (KeyError, RuntimeError, ValueError) as error:
        raise ApiError(str(error)) from error

    response = JSONResponse({
        **session,
        "driveConnected": bool(get_user_tokens(session["sub"])),
    })
    set_session_cookie(response, request, session_id)
    return response


@app.post("/api/auth/logout")
async def logout(request: Request):
    session_id = request.cookies.get(SESSION_COOKIE)
    if session_id:
        delete_session(session_id)

    response = JSONResponse({
                                "ok": True
                            })
    response.delete_cookie(SESSION_COOKIE, path="/", secure=request_is_https(request), httponly=True, samesite="lax", )
    return response


@app.get("/api/google/status")
async def drive_status(request: Request):
    session = require_session(request)
    return {
        "connected": bool(get_user_tokens(session["sub"]))
    }


@app.post("/api/google/code")
async def drive_code(request: Request):
    session = require_session(request)
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
        store_user_tokens(session["sub"], token_response)
        return {
            "connected": True
        }
    except (KeyError, RuntimeError, ValueError) as error:
        raise ApiError(str(error)) from error


@app.post("/api/google/disconnect")
async def drive_disconnect(request: Request):
    session = require_session(request)
    delete_user_tokens(session["sub"])
    return {
        "connected": False
    }


@app.get("/api/sync")
async def sync_download(request: Request):
    session = require_session(request)
    try:
        return await run_in_threadpool(read_drive_snapshot, session["sub"])
    except RuntimeError as error:
        raise ApiError(str(error)) from error


@app.post("/api/sync")
async def sync_upload(request: Request, mode: str = "newest"):
    session = require_session(request)
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