#!/usr/bin/env python3
"""arthur-agent — companion agent for the arthur Obsidian plugin.

Single-file Python 3 stdlib HTTP server (zero pip deps). Runs on the LAN
home server, token-gated, and drives ComfyUI instance lifecycle via systemd
template units (comfy@0 → GPU 0/port 8188, comfy@1 → GPU 1/port 8189).

See server/README-install.md in the arthur repo for deployment.

Design (docs/PLAN.md §2.2):
  GET  /health                      → unauthenticated {ok, version}
  GET  /api/status                  → {version, instances[], host_uptime}
  GET  /api/instances               → registry
  GET  /api/instances/{id}/status   → runtime status + port liveness probe
  POST /api/instances/{id}/start    → idempotent systemctl start
  POST /api/instances/{id}/stop     → graceful; 409 if a generation is running
                                       (bypass with ?force=1)
  POST /api/instances/{id}/restart  → stop → wait port free (~30s) → start
  GET  /api/log?offset=N            → byte-offset tail of the JSONL audit log

Security: Bearer token on everything under /api/; instance ids validated
against the fixed allowlist from the config file (request data is NEVER
interpolated into shell commands — units come from config); all subprocess
calls go through systemctl with timeouts; structured JSON errors.
"""

import json
import os
import re
import secrets
import subprocess
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

AGENT_VERSION = "0.4.0"

CONFIG_PATH = os.environ.get("ARTHUR_AGENT_CONFIG", "/etc/arthur-agent/config.json")
TOKEN_PATH = os.environ.get("ARTHUR_AGENT_TOKEN_FILE", "/etc/arthur-agent/token")
AUDIT_PATH = os.environ.get("ARTHUR_AGENT_AUDIT", "/var/log/arthur-agent/audit.jsonl")

HTTP_TIMEOUT = 5          # urllib probe timeout (s)
CMD_TIMEOUT = 30          # systemctl subprocess timeout (s)
PORT_COMEUP_WAIT = 90     # max wait for a freshly started instance to serve (s)
PORT_FREE_WAIT = 30       # max wait for the port to be free after stop (s)
INSTANCE_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")

_audit_lock = threading.Lock()
_config = None
_token = None


# --------------------------------------------------------------------------
# config / token
# --------------------------------------------------------------------------

def load_config():
    """Load and validate the instance registry from config.json."""
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        raw = json.load(f)
    instances = raw.get("instances")
    if not isinstance(instances, dict) or not instances:
        raise ValueError("config.json must contain a non-empty 'instances' object")
    registry = {}
    for inst_id, spec in instances.items():
        if not INSTANCE_RE.match(inst_id):
            raise ValueError("instance id %r must match [a-z0-9-]" % inst_id)
        port = int(spec["port"])
        unit = str(spec["unit"])
        if not isinstance(port, int) or port <= 0 or "/" in unit:
            raise ValueError("bad port/unit for instance %r" % inst_id)
        registry[inst_id] = {
            "id": inst_id,
            "name": spec.get("name", inst_id),
            "port": port,
            "gpu": spec.get("gpu"),
            "unit": unit,
        }
    return {
        "instances": registry,
        "bind": raw.get("bind", os.environ.get("ARTHUR_AGENT_BIND", "0.0.0.0")),
        "port": int(raw.get("port", os.environ.get("ARTHUR_AGENT_PORT", "8766"))),
    }


def load_token():
    """Bearer token: env ARTHUR_AGENT_TOKEN wins, else read the token file."""
    tok = os.environ.get("ARTHUR_AGENT_TOKEN", "").strip()
    if tok:
        return tok
    with open(TOKEN_PATH, "r", encoding="utf-8") as f:
        tok = f.read().strip()
    return tok or None


# --------------------------------------------------------------------------
# systemctl / probes (fixed argv only — never interpolate request data)
# --------------------------------------------------------------------------

def run_cmd(args, timeout=CMD_TIMEOUT):
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        return proc.returncode, proc.stdout.strip(), proc.stderr.strip()
    except subprocess.TimeoutExpired:
        return -1, "", "timeout after %ss" % timeout
    except OSError as exc:
        return -1, "", str(exc)


def unit_is_active(unit):
    rc, _out, _err = run_cmd(["systemctl", "is-active", "--quiet", unit], timeout=10)
    return rc == 0


def unit_uptime(unit):
    """Seconds since the unit was last activated (wall clock), or None."""
    rc, stamp, _err = run_cmd(
        ["systemctl", "show", unit, "-p", "ActiveEnterTimestamp", "--value"],
        timeout=10,
    )
    if rc != 0 or not stamp or stamp == "n/a":
        return None
    # systemd prints "Wed 2026-11-04 22:50:25 CET" — coreutils date parses
    # it in any locale/tz. (Monotonic timestamps diverge from wall time on
    # hosts that suspend, so never mix them.)
    rc, epoch, _err = run_cmd(["date", "-d", stamp, "+%s"], timeout=10)
    if rc != 0 or not epoch.isdigit():
        return None
    return max(0.0, time.time() - int(epoch))


def probe_port(port):
    """True if the instance answers /system_stats on 127.0.0.1:port."""
    try:
        with urllib.request.urlopen(
            "http://127.0.0.1:%d/system_stats" % port, timeout=HTTP_TIMEOUT
        ) as resp:
            return resp.status == 200
    except Exception:
        return False


def queue_running_count(port):
    """Number of running generations on the instance, or None if unprobeable."""
    try:
        with urllib.request.urlopen(
            "http://127.0.0.1:%d/queue" % port, timeout=HTTP_TIMEOUT
        ) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
    except Exception:
        return None
    running = data.get("queue_running")
    if isinstance(running, list):
        return len(running)
    if isinstance(running, dict):
        return len(running)
    return 0


def probe_host_uptime():
    try:
        with open("/proc/uptime", "r", encoding="ascii") as f:
            return float(f.read().split()[0])
    except (OSError, ValueError, IndexError):
        return None


def wait_for_port(port, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if probe_port(port):
            return True
        time.sleep(1.0)
    return probe_port(port)


def wait_port_free(port, timeout=PORT_FREE_WAIT):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not probe_port(port):
            return True
        time.sleep(1.0)
    return not probe_port(port)


# --------------------------------------------------------------------------
# audit log
# --------------------------------------------------------------------------

def audit(instance, action, result, source_ip):
    entry = {
        "ts": _now_iso(),
        "instance": instance,
        "action": action,
        "result": result,
        "source-ip": source_ip,
    }
    line = json.dumps(entry, separators=(",", ":")) + "\n"
    with _audit_lock:
        try:
            os.makedirs(os.path.dirname(AUDIT_PATH), mode=0o755, exist_ok=True)
            with open(AUDIT_PATH, "a", encoding="utf-8") as f:
                f.write(line)
        except OSError:
            pass
    return entry


def _now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"


def tail_audit(offset):
    """Return (next_offset, lines) for the byte-offset tail. Returns
    (current_size, []) if offset is past EOF."""
    try:
        size = os.path.getsize(AUDIT_PATH)
    except OSError:
        return 0, []
    if offset >= size:
        return size, []
    with _audit_lock:
        try:
            with open(AUDIT_PATH, "rb") as f:
                f.seek(offset)
                data = f.read()
        except OSError:
            return size, []
    lines = data.decode("utf-8", "replace").splitlines()
    return offset + len(data), lines


# --------------------------------------------------------------------------
# lifecycle actions
# --------------------------------------------------------------------------

def action_start(inst, ip):
    if unit_is_active(inst["unit"]):
        audit(inst["id"], "start", "already-running", ip)
        return 200, {"instance": inst["id"], "action": "start", "result": "already-running"}
    rc, _out, err = run_cmd(["systemctl", "start", inst["unit"]])
    if rc != 0:
        audit(inst["id"], "start", "failed:" + err, ip)
        return 500, {"error": "systemctl start failed: %s" % err}
    if not wait_for_port(inst["port"], PORT_COMEUP_WAIT):
        audit(inst["id"], "start", "unit-up-port-down", ip)
        return 502, {"error": "unit started but port %d did not come up" % inst["port"]}
    audit(inst["id"], "start", "started", ip)
    return 200, {"instance": inst["id"], "action": "start", "result": "started"}


def action_stop(inst, force, ip):
    running = queue_running_count(inst["port"]) if probe_port(inst["port"]) else None
    if running and not force:
        audit(inst["id"], "stop", "refused-busy:%d" % running, ip)
        return 409, {"error": "generation running on %s (%d job(s)); "
                             "pass ?force=1 to stop anyway" % (inst["id"], running)}
    rc, _out, err = run_cmd(["systemctl", "stop", inst["unit"]])
    if rc != 0:
        audit(inst["id"], "stop", "failed:" + err, ip)
        return 500, {"error": "systemctl stop failed: %s" % err}
    audit(inst["id"], "stop", "stopped", ip)
    return 200, {"instance": inst["id"], "action": "stop", "result": "stopped"}


def action_restart(inst, force, ip):
    if probe_port(inst["port"]):
        running = queue_running_count(inst["port"])
        if running and not force:
            audit(inst["id"], "restart", "refused-busy:%d" % running, ip)
            return 409, {"error": "generation running on %s (%d job(s)); "
                                 "pass ?force=1 to restart anyway" % (inst["id"], running)}
        rc, _out, err = run_cmd(["systemctl", "stop", inst["unit"]])
        if rc != 0:
            audit(inst["id"], "restart", "failed-stop:" + err, ip)
            return 500, {"error": "systemctl stop failed: %s" % err}
    if not wait_port_free(inst["port"]):
        audit(inst["id"], "restart", "port-busy", ip)
        return 502, {"error": "port %d still in use after stop" % inst["port"]}
    rc, _out, err = run_cmd(["systemctl", "start", inst["unit"]])
    if rc != 0:
        audit(inst["id"], "restart", "failed-start:" + err, ip)
        return 500, {"error": "systemctl start failed: %s" % err}
    if not wait_for_port(inst["port"], PORT_COMEUP_WAIT):
        audit(inst["id"], "restart", "unit-up-port-down", ip)
        return 502, {"error": "unit started but port %d did not come up" % inst["port"]}
    audit(inst["id"], "restart", "restarted", ip)
    return 200, {"instance": inst["id"], "action": "restart", "result": "restarted"}


def instance_summary(inst):
    up = unit_is_active(inst["unit"])
    return {
        "id": inst["id"],
        "name": inst["name"],
        "port": inst["port"],
        "gpu": inst["gpu"],
        "up": up,
        "uptime": unit_uptime(inst["unit"]) if up else None,
    }


def instance_detail(inst):
    up = unit_is_active(inst["unit"])
    return {
        "id": inst["id"],
        "name": inst["name"],
        "port": inst["port"],
        "gpu": inst["gpu"],
        "unit": inst["unit"],
        "up": up,
        "live": probe_port(inst["port"]),
        "uptime": unit_uptime(inst["unit"]) if up else None,
    }


# --------------------------------------------------------------------------
# HTTP layer
# --------------------------------------------------------------------------

STATUS = {
    200: "OK", 400: "Bad Request", 401: "Unauthorized", 404: "Not Found",
    405: "Method Not Allowed", 409: "Conflict", 500: "Internal Server Error",
    502: "Bad Gateway", 503: "Service Unavailable",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "arthur-agent/" + AGENT_VERSION
    protocol_version = "HTTP/1.1"

    # --- plumbing ---------------------------------------------------------
    def log_message(self, fmt, *args):
        pass  # actions land in the audit log; keep the journal clean

    def respond(self, code, obj):
        body = json.dumps(obj).encode("utf-8") + b"\n"
        self.send_response(code, STATUS.get(code, ""))
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def client_ip(self):
        return self.client_address[0]

    def authorized(self):
        if not _token:
            self.respond(503, {"error": "agent has no token configured"})
            return False
        header = self.headers.get("Authorization", "")
        expect = "Bearer " + _token
        if not secrets.compare_digest(header, expect):
            self.respond(401, {"error": "unauthorized"})
            return False
        return True

    def instance(self, inst_id):
        if not INSTANCE_RE.match(inst_id or ""):
            self.respond(400, {"error": "invalid instance id"})
            return None
        inst = _config["instances"].get(inst_id)
        if inst is None:
            self.respond(404, {"error": "unknown instance %r" % inst_id})
            return None
        return inst

    # --- verbs ------------------------------------------------------------
    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def route(self, verb):
        try:
            self.dispatch(verb)
        except BrokenPipeError:
            pass
        except Exception as exc:  # never die on a bad request
            try:
                self.respond(500, {"error": "internal error: %s" % exc})
            except Exception:
                pass

    def dispatch(self, verb):
        parts = urlsplit(self.path)
        path = parts.path.rstrip("/") or "/"
        query = parse_qs(parts.query)

        if path == "/health":
            if verb != "GET":
                return self.respond(405, {"error": "method not allowed"})
            return self.respond(200, {"ok": True, "version": AGENT_VERSION})

        # everything below /api/ is token-gated
        if not path.startswith("/api/") and path != "/api":
            return self.respond(404, {"error": "not found"})
        if not self.authorized():
            return

        if path == "/api/status" and verb == "GET":
            return self.respond(200, {
                "version": AGENT_VERSION,
                "instances": [instance_summary(i) for i in _config["instances"].values()],
                "host_uptime": probe_host_uptime(),
            })

        if path == "/api/instances" and verb == "GET":
            return self.respond(200, {
                "instances": [
                    {"id": i["id"], "name": i["name"], "port": i["port"],
                     "gpu": i["gpu"], "unit": i["unit"]}
                    for i in _config["instances"].values()
                ]
            })

        m = re.match(r"^/api/instances/([^/]+)/status$", path)
        if m and verb == "GET":
            inst = self.instance(m.group(1))
            if inst is None:
                return
            return self.respond(200, instance_detail(inst))

        m = re.match(r"^/api/instances/([^/]+)/(start|stop|restart)$", path)
        if m and verb == "POST":
            inst = self.instance(m.group(1))
            if inst is None:
                return
            action = m.group(2)
            force = query.get("force", ["0"])[0] in ("1", "true", "yes")
            code, body = (
                action_start(inst, self.client_ip()) if action == "start" else
                action_stop(inst, force, self.client_ip()) if action == "stop" else
                action_restart(inst, force, self.client_ip())
            )
            return self.respond(code, body)

        if path == "/api/log" and verb == "GET":
            try:
                offset = max(0, int(query.get("offset", ["0"])[0]))
            except ValueError:
                return self.respond(400, {"error": "offset must be an integer"})
            next_offset, lines = tail_audit(offset)
            return self.respond(200, {"offset": offset, "next_offset": next_offset,
                                      "lines": lines})

        self.respond(404, {"error": "not found"})


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def main():
    global _config, _token
    try:
        _config = load_config()
    except Exception as exc:
        print("fatal: cannot load %s: %s" % (CONFIG_PATH, exc), file=os.sys.stderr)
        raise SystemExit(1)
    try:
        _token = load_token()
    except OSError:
        _token = None
    bind, port = _config["bind"], _config["port"]
    httpd = ThreadingHTTPServer((bind, port), Handler)
    print("arthur-agent %s listening on %s:%d (audit: %s)"
          % (AGENT_VERSION, bind, port, AUDIT_PATH), flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
