"""Event Mailer - local server.

Runs entirely on this computer using only the Python standard library.
Serves the web UI, stores your designs/settings in ./data, and sends emails
through your own SMTP account (e.g. Gmail + App Password).
"""

import base64
import csv
import html
import json
import mimetypes
import re
import smtplib
import ssl
import threading
import urllib.error
import urllib.request
import uuid
import webbrowser
from datetime import datetime
from email.message import EmailMessage
from email.utils import formataddr
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DATA = ROOT / "data"
CONFIG = DATA / "config.json"
TEMPLATE = DATA / "template.json"   # whole workspace: certificate design, email templates, event details
LOG = DATA / "send_log.csv"
ATTACH = DATA / "attachments"       # extra documents, stored once, referenced by id
HOST, PORT = "127.0.0.1", 8765

DEFAULT_CONFIG = {
    "smtp_host": "smtp.gmail.com",
    "smtp_port": 465,
    "email": "",
    "password": "",
    "from_name": "",
    "ollama_url": "http://localhost:11434",
    "ollama_model": "llama3.2",
    "ollama_key": "",
    "verified": False,
}

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG.exists():
        cfg.update(json.loads(CONFIG.read_text(encoding="utf-8")))
    return cfg


def save_config(cfg):
    DATA.mkdir(exist_ok=True)
    CONFIG.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


class Mailer:
    """Keeps one SMTP connection open across sends and reconnects if it drops."""

    def __init__(self):
        self.lock = threading.Lock()
        self.conn = None
        self.key = None

    @staticmethod
    def connect(cfg):
        port = int(cfg["smtp_port"])
        ctx = ssl.create_default_context()
        if port == 465:
            s = smtplib.SMTP_SSL(cfg["smtp_host"], port, context=ctx, timeout=60)
        else:
            s = smtplib.SMTP(cfg["smtp_host"], port, timeout=60)
            s.starttls(context=ctx)
        s.login(cfg["email"], cfg["password"].replace(" ", ""))
        return s

    def close(self):
        if self.conn:
            try:
                self.conn.quit()
            except Exception:
                pass
        self.conn = None

    def send(self, cfg, msg):
        key = (cfg["smtp_host"], cfg["smtp_port"], cfg["email"], cfg["password"])
        with self.lock:
            for attempt in range(2):
                try:
                    if self.conn is None or self.key != key:
                        self.close()
                        self.conn = self.connect(cfg)
                        self.key = key
                    self.conn.send_message(msg)
                    return
                except (smtplib.SMTPServerDisconnected, ConnectionError, TimeoutError):
                    self.close()
                    if attempt:
                        raise


mailer = Mailer()
log_lock = threading.Lock()


# ---------- extra documents (sent with every email of a template) ----------

def list_attachments():
    if not ATTACH.exists():
        return []
    out = []
    for f in sorted(ATTACH.iterdir()):
        if f.is_file() and "__" in f.name:
            aid, name = f.name.split("__", 1)
            out.append({"id": aid, "filename": name, "size": f.stat().st_size,
                        "mime": mimetypes.guess_type(name)[0] or "application/octet-stream"})
    return out


def find_attachment(aid):
    if not ATTACH.exists() or not re.fullmatch(r"[0-9a-f]{12}", aid or ""):
        return None
    return next(iter(ATTACH.glob(aid + "__*")), None)


def save_attachment(filename, data):
    ATTACH.mkdir(parents=True, exist_ok=True)
    name = re.sub(r'[\\/:*?"<>|\r\n]+', "_", Path(filename).name).strip() or "file"
    aid = uuid.uuid4().hex[:12]
    (ATTACH / f"{aid}__{name}").write_bytes(data)
    return next(a for a in list_attachments() if a["id"] == aid)


# ---------- email building ----------

def wrap_html(fragment):
    return ('<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#222">'
            + fragment + "</div>")


def add_file(msg, data, filename, mime=None):
    mime = mime or mimetypes.guess_type(filename)[0] or "application/octet-stream"
    maintype, subtype = mime.split("/", 1)
    msg.add_attachment(data, maintype=maintype, subtype=subtype, filename=filename)


def build_message(cfg, p):
    """p = {to, subject, text, html, certificate?: {filename, mime, data(b64)}, attachments?: [ids]}"""
    msg = EmailMessage()
    msg["Subject"] = p["subject"]
    msg["From"] = formataddr((cfg.get("from_name") or "", cfg["email"]))
    msg["To"] = p["to"]
    text = p.get("text") or ""
    msg.set_content(text)
    msg.add_alternative(wrap_html(p.get("html") or html.escape(text).replace("\n", "<br>")), subtype="html")
    cert = p.get("certificate")
    if cert:
        add_file(msg, base64.b64decode(cert["data"]), cert["filename"], cert["mime"])
    for aid in p.get("attachments") or []:
        f = find_attachment(aid)
        if not f:
            raise FileNotFoundError("An attached document is missing. Remove it and add it again.")
        add_file(msg, f.read_bytes(), f.name.split("__", 1)[1])
    return msg


def write_log(p, status, error=""):
    DATA.mkdir(exist_ok=True)
    with log_lock:
        new = not LOG.exists()
        with LOG.open("a", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            if new:
                w.writerow(["timestamp", "email", "name", "subject", "attachment", "test", "status", "error", "template"])
            w.writerow([
                datetime.now().isoformat(timespec="seconds"), p.get("to", ""), p.get("name", ""),
                p.get("subject", ""), (p.get("certificate") or {}).get("filename", ""),
                "yes" if p.get("test") else "", status, error, p.get("template", ""),
            ])


def upgrade_log():
    """Older logs had no 'template' column; add it so per-template skipping works."""
    if not LOG.exists():
        return
    with LOG.open(encoding="utf-8") as f:
        rows = list(csv.reader(f))
    if rows and "template" not in rows[0]:
        rows[0].append("template")
        with LOG.open("w", newline="", encoding="utf-8") as f:
            csv.writer(f).writerows([r + [""] * (len(rows[0]) - len(r)) for r in rows])


def sent_on(date, template=""):
    """Emails already sent on a date (optionally only for one template)."""
    if not LOG.exists():
        return []
    with LOG.open(encoding="utf-8") as f:
        return sorted({
            r["email"].lower() for r in csv.DictReader(f)
            if r["status"] == "sent" and not r["test"] and r["timestamp"].startswith(date)
            and (not template or r.get("template", "") == template)
        })


# ---------- optional Ollama helper ----------

def ollama_generate(cfg, prompt):
    url = cfg["ollama_url"].rstrip("/") + "/api/generate"
    headers = {"Content-Type": "application/json"}
    if cfg.get("ollama_key"):
        headers["Authorization"] = "Bearer " + cfg["ollama_key"]
    body = json.dumps({"model": cfg["ollama_model"], "prompt": prompt, "stream": False}).encode()
    with urllib.request.urlopen(urllib.request.Request(url, data=body, headers=headers), timeout=180) as r:
        return json.loads(r.read())["response"].strip()


def ollama_models(cfg):
    url = cfg["ollama_url"].rstrip("/") + "/api/tags"
    headers = {"Authorization": "Bearer " + cfg["ollama_key"]} if cfg.get("ollama_key") else {}
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=10) as r:
        return [m["name"] for m in json.loads(r.read()).get("models", [])]


def public_config(cfg):
    out = {k: v for k, v in cfg.items() if k not in ("password", "ollama_key")}
    out["has_password"] = bool(cfg.get("password"))
    out["has_ollama_key"] = bool(cfg.get("ollama_key"))
    return out


def friendly_error(e, cfg=None):
    if isinstance(e, smtplib.SMTPAuthenticationError):
        who = (cfg or {}).get("email") or "this account"
        return (f"Gmail rejected the login for {who}.\n"
                "Most common reasons:\n"
                f"• The App Password was created while signed in to a DIFFERENT Google account. "
                f"Open myaccount.google.com/apppasswords, check the picture at the top right shows {who}, "
                "create a NEW App Password there and paste it here.\n"
                "• You pasted your normal Gmail password instead of the 16-letter App Password.\n"
                "• The App Password was deleted, or you changed your Google password (that removes all App Passwords).")
    if isinstance(e, smtplib.SMTPRecipientsRefused):
        return "Recipient address was rejected: " + ", ".join(e.recipients)
    if isinstance(e, smtplib.SMTPDataError) and e.smtp_code in (550, 552, 554):
        return "Rejected by mail server (daily limit reached or attachments too big?): " + str(e.smtp_error)
    return str(e) or e.__class__.__name__


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code, payload, ctype="application/json"):
        data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass  # browser tab was closed or reloaded mid-request

    def read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        url = urlparse(self.path)
        path = url.path
        q = parse_qs(url.query)
        if path == "/api/config":
            return self.reply(200, public_config(load_config()))
        if path == "/api/template":
            return self.reply(200, TEMPLATE.read_bytes() if TEMPLATE.exists() else b"null")
        if path == "/api/sent":
            date = q.get("date", [datetime.now().strftime("%Y-%m-%d")])[0]
            return self.reply(200, sent_on(date, q.get("template", [""])[0]))
        if path == "/api/attachments":
            return self.reply(200, list_attachments())
        if path == "/api/ollama/models":
            try:
                return self.reply(200, {"models": ollama_models(load_config())})
            except Exception as e:
                return self.reply(502, {"error": f"Could not reach Ollama: {e}"})
        if path == "/":
            path = "/index.html"
        file = (STATIC / path.lstrip("/")).resolve()
        if STATIC in file.parents and file.is_file():
            return self.reply(200, file.read_bytes(), MIME.get(file.suffix, "application/octet-stream"))
        self.reply(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            p = self.read_json()
        except Exception:
            return self.reply(400, {"error": "Invalid JSON"})

        if path == "/api/config":
            cfg = load_config()
            before = (cfg["email"], cfg["password"], cfg["smtp_host"], cfg["smtp_port"])
            for k in DEFAULT_CONFIG:
                if k == "verified":
                    continue
                if k in ("password", "ollama_key"):
                    if p.get(k):  # blank means "keep the saved one"
                        cfg[k] = p[k].strip()
                elif k in p:
                    cfg[k] = p[k]
            if (cfg["email"], cfg["password"], cfg["smtp_host"], cfg["smtp_port"]) != before:
                cfg["verified"] = False
            save_config(cfg)
            mailer.close()
            return self.reply(200, public_config(cfg))

        if path == "/api/verify":
            cfg = load_config()
            try:
                Mailer.connect(cfg).quit()
            except Exception as e:
                cfg["verified"] = False
                save_config(cfg)
                return self.reply(400, {"error": friendly_error(e, cfg)})
            cfg["verified"] = True
            save_config(cfg)
            return self.reply(200, {"ok": True})

        if path == "/api/logout":
            cfg = load_config()
            cfg.update(password="", verified=False)
            save_config(cfg)
            mailer.close()
            return self.reply(200, public_config(cfg))

        if path == "/api/template":
            DATA.mkdir(exist_ok=True)
            TEMPLATE.write_text(json.dumps(p), encoding="utf-8")
            return self.reply(200, {"ok": True})

        if path == "/api/attachments":
            try:
                return self.reply(200, save_attachment(p["filename"], base64.b64decode(p["data"])))
            except Exception as e:
                return self.reply(400, {"error": f"Could not save file: {e}"})

        if path == "/api/attachments/delete":
            f = find_attachment(p.get("id"))
            if f:
                f.unlink()
            return self.reply(200, {"ok": True})

        if path == "/api/send":
            cfg = load_config()
            if not cfg["email"] or not cfg["password"]:
                return self.reply(400, {"error": "Email account not set up yet (step 1)."})
            try:
                mailer.send(cfg, build_message(cfg, p))
            except Exception as e:
                err = friendly_error(e, cfg)
                write_log(p, "failed", err)
                return self.reply(500, {"error": err})
            write_log(p, "sent")
            return self.reply(200, {"ok": True})

        if path == "/api/ollama/generate":
            try:
                return self.reply(200, {"text": ollama_generate(load_config(), p["prompt"])})
            except urllib.error.HTTPError as e:
                return self.reply(502, {"error": f"Ollama error {e.code}: {e.read().decode(errors='ignore')[:300]}"})
            except Exception as e:
                return self.reply(502, {"error": f"Could not reach Ollama: {e}"})

        self.reply(404, {"error": "not found"})


if __name__ == "__main__":
    DATA.mkdir(exist_ok=True)
    upgrade_log()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    url = f"http://{HOST}:{PORT}"
    print(f"Event Mailer running at {url}  (close this window to stop)")
    threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    server.serve_forever()
