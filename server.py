import hashlib
import json
import os
import secrets
import threading
import time
from email.utils import formatdate
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, quote, urlencode, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
LOCAL_DIR = ROOT / ".local"
TOKENS_FILE = LOCAL_DIR / "google_tokens.json"
SESSIONS_FILE = LOCAL_DIR / "sessions.json"
DRIVE_FILENAME = "cubing-assistant-data.json"
SESSION_COOKIE = "cubing_assistant_session"
SESSION_FILE_VERSION = 2
SESSION_LOCK = threading.RLock()


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


def session_storage_key(session_id):
    return hashlib.sha256(session_id.encode("utf-8")).hexdigest()


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
    request = Request(url, data=data, method=method, headers=request_headers)
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
    request = Request(f"https://www.googleapis.com/drive/v3/files/{file_id}?alt=media", headers={
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
        request = Request(f"https://www.googleapis.com/upload/drive/v3/files/{file_id}?uploadType=media", data=content,
            method="PATCH", headers={
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
        request = Request("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", data=content,
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
        if not current:
            merged_solves[solve_id] = solve
        else:
            merged_solves[solve_id] = choose_record(current, solve, mode)

    sessions = {}
    for session in [*left.get("sessions", []), *right.get("sessions", [])]:
        session_id = session.get("id")
        if not session_id:
            continue
        current = sessions.get(session_id)
        if not current:
            sessions[session_id] = session
        else:
            sessions[session_id] = choose_record(current, session, mode)

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


class CubingAssistantHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        renewed_session_id = getattr(self, "_renewed_session_id", None)
        if renewed_session_id:
            self.send_header("Set-Cookie", self.build_session_cookie(renewed_session_id))
            self._renewed_session_id = None
        super().end_headers()

    def request_is_https(self):
        if SESSION_COOKIE_SECURE in {"1", "true", "yes", "on"}:
            return True
        if SESSION_COOKIE_SECURE in {"0", "false", "no", "off"}:
            return False
        forwarded_proto = self.headers.get("X-Forwarded-Proto", "").split(",", 1)[0].strip().lower()
        return forwarded_proto == "https"

    def build_session_cookie(self, session_id, max_age=SESSION_TTL_SECONDS):
        parts = [f"{SESSION_COOKIE}={session_id}", "Path=/", "HttpOnly", "SameSite=Lax", f"Max-Age={max_age}",
            f"Expires={formatdate(time.time() + max_age, usegmt=True)}", ]
        if self.request_is_https():
            parts.append("Secure")
        return "; ".join(parts)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/config":
            return self.send_json({
                "googleClientId": GOOGLE_CLIENT_ID
            })
        if path == "/api/auth/status":
            return self.handle_auth_status()
        if path == "/api/google/status":
            return self.handle_drive_status()
        if path == "/api/sync":
            return self.handle_sync_download()

        if path in {"/", "/timer", "/solve"}:
            self.path = "/static/index.html"
        elif path == "/analytics":
            self.path = "/static/analytics.html"
        elif path == "/manage":
            self.path = "/static/manage.html"
        elif path == "/appearance":
            self.path = "/static/appearance.html"
        elif path == "/login":
            self.path = "/static/login.html"
        super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/auth/google":
            return self.handle_google_login()
        if path == "/api/auth/logout":
            return self.handle_logout()
        if path == "/api/google/code":
            return self.handle_drive_code()
        if path == "/api/google/disconnect":
            return self.handle_drive_disconnect()
        if path == "/api/sync":
            return self.handle_sync_upload()
        self.send_error(404)

    def send_json(self, payload, status=200, headers=None):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 2_000_000:
            raise ValueError("Request body is too large.")
        body = self.rfile.read(length).decode("utf-8")
        return json.loads(body or "{}")

    def get_session(self):
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        morsel = cookie.get(SESSION_COOKIE)
        session_id = morsel.value if morsel else None
        session, renewed = lookup_session(session_id)
        if renewed:
            self._renewed_session_id = session_id
        return session

    def require_session(self):
        session = self.get_session()
        if not session:
            self.send_json({
                "error": "Sign in with Google first."
            }, 401)
        return session

    def handle_google_login(self):
        try:
            credential = self.read_json_body()["credential"]
            query = urlencode({
                "id_token": credential
            })
            profile = google_json(f"https://oauth2.googleapis.com/tokeninfo?{query}")
            if profile.get("aud") != GOOGLE_CLIENT_ID:
                raise RuntimeError("Google token audience did not match this app.")

            cookie = SimpleCookie(self.headers.get("Cookie", ""))
            existing_session = cookie.get(SESSION_COOKIE)
            if existing_session:
                delete_session(existing_session.value)
            session_id, session = create_session(profile)
            self.send_json({
                **session,
                "driveConnected": bool(get_user_tokens(session["sub"]))
            }, headers={
                "Set-Cookie": self.build_session_cookie(session_id)
            }, )
        except (KeyError, RuntimeError, ValueError, json.JSONDecodeError) as error:
            self.send_json({
                "error": str(error)
            }, 400)

    def handle_auth_status(self):
        session = self.get_session()
        if not session:
            return self.send_json({
                "signedIn": False
            })
        self.send_json({
            "signedIn": True, **session,
            "driveConnected": bool(get_user_tokens(session["sub"]))
        })

    def handle_logout(self):
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        morsel = cookie.get(SESSION_COOKIE)
        if morsel:
            delete_session(morsel.value)
        self.send_json({
            "ok": True
        }, headers={
            "Set-Cookie": self.build_session_cookie("", max_age=0)
        }, )

    def handle_drive_code(self):
        session = self.require_session()
        if not session:
            return
        try:
            code = self.read_json_body()["code"]
            token_response = google_form("https://oauth2.googleapis.com/token", {
                "client_id": GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "code": code,
                "grant_type": "authorization_code",
                "redirect_uri": self.headers.get("Origin", f"http://localhost:{self.server.server_port}"),
            }, )
            store_user_tokens(session["sub"], token_response)
            self.send_json({
                "connected": True
            })
        except (KeyError, RuntimeError, ValueError, json.JSONDecodeError) as error:
            self.send_json({
                "error": str(error)
            }, 400)

    def handle_drive_status(self):
        session = self.require_session()
        if not session:
            return
        self.send_json({
            "connected": bool(get_user_tokens(session["sub"]))
        })

    def handle_drive_disconnect(self):
        session = self.require_session()
        if not session:
            return
        delete_user_tokens(session["sub"])
        self.send_json({
            "connected": False
        })

    def handle_sync_download(self):
        session = self.require_session()
        if not session:
            return
        try:
            self.send_json(read_drive_snapshot(session["sub"]))
        except RuntimeError as error:
            self.send_json({
                "error": str(error)
            }, 400)

    def handle_sync_upload(self):
        session = self.require_session()
        if not session:
            return
        try:
            mode = parse_qs(urlparse(self.path).query).get("mode", ["newest"])[0]
            if mode not in {"newest", "local", "drive"}:
                mode = "newest"
            incoming = self.read_json_body()
            remote = read_drive_snapshot(session["sub"])
            merged = merge_snapshots(remote, incoming, mode)
            write_drive_snapshot(session["sub"], merged)
            self.send_json(merged)
        except (RuntimeError, ValueError, json.JSONDecodeError) as error:
            self.send_json({
                "error": str(error)
            }, 400)


def main():
    host = "127.0.0.1"
    port = 8000
    server = ThreadingHTTPServer((host, port), CubingAssistantHandler)
    print(f"Serving cubing timer at http://localhost:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()