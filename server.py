import base64
import binascii
import hashlib
import json
import os
import secrets
import sqlite3
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
IMPORT_DIR = LOCAL_DIR / "imports"
IMPORT_DB = LOCAL_DIR / "imports.sqlite3"
IMPORT_MAX_BYTES = 1_000_000_000
IMPORT_BATCH_SIZE = 2_000
DRIVE_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024
SYNC_CHUNK_TARGET_BYTES = 1_250_000
SYNC_TRANSFER_TTL_SECONDS = 24 * 60 * 60
IMPORT_WORKER_EVENT = threading.Event()
IMPORT_WORKER_STOP = threading.Event()
IMPORT_WORKER_THREAD = None
DRIVE_LOCKS = {}
DRIVE_LOCKS_GUARD = threading.Lock()
CSTIMER_EVENTS = {
    "222so": "222",
    "333": "333",
    "333oh": "333oh",
    "333ni": "333bf",
    "333fm": "333fm",
    "r3ni": "333mbf",
    "444wca": "444",
    "555wca": "555",
    "666wca": "666",
    "777wca": "777",
    "clkwca": "clock",
    "mgmp": "minx",
    "pyrso": "pyram",
    "skbso": "skewb",
    "sqrs": "sq1",
}
EVENT_LABELS = {
    "222": "2x2",
    "333": "3x3",
    "444": "4x4",
    "555": "5x5",
    "666": "6x6",
    "777": "7x7",
    "333oh": "3x3 OH",
    "333bf": "3x3 Blindfolded",
    "333fm": "3x3 Fewest Moves",
    "333mbf": "3x3 Multi-Blind",
    "clock": "Clock",
    "minx": "Megaminx",
    "pyram": "Pyraminx",
    "skewb": "Skewb",
    "sq1": "Square-1",
}


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
IMPORT_MAX_BYTES = read_positive_int_env("IMPORT_MAX_BYTES", IMPORT_MAX_BYTES, 1024 * 1024)
IMPORT_BATCH_SIZE = read_positive_int_env("IMPORT_BATCH_SIZE", IMPORT_BATCH_SIZE, 100)
DRIVE_UPLOAD_CHUNK_BYTES = read_positive_int_env("DRIVE_UPLOAD_CHUNK_BYTES", DRIVE_UPLOAD_CHUNK_BYTES, 256 * 1024, )
DRIVE_UPLOAD_CHUNK_BYTES -= DRIVE_UPLOAD_CHUNK_BYTES % (256 * 1024)


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


def drive_subject_lock(subject):
    with DRIVE_LOCKS_GUARD:
        return DRIVE_LOCKS.setdefault(subject, threading.Lock())


def sync_drive_snapshot(subject, incoming, mode):
    with drive_subject_lock(subject):
        remote = read_drive_snapshot(subject)
        merged = merge_snapshots(remote, incoming, mode)
        write_drive_snapshot(subject, merged)
        return merged


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


def require_import_storage():
    if IS_VERCEL:
        raise ApiError("Large imports require a persistent server filesystem and cannot run reliably on Vercel.", 503, )


def require_sync_transfer_storage():
    if IS_VERCEL:
        raise ApiError(
            "Chunked synchronization requires a persistent server filesystem and cannot run reliably on Vercel.", 503, )


def import_db():
    LOCAL_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(IMPORT_DB, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA busy_timeout=30000")
    return connection


def initialize_import_storage(recover_jobs=True):
    IMPORT_DIR.mkdir(parents=True, exist_ok=True)
    with import_db() as connection:
        connection.executescript("""
            CREATE TABLE IF NOT EXISTS import_jobs (
                id TEXT PRIMARY KEY,
                google_sub TEXT NOT NULL,
                status TEXT NOT NULL,
                source_path TEXT NOT NULL,
                output_path TEXT,
                file_name TEXT NOT NULL,
                file_size INTEGER NOT NULL DEFAULT 0,
                total_sessions INTEGER NOT NULL DEFAULT 0,
                total_solves INTEGER NOT NULL DEFAULT 0,
                processed_solves INTEGER NOT NULL DEFAULT 0,
                upload_total_bytes INTEGER NOT NULL DEFAULT 0,
                upload_sent_bytes INTEGER NOT NULL DEFAULT 0,
                configuration_json TEXT,
                result_json TEXT,
                drive_upload_uri TEXT,
                drive_upload_offset INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS import_sessions (
                job_id TEXT NOT NULL,
                source_key TEXT NOT NULL,
                source_order INTEGER NOT NULL,
                default_name TEXT NOT NULL,
                default_event TEXT NOT NULL,
                phase_count INTEGER,
                solve_count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (job_id, source_key)
            );
            CREATE TABLE IF NOT EXISTS import_solves (
                job_id TEXT NOT NULL,
                solve_id TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                PRIMARY KEY (job_id, solve_id)
            );
            CREATE TABLE IF NOT EXISTS sync_transfers (
                id TEXT PRIMARY KEY,
                google_sub TEXT NOT NULL,
                direction TEXT NOT NULL,
                status TEXT NOT NULL,
                mode TEXT NOT NULL DEFAULT 'newest',
                metadata_json TEXT NOT NULL,
                total_solves INTEGER NOT NULL,
                received_solves INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sync_transfer_solves (
                transfer_id TEXT NOT NULL,
                solve_index INTEGER NOT NULL,
                payload_json TEXT NOT NULL,
                PRIMARY KEY (transfer_id, solve_index)
            );
            CREATE INDEX IF NOT EXISTS import_jobs_subject_updated
                ON import_jobs (google_sub, updated_at DESC);
            CREATE INDEX IF NOT EXISTS sync_transfers_subject_updated
                ON sync_transfers (google_sub, updated_at DESC);
        """)
        session_columns = {row["name"] for row in connection.execute("PRAGMA table_info(import_sessions)").fetchall()}
        if "phase_count" not in session_columns:
            connection.execute("ALTER TABLE import_sessions ADD COLUMN phase_count INTEGER")
        if recover_jobs:
            connection.execute("""
                UPDATE import_jobs
                SET status = 'queued', updated_at = ?
                WHERE status IN ('parsing', 'merging', 'drive_uploading')
            """, (int(time.time() * 1000),))
            connection.execute("""
                UPDATE import_jobs
                SET status = 'uploaded', updated_at = ?
                WHERE status = 'inspecting'
            """, (int(time.time() * 1000),))
        expires_before = int((time.time() - SYNC_TRANSFER_TTL_SECONDS) * 1000)
        expired_ids = [row["id"] for row in
            connection.execute("SELECT id FROM sync_transfers WHERE updated_at < ?", (expires_before,), ).fetchall()]
        if expired_ids:
            placeholders = ",".join("?" for _ in expired_ids)
            connection.execute(f"DELETE FROM sync_transfer_solves WHERE transfer_id IN ({placeholders})", expired_ids, )
            connection.execute(f"DELETE FROM sync_transfers WHERE id IN ({placeholders})", expired_ids, )


def update_import_job(job_id, **fields):
    if not fields:
        return
    fields["updated_at"] = int(time.time() * 1000)
    assignments = ", ".join(f"{name} = ?" for name in fields)
    with import_db() as connection:
        connection.execute(f"UPDATE import_jobs SET {assignments} WHERE id = ?", (*fields.values(), job_id), )


def get_import_job(job_id, subject=None):
    query = "SELECT * FROM import_jobs WHERE id = ?"
    parameters = [job_id]
    if subject is not None:
        query += " AND google_sub = ?"
        parameters.append(subject)
    with import_db() as connection:
        return connection.execute(query, parameters).fetchone()


def import_job_cancelled(job_id):
    job = get_import_job(job_id)
    return not job or job["status"] == "cancelled"


def detect_cstimer_event(metadata):
    scr_type = metadata.get("opt", {}).get("scrType", "") if isinstance(metadata, dict) else ""
    if scr_type in CSTIMER_EVENTS:
        return CSTIMER_EVENTS[scr_type]
    name = str(metadata.get("name", "") if isinstance(metadata, dict) else "").lower()
    for event_id, label in EVENT_LABELS.items():
        if label.lower() in name:
            return event_id
    return "333"


class JsonStreamReader:
    def __init__(self, source, chunk_size=1024 * 1024):
        self.source = source
        self.chunk_size = chunk_size
        self.buffer = ""
        self.position = 0
        self.eof = False
        self.decoder = json.JSONDecoder()

    def fill(self):
        if self.position:
            self.buffer = self.buffer[self.position:]
            self.position = 0
        chunk = self.source.read(self.chunk_size)
        if chunk:
            self.buffer += chunk
        else:
            self.eof = True

    def skip_whitespace(self):
        while True:
            while self.position < len(self.buffer) and self.buffer[self.position].isspace():
                self.position += 1
            if self.position < len(self.buffer) or self.eof:
                return
            self.fill()

    def peek(self):
        self.skip_whitespace()
        if self.position >= len(self.buffer):
            raise RuntimeError("The csTimer backup ended unexpectedly.")
        return self.buffer[self.position]

    def expect(self, character):
        if self.peek() != character:
            raise RuntimeError(f"Expected '{character}' in the csTimer backup.")
        self.position += 1

    def value(self):
        self.skip_whitespace()
        while True:
            start = self.position
            try:
                value, end = self.decoder.raw_decode(self.buffer, start)
                if end == len(self.buffer) and not self.eof:
                    self.fill()
                    continue
                self.position = end
                return value
            except json.JSONDecodeError as error:
                if self.eof:
                    raise RuntimeError(f"Invalid csTimer JSON near character {error.pos}.") from error
                self.fill()


def scan_cstimer_backup(path, solve_callback=None):
    counts = {}
    metadata = {}
    try:
        with Path(path).open("r", encoding="utf-8") as source:
            reader = JsonStreamReader(source)
            reader.expect("{")
            if reader.peek() == "}":
                reader.expect("}")
                return counts, metadata
            while True:
                key = reader.value()
                if not isinstance(key, str):
                    raise RuntimeError("The csTimer backup contains a non-text property name.")
                reader.expect(":")
                if key.removeprefix("session").isdigit() and reader.peek() == "[":
                    count = 0
                    reader.expect("[")
                    if reader.peek() != "]":
                        while True:
                            raw_solve = reader.value()
                            count += 1
                            if solve_callback:
                                solve_callback(key, raw_solve)
                            separator = reader.peek()
                            if separator == "]":
                                break
                            reader.expect(",")
                    reader.expect("]")
                    counts[key] = count
                else:
                    value = reader.value()
                    if key == "properties" and isinstance(value, dict):
                        try:
                            parsed = json.loads(value.get("sessionData", "{}"))
                            metadata = parsed if isinstance(parsed, dict) else {}
                        except (TypeError, json.JSONDecodeError):
                            metadata = {}
                separator = reader.peek()
                if separator == "}":
                    reader.expect("}")
                    break
                reader.expect(",")
    except (OSError, UnicodeError) as error:
        raise RuntimeError(f"Could not read the csTimer backup: {error}") from error
    return counts, metadata


def inspect_cstimer_import(job):
    job_id = job["id"]
    update_import_job(job_id, status="inspecting", error=None)
    inspected = 0

    def check_cancelled(_source_key, _raw_solve):
        nonlocal inspected
        inspected += 1
        if inspected % 500 == 0 and import_job_cancelled(job_id):
            raise InterruptedError

    try:
        counts, metadata = scan_cstimer_backup(job["source_path"], check_cancelled)
    except InterruptedError:
        return
    if import_job_cancelled(job_id):
        return

    ordered_keys = sorted(counts, key=lambda value: int(value.removeprefix("session")))
    if not ordered_keys:
        raise RuntimeError("No csTimer sessions were found in this backup.")

    rows = []
    for source_order, source_key in enumerate(ordered_keys):
        number = source_key.removeprefix("session")
        session_meta = metadata.get(number, {})
        if not isinstance(session_meta, dict):
            session_meta = {}
        phase_count = session_meta.get("opt", {}).get("phases")
        try:
            phase_count = int(phase_count) if phase_count is not None else None
        except (TypeError, ValueError):
            phase_count = None
        if phase_count is not None and phase_count < 2:
            phase_count = None
        rows.append((job_id, source_key, source_order, str(session_meta.get("name") or f"csTimer {source_key}"),
                     detect_cstimer_event(session_meta), phase_count, counts[source_key],))

    with import_db() as connection:
        connection.execute("DELETE FROM import_sessions WHERE job_id = ?", (job_id,))
        connection.executemany("""
            INSERT INTO import_sessions (
                job_id, source_key, source_order, default_name, default_event, phase_count, solve_count
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """, rows)
    update_import_job(job_id, status="awaiting_configuration", total_sessions=len(rows),
        total_solves=sum(counts.values()), processed_solves=0, )


def js_number_string(value):
    number = float(value or 0)
    if number.is_integer():
        return str(int(number))
    return format(number, ".15g")


def numeric_json_value(value):
    number = float(value)
    return int(number) if number.is_integer() else number


def convert_cstimer_solve(source_key, event, session_id, raw_solve, imported_at):
    if not isinstance(raw_solve, (list, tuple)) or not raw_solve or not isinstance(raw_solve[0], (list, tuple)):
        raise RuntimeError(f"{source_key} contains an invalid solve.")
    try:
        penalty_value = numeric_json_value(raw_solve[0][0] or 0)
        time_ms = numeric_json_value(raw_solve[0][1])
        timestamp_seconds = numeric_json_value(raw_solve[3] or 0)
    except (IndexError, TypeError, ValueError, OverflowError) as error:
        raise RuntimeError(f"{source_key} contains an invalid solve.") from error
    scramble = str(raw_solve[1] or "") if len(raw_solve) > 1 else ""
    comment = str(raw_solve[2] or "") if len(raw_solve) > 2 else ""
    fingerprint_source = "\x1f".join(
        ["cstimer", source_key, js_number_string(penalty_value), js_number_string(time_ms), scramble, comment,
            js_number_string(timestamp_seconds), ])
    fingerprint = hashlib.sha256(fingerprint_source.encode("utf-8")).hexdigest()
    timestamp_ms = numeric_json_value(float(timestamp_seconds) * 1000)
    solve = {
        "id": f"cstimer:{fingerprint}",
        "sessionId": session_id,
        "event": event,
        "timeMs": time_ms,
        "scramble": scramble,
        "comment": comment,
        "createdAt": timestamp_ms,
        "updatedAt": timestamp_ms,
        "penalty": "DNF" if penalty_value < 0 else "+2" if penalty_value > 0 else "OK",
        "source": {
            "provider": "cstimer",
            "sessionKey": source_key,
            "fingerprint": fingerprint,
            "importedAt": imported_at,
        },
    }
    raw_cumulative_splits = raw_solve[0][2:]
    if raw_cumulative_splits:
        try:
            cumulative_splits = [numeric_json_value(value) for value in raw_cumulative_splits]
        except (TypeError, ValueError, OverflowError) as error:
            raise RuntimeError(f"{source_key} contains an invalid split time.") from error
        boundaries = [time_ms, *cumulative_splits, 0]
        if any(value < 0 for value in boundaries) or any(
                boundaries[index] < boundaries[index + 1] for index in range(len(boundaries) - 1)):
            raise RuntimeError(f"{source_key} contains split times outside the solve duration.")
        solve["phaseTimesMs"] = [numeric_json_value(boundaries[index] - boundaries[index + 1]) for index in
            range(len(boundaries) - 2, -1, -1)]
        solve["source"]["cstimerCumulativeSplitsMs"] = cumulative_splits
    return solve


def stage_cstimer_solves(job, configuration):
    job_id = job["id"]
    source_path = Path(job["source_path"])
    imported_at = int(time.time() * 1000)
    processed = 0
    selected_by_key = {selected["key"]: selected for selected in configuration if selected["action"] != "skip"}
    batch = []
    with import_db() as connection:
        connection.execute("DELETE FROM import_solves WHERE job_id = ?", (job_id,))

    def stage_solve(source_key, raw_solve):
        nonlocal processed
        if processed % 500 == 0 and import_job_cancelled(job_id):
            raise InterruptedError
        processed += 1
        selected = selected_by_key.get(source_key)
        if selected:
            solve = convert_cstimer_solve(source_key, selected["event"], selected["sessionId"], raw_solve,
                imported_at, )
            batch.append((job_id, solve["id"], json.dumps(solve, separators=(",", ":"))))
        if len(batch) >= IMPORT_BATCH_SIZE:
            with import_db() as connection:
                connection.executemany(
                    "INSERT OR IGNORE INTO import_solves (job_id, solve_id, payload_json) VALUES (?, ?, ?)", batch, )
            update_import_job(job_id, processed_solves=processed)
            batch.clear()

    try:
        scan_cstimer_backup(source_path, stage_solve)
    except InterruptedError:
        return
    if batch:
        with import_db() as connection:
            connection.executemany(
                "INSERT OR IGNORE INTO import_solves (job_id, solve_id, payload_json) VALUES (?, ?, ?)", batch, )
    update_import_job(job_id, processed_solves=processed)


def build_import_snapshot(job, configuration):
    remote = read_drive_snapshot(job["google_sub"])
    existing_solves = {solve.get("id"): solve for solve in remote.get("solves", []) if solve.get("id")}
    existing_session_ids = {session.get("id") for session in remote.get("sessions", []) if session.get("id")}
    missing_destinations = [selected["name"] for selected in configuration if
        selected["action"] == "merge" and selected["sessionId"] not in existing_session_ids]
    if missing_destinations:
        raise RuntimeError(
            f"The destination for {missing_destinations[0]} is not present in Google Drive. Sync it first, then retry.")
    added_by_session = {}
    phase_counts_by_session = {selected["sessionId"]: selected["phaseCount"] for selected in configuration if
        selected.get("phaseCount") and selected["action"] != "skip"}
    duplicates = 0
    enriched = 0
    offset = 0
    while True:
        with import_db() as connection:
            rows = connection.execute("""
                SELECT solve_id, payload_json
                FROM import_solves
                WHERE job_id = ?
                ORDER BY solve_id
                LIMIT ? OFFSET ?
            """, (job["id"], IMPORT_BATCH_SIZE, offset)).fetchall()
        if not rows:
            break
        for row in rows:
            solve = json.loads(row["payload_json"])
            existing = existing_solves.get(row["solve_id"])
            if existing:
                if solve.get("phaseTimesMs") and not existing.get("phaseTimesMs"):
                    existing["phaseTimesMs"] = solve["phaseTimesMs"]
                    existing.setdefault("source", {}).update({
                        "cstimerCumulativeSplitsMs": solve["source"]["cstimerCumulativeSplitsMs"],
                    })
                    staged_phase_count = phase_counts_by_session.get(solve.get("sessionId"))
                    if staged_phase_count and existing.get("sessionId"):
                        phase_counts_by_session[existing["sessionId"]] = staged_phase_count
                    enriched += 1
                duplicates += 1
                continue
            existing_solves[row["solve_id"]] = solve
            remote.setdefault("solves", []).append(solve)
            session_id = solve.get("sessionId")
            added_by_session[session_id] = added_by_session.get(session_id, 0) + 1
        offset += len(rows)

    existing_sessions = existing_session_ids
    created = 0
    now = int(time.time() * 1000)
    for session in remote.get("sessions", []):
        phase_count = phase_counts_by_session.get(session.get("id"))
        if phase_count and not session.get("phaseCount"):
            session["phaseCount"] = phase_count
            session["updatedAt"] = now
    for selected in configuration:
        if selected["action"] != "create" or not added_by_session.get(selected["sessionId"]):
            continue
        if selected["sessionId"] not in existing_sessions:
            remote.setdefault("sessions", []).append({
                "id": selected["sessionId"],
                "name": selected["name"] or f"{EVENT_LABELS.get(selected['event'], selected['event'])} import",
                "event": selected["event"],
                "createdAt": now,
                "updatedAt": now, **({
                                         "phaseCount": selected["phaseCount"]
                                     } if selected.get("phaseCount") else {}),
            })
            existing_sessions.add(selected["sessionId"])
            created += 1
    remote["schemaVersion"] = 2
    remote["updatedAt"] = now
    output_path = IMPORT_DIR / f"{job['id']}.snapshot.json"
    with output_path.open("w", encoding="utf-8") as output:
        json.dump(remote, output, separators=(",", ":"))
    return output_path, {
        "created": created,
        "added": sum(added_by_session.values()),
        "duplicates": duplicates,
        "enriched": enriched,
    }


def open_drive_upload(request, timeout=60):
    try:
        return urlopen(request, timeout=timeout)
    except HTTPError as error:
        if error.code == 308:
            return error
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Drive upload failed ({error.code}): {body}") from error
    except URLError as error:
        raise RuntimeError(f"Drive upload failed: {error.reason}") from error


def start_resumable_drive_upload(subject, file_size):
    file_id = find_drive_snapshot(subject)
    access_token = refresh_access_token(subject)
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "application/json",
        "X-Upload-Content-Length": str(file_size),
    }
    if file_id:
        request = UrlRequest(f"https://www.googleapis.com/upload/drive/v3/files/{file_id}?uploadType=resumable",
            data=b"", method="PATCH", headers=headers, )
    else:
        request = UrlRequest("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable", data=json.dumps({
                                                                                                                          "name": DRIVE_FILENAME,
                                                                                                                          "parents": [
                                                                                                                              "appDataFolder"]
                                                                                                                      }).encode(
            "utf-8"), method="POST", headers=headers, )
    with open_drive_upload(request) as response:
        upload_uri = response.headers.get("Location")
    if not upload_uri:
        raise RuntimeError("Drive did not return a resumable upload URL.")
    return upload_uri


def upload_snapshot_resumable(job, output_path):
    job_id = job["id"]
    total = output_path.stat().st_size
    upload_uri = job["drive_upload_uri"]
    offset = min(int(job["drive_upload_offset"] or 0), total)
    if not upload_uri:
        upload_uri = start_resumable_drive_upload(job["google_sub"], total)
        offset = 0
        update_import_job(job_id, drive_upload_uri=upload_uri, drive_upload_offset=0, upload_total_bytes=total,
            upload_sent_bytes=0, )

    access_token = refresh_access_token(job["google_sub"])
    with output_path.open("rb") as source:
        source.seek(offset)
        while offset < total:
            if import_job_cancelled(job_id):
                return
            chunk = source.read(min(DRIVE_UPLOAD_CHUNK_BYTES, total - offset))
            end = offset + len(chunk) - 1
            request = UrlRequest(upload_uri, data=chunk, method="PUT", headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Length": str(len(chunk)),
                "Content-Range": f"bytes {offset}-{end}/{total}",
                "Content-Type": "application/json",
            })
            response = None
            for attempt in range(5):
                try:
                    response = open_drive_upload(request, timeout=120)
                    break
                except RuntimeError:
                    if attempt == 4:
                        raise
                    time.sleep(2 ** attempt)
            status = getattr(response, "status", getattr(response, "code", 0))
            if status not in {200, 201, 308}:
                raise RuntimeError(f"Drive upload returned unexpected status {status}.")
            response.close()
            offset = end + 1
            update_import_job(job_id, drive_upload_offset=offset, upload_sent_bytes=offset, upload_total_bytes=total, )


def process_import_job(job):
    job_id = job["id"]
    try:
        if job["status"] == "uploaded":
            inspect_cstimer_import(job)
            return
        resumable_output = Path(job["output_path"]) if job["output_path"] else None
        if job["drive_upload_uri"] and resumable_output and resumable_output.exists():
            with drive_subject_lock(job["google_sub"]):
                update_import_job(job_id, status="drive_uploading")
                upload_snapshot_resumable(get_import_job(job_id), resumable_output)
            if not import_job_cancelled(job_id):
                update_import_job(job_id, status="completed", error=None)
            return
        configuration = json.loads(job["configuration_json"] or "[]")
        if not configuration:
            raise RuntimeError("Import configuration is missing.")
        update_import_job(job_id, status="parsing", error=None, processed_solves=0)
        stage_cstimer_solves(job, configuration)
        if import_job_cancelled(job_id):
            return
        with drive_subject_lock(job["google_sub"]):
            update_import_job(job_id, status="merging")
            output_path, result = build_import_snapshot(job, configuration)
            if import_job_cancelled(job_id):
                return
            update_import_job(job_id, status="drive_uploading", output_path=str(output_path),
                result_json=json.dumps(result, separators=(",", ":")), )
            upload_snapshot_resumable(get_import_job(job_id), output_path)
        if import_job_cancelled(job_id):
            return
        update_import_job(job_id, status="completed", error=None, )
    except Exception as error:
        update_import_job(job_id, status="failed", error=str(error) or error.__class__.__name__)


def import_worker():
    while not IMPORT_WORKER_STOP.is_set():
        with import_db() as connection:
            connection.execute("BEGIN IMMEDIATE")
            job = connection.execute("""
                SELECT *
                FROM import_jobs
                WHERE status IN ('uploaded', 'queued')
                ORDER BY created_at
                LIMIT 1
            """).fetchone()
            if job:
                claimed_status = "inspecting" if job["status"] == "uploaded" else "parsing"
                connection.execute("UPDATE import_jobs SET status = ?, updated_at = ? WHERE id = ?",
                    (claimed_status, int(time.time() * 1000), job["id"]), )
        if job:
            process_import_job(job)
            continue
        IMPORT_WORKER_EVENT.wait(5)
        IMPORT_WORKER_EVENT.clear()


def start_import_worker():
    global IMPORT_WORKER_THREAD
    require_import_storage()
    initialize_import_storage()
    if IMPORT_WORKER_THREAD and IMPORT_WORKER_THREAD.is_alive():
        return
    IMPORT_WORKER_STOP.clear()
    IMPORT_WORKER_THREAD = threading.Thread(target=import_worker, name="cstimer-import-worker", daemon=True)
    IMPORT_WORKER_THREAD.start()
    IMPORT_WORKER_EVENT.set()


def serialize_import_job(job):
    with import_db() as connection:
        sessions = connection.execute("""
            SELECT source_key, default_name, default_event, phase_count, solve_count
            FROM import_sessions
            WHERE job_id = ?
            ORDER BY source_order
        """, (job["id"],)).fetchall()
    return {
        "id": job["id"],
        "status": job["status"],
        "fileName": job["file_name"],
        "fileSize": job["file_size"],
        "totalSessions": job["total_sessions"],
        "totalSolves": job["total_solves"],
        "processedSolves": job["processed_solves"],
        "uploadTotalBytes": job["upload_total_bytes"],
        "uploadSentBytes": job["upload_sent_bytes"],
        "error": job["error"],
        "result": json.loads(job["result_json"]) if job["result_json"] else None,
        "sessions": [{
            "key": row["source_key"],
            "name": row["default_name"],
            "event": row["default_event"],
            "phaseCount": row["phase_count"],
            "solveCount": row["solve_count"],
        } for row in sessions],
        "createdAt": job["created_at"],
        "updatedAt": job["updated_at"],
    }


def create_sync_transfer(subject, direction, metadata, solves, mode="newest"):
    transfer_id = secrets.token_hex(16)
    now = int(time.time() * 1000)
    metadata = {key: value for key, value in metadata.items() if key != "solves"}
    with import_db() as connection:
        connection.execute("""
            INSERT INTO sync_transfers (
                id, google_sub, direction, status, mode, metadata_json,
                total_solves, received_solves, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (transfer_id, subject, direction, "ready" if direction == "download" else "receiving", mode,
              json.dumps(metadata, separators=(",", ":")), len(solves), len(solves) if direction == "download" else 0,
              now, now,))
        if direction == "download":
            connection.executemany("""
                INSERT INTO sync_transfer_solves (transfer_id, solve_index, payload_json)
                VALUES (?, ?, ?)
            """, ((transfer_id, index, json.dumps(solve, separators=(",", ":"))) for index, solve in enumerate(solves)))
    return {
        "transferId": transfer_id,
        "totalSolves": len(solves),
    }


def create_sync_download(subject, snapshot=None):
    if snapshot is None:
        with drive_subject_lock(subject):
            snapshot = read_drive_snapshot(subject)
    return create_sync_transfer(subject, "download", snapshot, snapshot.get("solves", []), )


def get_sync_transfer(transfer_id, subject, direction=None):
    query = "SELECT * FROM sync_transfers WHERE id = ? AND google_sub = ?"
    parameters = [transfer_id, subject]
    if direction:
        query += " AND direction = ?"
        parameters.append(direction)
    with import_db() as connection:
        return connection.execute(query, parameters).fetchone()


def read_sync_download_chunk(transfer, offset):
    total = transfer["total_solves"]
    offset = max(0, min(int(offset), total))
    with import_db() as connection:
        rows = connection.execute("""
            SELECT solve_index, payload_json
            FROM sync_transfer_solves
            WHERE transfer_id = ? AND solve_index >= ?
            ORDER BY solve_index
            LIMIT 500
        """, (transfer["id"], offset)).fetchall()
    solves = []
    encoded_bytes = 32
    next_offset = offset
    for row in rows:
        solve_bytes = len(row["payload_json"].encode("utf-8")) + 1
        if solves and encoded_bytes + solve_bytes > SYNC_CHUNK_TARGET_BYTES:
            break
        solves.append(json.loads(row["payload_json"]))
        encoded_bytes += solve_bytes
        next_offset = row["solve_index"] + 1
    done = next_offset >= total
    return {
        "metadata": json.loads(transfer["metadata_json"]) if offset == 0 else None,
        "solves": solves,
        "nextOffset": next_offset,
        "totalSolves": total,
        "done": done,
    }


def append_sync_upload_chunk(transfer, offset, solves):
    if transfer["status"] != "receiving":
        raise ApiError("This sync upload is no longer accepting chunks.", 409)
    if not isinstance(offset, int) or offset < 0:
        raise ApiError("Sync chunk offset is invalid.")
    if not isinstance(solves, list) or not solves:
        raise ApiError("Sync chunk must contain solves.")
    if offset + len(solves) > transfer["total_solves"]:
        raise ApiError("Sync chunk exceeds the declared solve count.")
    now = int(time.time() * 1000)
    rows = [(transfer["id"], offset + index, json.dumps(solve, separators=(",", ":"))) for index, solve in
        enumerate(solves)]
    with import_db() as connection:
        connection.executemany("""
            INSERT INTO sync_transfer_solves (transfer_id, solve_index, payload_json)
            VALUES (?, ?, ?)
            ON CONFLICT(transfer_id, solve_index)
            DO UPDATE SET payload_json = excluded.payload_json
        """, rows)
        received = connection.execute("""
            SELECT COUNT(*) AS count
            FROM sync_transfer_solves
            WHERE transfer_id = ?
        """, (transfer["id"],)).fetchone()["count"]
        connection.execute("""
            UPDATE sync_transfers
            SET received_solves = ?, updated_at = ?
            WHERE id = ?
        """, (received, now, transfer["id"]))
    return {
        "receivedSolves": received,
        "totalSolves": transfer["total_solves"],
    }


def finalize_sync_upload(transfer):
    if transfer["status"] != "receiving":
        raise ApiError("This sync upload has already been finalized.", 409)
    with import_db() as connection:
        rows = connection.execute("""
            SELECT solve_index, payload_json
            FROM sync_transfer_solves
            WHERE transfer_id = ?
            ORDER BY solve_index
        """, (transfer["id"],)).fetchall()
    if len(rows) != transfer["total_solves"]:
        raise ApiError(f"Sync upload is incomplete ({len(rows)}/{transfer['total_solves']} solves received).", 409, )
    if rows and any(row["solve_index"] != index for index, row in enumerate(rows)):
        raise ApiError("Sync upload contains a missing chunk.", 409)
    incoming = json.loads(transfer["metadata_json"])
    incoming["solves"] = [json.loads(row["payload_json"]) for row in rows]
    with import_db() as connection:
        claimed = connection.execute("""
            UPDATE sync_transfers
            SET status = 'finalizing', updated_at = ?
            WHERE id = ? AND status = 'receiving'
        """, (int(time.time() * 1000), transfer["id"])).rowcount
    if not claimed:
        raise ApiError("This sync upload has already been finalized.", 409)
    try:
        merged = sync_drive_snapshot(transfer["google_sub"], incoming, transfer["mode"])
        descriptor = create_sync_download(transfer["google_sub"], merged)
    except Exception:
        with import_db() as connection:
            connection.execute("UPDATE sync_transfers SET status = 'receiving', updated_at = ? WHERE id = ?",
                (int(time.time() * 1000), transfer["id"]), )
        raise
    with import_db() as connection:
        connection.execute("UPDATE sync_transfers SET status = 'completed', updated_at = ? WHERE id = ?",
            (int(time.time() * 1000), transfer["id"]), )
        connection.execute("DELETE FROM sync_transfer_solves WHERE transfer_id = ?", (transfer["id"],), )
    return descriptor


class ApiError(Exception):
    def __init__(self, message, status_code=400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
app.mount("/logo", StaticFiles(directory=ROOT / "logo"), name="logo")
app.mount("/scramble", StaticFiles(directory=ROOT / "scramble"), name="scramble")


@app.on_event("startup")
async def startup_import_worker():
    if not IS_VERCEL:
        await run_in_threadpool(start_import_worker)


@app.on_event("shutdown")
async def shutdown_import_worker():
    IMPORT_WORKER_STOP.set()
    IMPORT_WORKER_EVENT.set()


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


@app.post("/api/imports")
async def create_import(request: Request):
    require_import_storage()
    session = await require_session(request)
    connected = await run_in_threadpool(get_user_tokens, session["sub"])
    if not connected:
        raise ApiError("Connect Google Drive before importing.", 409)
    await run_in_threadpool(start_import_worker)

    file_name = request.headers.get("x-file-name", "cstimer-backup.json").strip()[:255] or "cstimer-backup.json"
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > IMPORT_MAX_BYTES:
                raise ApiError("The import file exceeds the configured server limit.", 413)
        except ValueError as error:
            raise ApiError("Invalid Content-Length header.") from error

    job_id = secrets.token_hex(16)
    source_path = IMPORT_DIR / f"{job_id}.json"
    partial_path = IMPORT_DIR / f"{job_id}.part"
    now = int(time.time() * 1000)
    with import_db() as connection:
        connection.execute("""
            INSERT INTO import_jobs (
                id, google_sub, status, source_path, file_name, created_at, updated_at
            ) VALUES (?, ?, 'uploading', ?, ?, ?, ?)
        """, (job_id, session["sub"], str(source_path), file_name, now, now))

    size = 0
    try:
        with partial_path.open("wb") as output:
            async for chunk in request.stream():
                size += len(chunk)
                if size > IMPORT_MAX_BYTES:
                    raise ApiError("The import file exceeds the configured server limit.", 413)
                output.write(chunk)
        if size == 0:
            raise ApiError("The selected import file is empty.")
        partial_path.replace(source_path)
        update_import_job(job_id, status="uploaded", file_size=size)
        IMPORT_WORKER_EVENT.set()
        return serialize_import_job(get_import_job(job_id, session["sub"]))
    except Exception:
        partial_path.unlink(missing_ok=True)
        if get_import_job(job_id):
            update_import_job(job_id, status="failed", error="The upload did not complete.")
        raise


@app.get("/api/imports/active")
async def active_import(request: Request):
    require_import_storage()
    session = await require_session(request)
    await run_in_threadpool(start_import_worker)
    with import_db() as connection:
        job = connection.execute("""
            SELECT *
            FROM import_jobs
            WHERE google_sub = ?
              AND status NOT IN ('completed', 'failed', 'cancelled')
            ORDER BY updated_at DESC
            LIMIT 1
        """, (session["sub"],)).fetchone()
    return serialize_import_job(job) if job else {
        "job": None
    }


@app.get("/api/imports/{job_id}")
async def import_status(job_id: str, request: Request):
    require_import_storage()
    session = await require_session(request)
    job = await run_in_threadpool(get_import_job, job_id, session["sub"])
    if not job:
        raise ApiError("Import job not found.", 404)
    return await run_in_threadpool(serialize_import_job, job)


@app.post("/api/imports/{job_id}/start")
async def configure_import(job_id: str, request: Request):
    require_import_storage()
    session = await require_session(request)
    job = await run_in_threadpool(get_import_job, job_id, session["sub"])
    if not job:
        raise ApiError("Import job not found.", 404)
    if job["status"] != "awaiting_configuration":
        raise ApiError("This import is not waiting for configuration.", 409)
    payload = await read_json_body(request)
    requested = payload.get("sessions")
    if not isinstance(requested, list):
        raise ApiError("Import sessions are required.")

    with import_db() as connection:
        available_rows = connection.execute("""
            SELECT source_key, default_name, default_event, phase_count
            FROM import_sessions
            WHERE job_id = ?
        """, (job_id,)).fetchall()
    available = {row["source_key"]: row for row in available_rows}
    configured = []
    seen = set()
    for item in requested:
        if not isinstance(item, dict) or item.get("key") not in available or item["key"] in seen:
            raise ApiError("Import configuration contains an unknown or duplicate session.")
        seen.add(item["key"])
        action = item.get("action", "create")
        if action not in {"create", "merge", "skip"}:
            raise ApiError("Import configuration contains an invalid action.")
        event = item.get("event") or available[item["key"]]["default_event"]
        if event not in EVENT_LABELS:
            raise ApiError("Import configuration contains an unsupported cube type.")
        destination = str(item.get("destination") or "").strip()
        if action == "merge" and not destination:
            raise ApiError(f"Choose a destination for {item['key']}.")
        configured.append({
            "key": item["key"],
            "name": str(item.get("name") or available[item["key"]]["default_name"]).strip()[:60],
            "event": event,
            "action": action,
            "sessionId": destination if action == "merge" else secrets.token_hex(16),
            "phaseCount": available[item["key"]]["phase_count"],
        })
    for source_key, row in available.items():
        if source_key not in seen:
            configured.append({
                "key": source_key,
                "name": row["default_name"],
                "event": row["default_event"],
                "action": "skip",
                "sessionId": secrets.token_hex(16),
                "phaseCount": row["phase_count"],
            })

    update_import_job(job_id, status="queued", configuration_json=json.dumps(configured, separators=(",", ":")),
        processed_solves=0, drive_upload_uri=None, drive_upload_offset=0, upload_total_bytes=0, upload_sent_bytes=0,
        error=None, )
    IMPORT_WORKER_EVENT.set()
    return serialize_import_job(get_import_job(job_id, session["sub"]))


@app.delete("/api/imports/{job_id}")
async def cancel_import(job_id: str, request: Request):
    require_import_storage()
    session = await require_session(request)
    job = await run_in_threadpool(get_import_job, job_id, session["sub"])
    if not job:
        raise ApiError("Import job not found.", 404)
    if job["status"] not in {"completed", "failed", "cancelled"}:
        update_import_job(job_id, status="cancelled")
    return {
        "status": "cancelled"
    }


@app.post("/api/sync/downloads")
async def start_sync_download(request: Request):
    require_sync_transfer_storage()
    session = await require_session(request)
    await run_in_threadpool(initialize_import_storage, False)
    try:
        return await run_in_threadpool(create_sync_download, session["sub"])
    except RuntimeError as error:
        raise ApiError(str(error)) from error


@app.get("/api/sync/downloads/{transfer_id}")
async def sync_download_chunk(transfer_id: str, request: Request, offset: int = 0):
    require_sync_transfer_storage()
    session = await require_session(request)
    transfer = await run_in_threadpool(get_sync_transfer, transfer_id, session["sub"], "download")
    if not transfer:
        raise ApiError("Sync download not found or expired.", 404)
    return await run_in_threadpool(read_sync_download_chunk, transfer, offset)


@app.post("/api/sync/uploads")
async def start_sync_upload(request: Request):
    require_sync_transfer_storage()
    session = await require_session(request)
    await run_in_threadpool(initialize_import_storage, False)
    payload = await read_json_body(request)
    metadata = payload.get("metadata")
    total_solves = payload.get("totalSolves")
    mode = payload.get("mode", "newest")
    if not isinstance(metadata, dict):
        raise ApiError("Sync metadata is required.")
    if not isinstance(total_solves, int) or total_solves < 0 or total_solves > 10_000_000:
        raise ApiError("Sync solve count is invalid.")
    if mode not in {"newest", "local", "drive"}:
        mode = "newest"
    descriptor = await run_in_threadpool(create_sync_transfer, session["sub"], "upload", metadata, range(total_solves),
        mode, )
    return descriptor


@app.post("/api/sync/uploads/{transfer_id}/chunks")
async def sync_upload_chunk(transfer_id: str, request: Request):
    require_sync_transfer_storage()
    session = await require_session(request)
    transfer = await run_in_threadpool(get_sync_transfer, transfer_id, session["sub"], "upload")
    if not transfer:
        raise ApiError("Sync upload not found or expired.", 404)
    payload = await read_json_body(request)
    return await run_in_threadpool(append_sync_upload_chunk, transfer, payload.get("offset"), payload.get("solves"), )


@app.post("/api/sync/uploads/{transfer_id}/complete")
async def complete_sync_upload(transfer_id: str, request: Request):
    require_sync_transfer_storage()
    session = await require_session(request)
    transfer = await run_in_threadpool(get_sync_transfer, transfer_id, session["sub"], "upload")
    if not transfer:
        raise ApiError("Sync upload not found or expired.", 404)
    try:
        return await run_in_threadpool(finalize_sync_upload, transfer)
    except RuntimeError as error:
        raise ApiError(str(error)) from error


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
        return await run_in_threadpool(sync_drive_snapshot, session["sub"], incoming, mode)
    except RuntimeError as error:
        raise ApiError(str(error)) from error


def main():
    uvicorn.run("server:app", host="127.0.0.1", port=8000, reload=False)


if __name__ == "__main__":
    main()