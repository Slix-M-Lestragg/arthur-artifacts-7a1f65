#!/usr/bin/env python3
"""arthur-agent — companion agent for the arthur Obsidian plugin.

Single-file Python 3 stdlib HTTP server (zero pip deps). Runs on the LAN
home server, token-gated, and drives a *service registry* of systemd units
(v0.6.0):

  services (from /etc/arthur-agent/config.json):
    comfyui    multi-instance  → template unit comfy@{i}
                 index i = lowest free index in 0..max_instances-1,
                 port = default_port + i, gpus = [i % NUM_GPUS] by default;
                 (v0.6.0) the spawn body may pin an explicit GPU set
                 {"gpus": [1]} or {"gpus": [0, 1]} — written as a runtime
                 systemd drop-in (/run/systemd/system/comfy@<i>.service.d/
                 override.conf setting ARTHUR_GPUS) that the template unit
                 honors; NUM_GPUS detected live via `nvidia-smi -L`
               plus optional named *extra instances* (config: extra_instances)
                 that ride their own units, e.g. comfy-dual.service =
                 ComfyUI on port 8190 spanning ALL GPUs (gpus [0, 1])
    aitoolkit  single-instance → ai-toolkit.service (must never be duplicated:
                 shared SQLite state)

Instance ids/units are *computed* from the registry, never stored from
requests; request data is NEVER interpolated into shell commands — the only
strings reaching systemd come from config. All subprocess calls have
timeouts. Every mutation lands in the JSONL audit log.

API (see server/README-install.md for the full documented surface):
  GET  /health                                  → unauthenticated {ok, version}
  GET  /api/gpus                                → live nvidia-smi per-GPU stats
  GET  /api/status                              → live per-service/instance state
  GET  /api/services                            → registry + live state
  GET  /api/services/{svc}                      → one service: registry + live
  POST /api/services/{svc}/start                → ensure default instance up
  POST /api/services/{svc}/stop[?force=1]       → stop ALL instances and forget
                 every spawned / non-default roster instance (v0.5.4: the
                 service then shows cleanly down — only the default index-0
                 instance stays listed, as its single down row)
  POST /api/services/{svc}/instances            → spawn new instance (multi only)
                 optional JSON body {"gpus": [...]}: pins CUDA_VISIBLE_DEVICES
                 for the new instance (v0.6.0); no body → modulo default
  GET  /api/services/{svc}/instances            → instances of one service
  GET  /api/services/{svc}/instances/{id}/status
  POST /api/services/{svc}/instances/{id}/start
  POST /api/services/{svc}/instances/{id}/stop[?force=1]
  POST /api/services/{svc}/instances/{id}/restart[?force=1]
  POST /api/services/{svc}/instances/{id}/forget → forget a STOPPED instance
                 (spawned: dropped from spawn-state, index/port free again;
                 extras: entry removed from config.json, live rewrite;
                 the default instance (index 0) is never forgettable)
  GET  /api/log?offset=N                        → JSONL audit tail

(v0.7.0, Bearer-gated like all /api/*) pi session aggregation: the pi-sync
mirror repo (~/.pi/agent/pi-sync/repo, env ARTHUR_PI_REPO override) is read
for per-device pi session status — NOT a systemd-backed service, never in the
registry:

  GET  /api/pi/status                          → aggregated per-device session
                 status {devices: [...], generatedAt}; degradable: missing
                 repo/status/ → 200 {devices: [], warning: "..."}
  GET  /api/pi/sessions/{dev}/{id}/tail?lines=N → last N compacted entries of
                 the session's JSONL (path resolved from the device's status
                 file, sandboxed to /home/*/.pi/agent/sessions/)
"""

import json
import os
import re
import secrets
import subprocess
import threading
import time
import urllib.request
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

AGENT_VERSION = "0.7.0"

CONFIG_PATH = os.environ.get("ARTHUR_AGENT_CONFIG", "/etc/arthur-agent/config.json")
TOKEN_PATH = os.environ.get("ARTHUR_AGENT_TOKEN_FILE", "/etc/arthur-agent/token")
AUDIT_PATH = os.environ.get("ARTHUR_AGENT_AUDIT", "/var/log/arthur-agent/audit.jsonl")
STATE_PATH = os.environ.get("ARTHUR_AGENT_STATE", "/var/lib/arthur-agent/instances.json")

HTTP_TIMEOUT = 5          # urllib probe timeout (s)
CMD_TIMEOUT = 30          # systemctl subprocess timeout (s)
PORT_COMEUP_WAIT = 90     # max wait for a freshly started instance to serve (s)
PORT_FREE_WAIT = 30       # max wait for the port to be free after stop (s)
GPU_CACHE_TTL = 60        # seconds to trust a NUM_GPU detection
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
UNIT_RE = re.compile(r"^[A-Za-z0-9:@._{}\\-]+$")
PROBE_RE = re.compile(r"^/[A-Za-z0-9._~:/-]*$")

_audit_lock = threading.Lock()
_state_lock = threading.Lock()
_config_lock = threading.Lock()  # config.json rewrites (instance forget)
_spawn_lock = threading.Lock()   # spawns pick indexes one at a time
_gpu_lock = threading.Lock()
_config = None
_token = None
_gpu_cache = {"ts": 0.0, "n": None}


# --------------------------------------------------------------------------
# config / token / spawned-instance state
# --------------------------------------------------------------------------

def load_config():
    """Load and validate the service registry (config.json schema v2.1).

    {
      "services": {
        "<svc-id>": {
          "name": str,
          "default_port": int,          # instance i listens on i + default_port
          "multi_instance": bool,
          "max_instances": int,         # >= 1
          "unit_template": "comfy@{i}", # multi only; {i} → instance index
          "unit": "ai-toolkit.service", # single only
          "instance_prefix": "comfy",   # multi only; instance id "<prefix>-<i>"
          "probe_path": "/system_stats", # optional, HTTP liveness path (def /)

          # multi only, optional (v0.5.2): named instances BEYOND the spawned
          # range. Ride their own units, are listed like spawned instances
          # (start/stop/restart + up/down probing work on them) but are NOT
          # part of template spawn allocation (spawn keeps using indexes
          # 0..max_instances-1 regardless of extras).
          "extra_instances": [
            {"id": "comfy-dual", "port": 8190, "gpus": [0, 1],
             "unit": "comfy-dual.service"}
          ]
        }
      },
      "num_gpus": 2,          # optional static fallback hint
      "bind": "0.0.0.0",      # optional; env ARTHUR_AGENT_BIND wins otherwise
      "port": 8766            # optional; env ARTHUR_AGENT_PORT wins otherwise
    }
    """
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        raw = json.load(f)
    services = raw.get("services")
    if not isinstance(services, dict) or not services:
        raise ValueError("config.json must contain a non-empty 'services' object")
    registry = {}
    for svc_id, spec in services.items():
        if not ID_RE.match(svc_id):
            raise ValueError("service id %r must match [a-z0-9-]" % svc_id)
        multi = bool(spec.get("multi_instance", False))
        name = str(spec.get("name", svc_id))
        port = int(spec["default_port"])
        max_i = int(spec.get("max_instances", 1 if not multi else 2))
        if port <= 0 or port > 65535 or max_i < 1:
            raise ValueError("bad default_port/max_instances for service %r" % svc_id)
        out = {"id": svc_id, "name": name, "default_port": port,
               "multi_instance": multi, "max_instances": max_i}
        probe = spec.get("probe_path", "/")
        if not isinstance(probe, str) or not PROBE_RE.match(probe):
            raise ValueError("bad probe_path for service %r" % svc_id)
        out["probe_path"] = probe
        if multi:
            unit_tpl = str(spec["unit_template"])
            prefix = str(spec.get("instance_prefix", svc_id))
            if "{i}" not in unit_tpl or not UNIT_RE.match(unit_tpl) \
               or "/" in unit_tpl or not ID_RE.match(prefix):
                raise ValueError("bad unit_template/instance_prefix for service %r" % svc_id)
            out["unit_template"] = unit_tpl
            out["instance_prefix"] = prefix
            extras = spec.get("extra_instances", [])
            if not isinstance(extras, list):
                raise ValueError("extra_instances for %r must be a list" % svc_id)
            parsed = []
            seen_extra = set()
            for e in extras:
                if not isinstance(e, dict):
                    raise ValueError("extra_instances entries must be objects")
                eid = str(e.get("id", ""))
                if not ID_RE.match(eid) or eid in seen_extra:
                    raise ValueError("bad or duplicate extra instance id %r of %s"
                                     % (eid, svc_id))
                seen_extra.add(eid)
                try:
                    eport = int(e["port"])
                except (KeyError, TypeError, ValueError):
                    raise ValueError("extra instance %r needs an integer port"
                                     % eid)
                if eport <= 0 or eport > 65535:
                    raise ValueError("bad port for extra instance %r" % eid)
                egpus = e.get("gpus")
                if not isinstance(egpus, list) or not egpus or \
                   not all(isinstance(g, int) and 0 <= g < 4096 for g in egpus):
                    raise ValueError("extra instance %r needs gpus: [int, ...] "
                                     "(non-empty)" % eid)
                eunit = str(e.get("unit", ""))
                if not UNIT_RE.match(eunit) or "/" in eunit:
                    raise ValueError("bad unit for extra instance %r" % eid)
                ename = e.get("name")
                if ename is not None and not isinstance(ename, str):
                    raise ValueError("bad name for extra instance %r" % eid)
                parsed.append({"id": eid, "port": eport, "gpus": list(egpus),
                               "unit": eunit,
                               **({"name": ename} if ename is not None else {})})
            out["extra_instances"] = parsed
        else:
            unit = str(spec["unit"])
            if not UNIT_RE.match(unit) or "/" in unit:
                raise ValueError("bad unit for service %r" % svc_id)
            out["unit"] = unit
        registry[svc_id] = out
    return {
        "services": registry,
        "num_gpus": int(raw.get("num_gpus", 1)),
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


def load_state():
    """Persisted memory of *spawned* instance indexes per service, so an
    instance stays visible (stopped) in listings after a stop/reboot.
    File shape (v0.6.0): {"known": {"comfyui": {"1": [1], "2": null}}} —
    index → explicit GPU list (from a spawn with a gpus body) or null
    (template modulo default). The legacy v0.5.x array shape
    ({"known": {"comfyui": [0, 1]}}) is migrated on read into
    {idx: None} entries (modulo default). Best-effort: unreadable → {}."""
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        known = data.get("known", {})
        if not isinstance(known, dict):
            return {}
        out = {}
        for svc_id, val in known.items():
            if isinstance(val, list):  # legacy v0.5.x shape: plain indexes
                try:
                    out[svc_id] = {int(i): None for i in val}
                except (ValueError, TypeError):
                    continue
            elif isinstance(val, dict):
                m = {}
                for idx, gpus in val.items():
                    try:
                        i = int(idx)
                    except (ValueError, TypeError):
                        continue
                    m[i] = (sorted(gpus)
                            if isinstance(gpus, list) and gpus
                            and all(isinstance(g, int)
                                    and not isinstance(g, bool) for g in gpus)
                            else None)
                out[svc_id] = m
        return out
    except (OSError, ValueError, TypeError):
        return {}


def _save_state(state):
    try:
        os.makedirs(os.path.dirname(STATE_PATH), mode=0o755, exist_ok=True)
        tmp = STATE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"known": state}, f)
        os.replace(tmp, STATE_PATH)
    except OSError:
        pass


def remember_instance(svc_id, idx, gpus=None):
    """Record a spawned instance index so it survives restarts; v0.6.0 also
    records the instance's GPU set (None → template modulo default). Passing
    gpus=None OVERWRITES any stale explicit record. Best-effort."""
    with _state_lock:
        state = load_state()
        state.setdefault(svc_id, {})[idx] = \
            sorted(set(gpus)) if gpus else None
        _save_state(state)


def spawn_state_gpus(svc_id, idx):
    """The persisted GPU set for a spawned index — a list when an explicit
    set is recorded, else None (no record or modulo default)."""
    return load_state().get(svc_id, {}).get(idx)


def forget_spawn_index(svc_id, idx):
    """Drop a spawned instance index from the persisted state so the stopped
    instance disappears from listings and its index/port become free for a
    future spawn. Best-effort."""
    with _state_lock:
        state = load_state()
        m = state.get(svc_id)
        if m is None:
            return
        m.pop(idx, None)
        if not m:
            state.pop(svc_id, None)
        _save_state(state)


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


def num_gpus():
    """Live GPU count via `nvidia-smi -L` (cached GPU_CACHE_TTL); falls back
    to the static config hint, then to 1."""
    with _gpu_lock:
        now = time.time()
        if _gpu_cache["n"] is None or now - _gpu_cache["ts"] > GPU_CACHE_TTL:
            rc, out, _err = run_cmd(["nvidia-smi", "-L"], timeout=10)
            n = 0
            if rc == 0:
                n = sum(1 for line in out.splitlines() if line.strip())
            if n <= 0:
                n = max(1, int(_config.get("num_gpus", 1)))
            _gpu_cache["ts"] = now
            _gpu_cache["n"] = n
        return _gpu_cache["n"]


def gpu_stats():
    """Live per-GPU stats via nvidia-smi (5 s timeout).
    Returns (gpus, error): on success error is None; on failure gpus is []
    and error carries the message (the endpoint stays 200/degradable)."""
    rc, out, err = run_cmd(
        ["nvidia-smi", "--query-gpu=index,name,memory.total,memory.used,"
                        "utilization.gpu,temperature.gpu",
         "--format=csv,noheader,nounits"],
        timeout=5,
    )
    if rc != 0:
        return [], (err or "nvidia-smi exited with status %d" % rc)
    gpus = []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 6:
            return [], "could not parse nvidia-smi output: %r" % line
        try:
            gpus.append({
                "index": int(parts[0]),
                # name may itself contain a comma — everything between the
                # first field and the four trailing numeric fields is the name
                "name": ", ".join(parts[1:len(parts) - 4]),
                "mem_total_mb": int(parts[-4]),
                "mem_used_mb": int(parts[-3]),
                "util_percent": int(parts[-2]),
                "temp_c": int(parts[-1]),
            })
        except ValueError:
            return [], "could not parse nvidia-smi output: %r" % line
    if not gpus:
        return [], "nvidia-smi returned no data"
    return gpus, None


def probe_port(port, path="/system_stats"):
    """True if 127.0.0.1:port answers 200 on the service's probe path."""
    try:
        with urllib.request.urlopen(
            "http://127.0.0.1:%d%s" % (port, path), timeout=HTTP_TIMEOUT
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


def wait_for_port(port, path, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if probe_port(port, path):
            return True
        time.sleep(1.0)
    return probe_port(port, path)


def wait_port_free(port, timeout=PORT_FREE_WAIT):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not probe_port(port, "/"):
            return True
        time.sleep(1.0)
    return not probe_port(port, "/")


# --------------------------------------------------------------------------
# per-index GPU drop-ins (v0.6.0)
# --------------------------------------------------------------------------

def dropin_path(unit):
    """Runtime drop-in that pins a spawned instance's GPU set:
    /run/systemd/system/<unit>.service.d/override.conf, content
    `Environment=ARTHUR_GPUS="<list>"`. The agent runs as root and /run is
    writable under its unit's ProtectSystem=full. Drop-ins survive unit
    stop/start (only stop/forget/stop-all clear them) and are wiped by a
    REBOOT — the start/restart paths re-create them from spawn-state."""
    return os.path.join("/run/systemd/system", "%s.service.d" % unit, "override.conf")


def write_gpu_dropin(unit, gpus):
    path = dropin_path(unit)
    os.makedirs(os.path.dirname(path), mode=0o755, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write('# managed by arthur-agent (GPU-aware spawn, v%s);\n'
                '# removed on stop/forget/stop-all — template default wins\n'
                '[Service]\nEnvironment=ARTHUR_GPUS="%s"\n'
                % (AGENT_VERSION, ",".join(str(g) for g in sorted(set(gpus)))))
    os.replace(tmp, path)


def sync_gpu_dropin(unit, gpus):
    """Make the unit's runtime drop-in match `gpus`: a list → write it; None
    → the template modulo default must win, so the drop-in is deleted.
    Returns True when the filesystem changed (caller then needs a
    systemctl daemon-reload)."""
    path = dropin_path(unit)
    if gpus:
        content = '[Service]\nEnvironment=ARTHUR_GPUS="%s"\n' \
            % ",".join(str(g) for g in sorted(set(gpus)))
        try:
            with open(path, "r", encoding="utf-8") as f:
                if content in f.read():
                    return False
        except OSError:
            pass
        write_gpu_dropin(unit, gpus)
        return True
    try:
        os.remove(path)
    except OSError:
        return False
    try:
        os.rmdir(os.path.dirname(path))
    except OSError:
        pass  # dir not empty (non-arthur override.conf) — leave it
    return True


def ensure_gpu_dropin(unit, gpus):
    """sync_gpu_dropin + systemctl daemon-reload when it changed."""
    if sync_gpu_dropin(unit, gpus):
        run_cmd(["systemctl", "daemon-reload"])
        return True
    return False


def validate_gpus(val):
    """Check an optional spawn body's gpus array (v0.6.0). Returns None when
    it is a valid set (non-empty list of unique ints, every index < the live
    NUM_GPUS), else a message for the 400 response."""
    if not isinstance(val, list) or not val:
        return "'gpus' must be a non-empty array of GPU indexes"
    if not all(isinstance(g, int) and not isinstance(g, bool) for g in val):
        return "'gpus' entries must be integers"
    n = num_gpus()
    bad = [g for g in val if g < 0 or g >= n]
    if bad:
        return "GPU index(es) %s not found on this host (%d GPU(s) detected, "\
               "valid: 0..%d)" % (",".join(str(g) for g in bad), n, n - 1)
    if len(set(val)) != len(val):
        return "'gpus' entries must be unique"
    return None


# --------------------------------------------------------------------------
# audit log
# --------------------------------------------------------------------------

def audit(service, instance, action, result, source_ip):
    entry = {
        "ts": _now_iso(),
        "service": service,
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
# service / instance model (computed from the registry — never from requests)
# --------------------------------------------------------------------------

def make_instance(svc, idx=None, extra=None):
    """Internal representation of one instance of service `svc` (spec dict).
    Template-spawned instances pass idx; named extra instances pass extra
    (v0.5.2). gpus is always a list; single-instance services carry []."""
    if extra is not None:
        return {
            "service": svc["id"],
            "spec": svc,
            "id": extra["id"],
            "index": None,
            "name": extra.get("name") or extra["id"],
            "port": extra["port"],
            "unit": extra["unit"],
            "gpus": list(extra["gpus"]),
        }
    if svc["multi_instance"]:
        iid = "%s-%d" % (svc["instance_prefix"], idx)
        unit = svc["unit_template"].replace("{i}", str(idx))
        # v0.6.0: gpus come from spawn-state (a spawn with a gpus body pins
        # them); no record → the template's modulo default.
        recorded = spawn_state_gpus(svc["id"], idx)
        gpus = list(recorded) if recorded else [idx % num_gpus()]
        name = "%s #%d" % (svc["name"], idx)
    else:
        iid, unit, gpus, name = svc["id"], svc["unit"], [], svc["name"]
    return {
        "service": svc["id"],
        "spec": svc,
        "id": iid,
        "index": idx,
        "name": name,
        "port": svc["default_port"] + idx,
        "unit": unit,
        "gpus": gpus,
    }


def find_instance(svc, iid):
    """Resolve a request-supplied instance id: named extra instances first
    (config extra_instances units), then template-spawned indexes, else None."""
    if not svc["multi_instance"]:
        return make_instance(svc, 0) if iid == svc["id"] else None
    for extra in svc.get("extra_instances", []):
        if iid == extra["id"]:
            return make_instance(svc, extra=extra)
    m = re.match(r"^%s-(\d+)$" % re.escape(svc["instance_prefix"]), iid or "")
    if m:
        idx = int(m.group(1))
        if 0 <= idx < svc["max_instances"]:
            return make_instance(svc, idx)
    return None


def active_indexes(svc):
    """Indexes 0..max-1 whose unit is currently active."""
    return [i for i in range(svc["max_instances"])
            if unit_is_active(svc["unit_template"].replace("{i}", str(i))
                              if svc["multi_instance"] else svc["unit"])]


def service_instances(svc):
    """Instances worth listing: the default (index 0) plus every active unit
    plus every previously spawned index (state file; shows stopped ones),
    plus config-declared extra instances (v0.5.2) at the end."""
    if not svc["multi_instance"]:
        return [make_instance(svc, 0)]
    known = set(load_state().get(svc["id"], {}))
    idxs = sorted({0} | set(active_indexes(svc)) | known)
    return [make_instance(svc, i) for i in idxs] + \
           [make_instance(svc, extra=e)
            for e in svc.get("extra_instances", [])]


def default_instance(svc):
    return make_instance(svc, 0)


def instance_summary(inst):
    unit_up = unit_is_active(inst["unit"])
    live = probe_port(inst["port"], inst["spec"]["probe_path"])
    gpus = inst["gpus"]
    return {
        "id": inst["id"],
        "service": inst["service"],
        "name": inst["name"],
        "port": inst["port"],
        "gpu": gpus[0] if len(gpus) == 1 else None,
        "gpus": gpus,
        "up": bool(unit_up and live),
        "uptime": unit_uptime(inst["unit"]) if unit_up else None,
    }


def instance_detail(inst):
    d = instance_summary(inst)
    d["unit"] = inst["unit"]
    d["live"] = probe_port(inst["port"], inst["spec"]["probe_path"])
    return d


def service_summary(svc, detailed=False):
    insts = service_instances(svc)
    bodies = [instance_detail(i) if detailed else instance_summary(i) for i in insts]
    out = {
        "id": svc["id"],
        "name": svc["name"],
        "active": any(b["up"] for b in bodies),
        "multi_instance": svc["multi_instance"],
        "max_instances": svc["max_instances"],
        "default_port": svc["default_port"],
        "instances": bodies,
    }
    if svc["multi_instance"]:
        out["unit_template"] = svc["unit_template"]
    else:
        out["unit"] = svc["unit"]
    return out


# --------------------------------------------------------------------------
# lifecycle actions
# --------------------------------------------------------------------------

def action_start_instance(inst, ip):
    svc = inst["spec"]
    if unit_is_active(inst["unit"]):
        audit(svc["id"], inst["id"], "start", "already-running", ip)
        return 200, {"action": "start", "result": "already-running",
                     "instance": instance_detail(inst)}
    # v0.6.0: sync the runtime GPU drop-in with spawn-state before start
    # (e.g. a reboot wiped /run, or the instance was spawned with an explicit
    # gpus set that must survive stop/start). Extras and single-instance
    # services own their units — no drop-in management for them.
    if svc["multi_instance"] and inst["index"] is not None:
        ensure_gpu_dropin(inst["unit"], spawn_state_gpus(svc["id"], inst["index"]))
    rc, _out, err = run_cmd(["systemctl", "start", inst["unit"]])
    if rc != 0:
        audit(svc["id"], inst["id"], "start", "failed:" + err, ip)
        return 500, {"error": "systemctl start failed: %s" % err}
    if not wait_for_port(inst["port"], svc["probe_path"], PORT_COMEUP_WAIT):
        audit(svc["id"], inst["id"], "start", "unit-up-port-down", ip)
        return 502, {"error": "unit started but port %d did not come up"
                             % inst["port"]}
    audit(svc["id"], inst["id"], "start", "started", ip)
    return 200, {"action": "start", "result": "started",
                 "instance": instance_detail(inst)}


def action_stop_instance(inst, force, ip):
    svc = inst["spec"]
    running = queue_running_count(inst["port"]) \
        if probe_port(inst["port"], svc["probe_path"]) else None
    if running and not force:
        audit(svc["id"], inst["id"], "stop", "refused-busy:%d" % running, ip)
        return 409, {"error": "generation running on %s (%d job(s)); "
                              "pass ?force=1 to stop anyway" % (inst["id"], running)}
    rc, _out, err = run_cmd(["systemctl", "stop", inst["unit"]])
    if rc != 0:
        audit(svc["id"], inst["id"], "stop", "failed:" + err, ip)
        return 500, {"error": "systemctl stop failed: %s" % err}
    # v0.6.0: free the index of any pinned GPU set (the start/restart paths
    # re-create the drop-in from spawn-state).
    if svc["multi_instance"] and inst["index"] is not None:
        ensure_gpu_dropin(inst["unit"], None)
    audit(svc["id"], inst["id"], "stop", "stopped", ip)
    return 200, {"action": "stop", "result": "stopped",
                 "instance": instance_detail(inst)}


def action_restart_instance(inst, force, ip):
    svc = inst["spec"]
    if probe_port(inst["port"], svc["probe_path"]):
        running = queue_running_count(inst["port"])
        if running and not force:
            audit(svc["id"], inst["id"], "restart", "refused-busy:%d" % running, ip)
            return 409, {"error": "generation running on %s (%d job(s)); "
                                 "pass ?force=1 to restart anyway"
                                 % (inst["id"], running)}
        rc, _out, err = run_cmd(["systemctl", "stop", inst["unit"]])
        if rc != 0:
            audit(svc["id"], inst["id"], "restart", "failed-stop:" + err, ip)
            return 500, {"error": "systemctl stop failed: %s" % err}
    if not wait_port_free(inst["port"]):
        audit(svc["id"], inst["id"], "restart", "port-busy", ip)
        return 502, {"error": "port %d still in use after stop" % inst["port"]}
    # v0.6.0: re-sync the GPU drop-in from spawn-state before starting.
    if svc["multi_instance"] and inst["index"] is not None:
        ensure_gpu_dropin(inst["unit"], spawn_state_gpus(svc["id"], inst["index"]))
    rc, _out, err = run_cmd(["systemctl", "start", inst["unit"]])
    if rc != 0:
        audit(svc["id"], inst["id"], "restart", "failed-start:" + err, ip)
        return 500, {"error": "systemctl start failed: %s" % err}
    if not wait_for_port(inst["port"], svc["probe_path"], PORT_COMEUP_WAIT):
        audit(svc["id"], inst["id"], "restart", "unit-up-port-down", ip)
        return 502, {"error": "unit started but port %d did not come up"
                             % inst["port"]}
    audit(svc["id"], inst["id"], "restart", "restarted", ip)
    return 200, {"action": "restart", "result": "restarted",
                 "instance": instance_detail(inst)}


def action_start_service(svc, ip):
    """Ensure the service's DEFAULT instance (index 0) is up. Idempotent."""
    inst = default_instance(svc)
    code, body = action_start_instance(inst, ip)
    result = body.get("result", "failed")
    audit(svc["id"], None, "service-start", result, ip)
    if code != 200:
        return code, body
    return 200, {"action": "start", "result": result,
                 "service": service_summary(svc)}


def action_stop_service(svc, force, ip):
    """Stop ALL active instances of the service (graceful guard per instance,
    skipped with ?force=1). Afterwards (v0.5.4) every spawned or non-default
    roster instance is FORGOTTEN, reusing the forget bookkeeping: spawn-state
    entries are dropped, config-declared extras are kept and the default
    index-0 instance stays listed as the service's single down row."""
    insts = [make_instance(svc, i) for i in active_indexes(svc)]
    if not force:
        busy = []
        for inst in insts:
            n = queue_running_count(inst["port"]) \
                if probe_port(inst["port"], svc["probe_path"]) else None
            if n:
                busy.append({"id": inst["id"], "jobs": n})
        if busy:
            names = ", ".join("%s (%d)" % (b["id"], b["jobs"]) for b in busy)
            audit(svc["id"], None, "service-stop", "refused-busy", ip)
            return 409, {"error": "generation running: %s; pass ?force=1 to stop "
                                  "anyway" % names}
    stopped, errors = [], []
    dropin_units = []  # template units of stopped instances (drop-in cleanup)
    for inst in insts:
        rc, _out, err = run_cmd(["systemctl", "stop", inst["unit"]])
        if rc != 0:
            errors.append({"id": inst["id"], "error": err})
        else:
            stopped.append(inst["id"])
            if svc["multi_instance"] and inst["index"] is not None:
                dropin_units.append(inst["unit"])
    if not errors:
        # v0.5.4 stop-all semantics: also FORGET every spawned / non-default
        # roster instance so the service ends up cleanly down in the UI.
        # Same bookkeeping as the forget endpoint: drop spawn-state entries
        # for every non-default index (remembered or running). Config-declared
        # extras are kept (no config rewrite) and index 0 is never forgotten
        # (the default instance stays listed as the single down row).
        known = set(load_state().get(svc["id"], {}))
        running_idxs = {i["index"] for i in insts}
        forgotten = []
        for idx in sorted((known | running_idxs) - {0}):
            iid = "%s-%d" % (svc["instance_prefix"], idx)
            forget_spawn_index(svc["id"], idx)
            dropin_units.append(svc["unit_template"].replace("{i}", str(idx)))
            audit(svc["id"], iid, "forget", "forgotten:spawn-state:auto-stop-all", ip)
            forgotten.append(iid)
        if 0 in known:  # index 0 is always listed anyway; empty the spawn state
            forget_spawn_index(svc["id"], 0)
            dropin_units.append(svc["unit_template"].replace("{i}", "0"))
        # v0.6.0: stop-all/forget must clear the runtime GPU drop-ins of the
        # stopped + forgotten indexes so freed indexes don't inherit stale
        # GPU assignments. One daemon-reload for the whole batch.
        removed = False
        for unit in dict.fromkeys(dropin_units):
            if sync_gpu_dropin(unit, None):
                removed = True
        if removed:
            run_cmd(["systemctl", "daemon-reload"])
        result = "stopped:%s" % ",".join(stopped) if stopped else "already-stopped"
        audit(svc["id"], None, "service-stop", result, ip)
        return 200, {"action": "stop", "result": "stopped" if stopped
                     else "already-stopped", "stopped": stopped,
                     "forgotten": forgotten,
                     "service": service_summary(svc)}
    audit(svc["id"], None, "service-stop", "partial:" +
          ";".join(e["id"] for e in errors), ip)
    return 500, {"error": "some instances failed to stop",
                 "stopped": stopped, "errors": errors}


def action_spawn(svc, gpus, ip):
    """Spawn a NEW multi-instance unit on the lowest free index:
    index = lowest i in 0..max-1 whose unit is not active, port =
    default_port + i; GPU set (v0.6.0): `gpus` None → the template's modulo
    default [i % NUM_GPUS] (v0.5.x behavior); a validated list pins
    CUDA_VISIBLE_DEVICES via a runtime drop-in written before start."""
    with _spawn_lock:
        used = set(active_indexes(svc))
        idx = next((i for i in range(svc["max_instances"]) if i not in used), None)
        if idx is None:
            audit(svc["id"], None, "spawn", "refused-max:%d" % svc["max_instances"], ip)
            return 409, {"error": "max instances reached (%d)" % svc["max_instances"]}
        inst = make_instance(svc, idx)
        n = num_gpus()
        if gpus is None:
            inst["gpus"] = [idx % n]
        else:
            inst["gpus"] = sorted(set(gpus))
            # pin the GPU set as a runtime drop-in, then pick the change up
            write_gpu_dropin(inst["unit"], inst["gpus"])
            run_cmd(["systemctl", "daemon-reload"])
        rc, _out, err = run_cmd(["systemctl", "start", inst["unit"]])
        if rc != 0:
            if gpus is not None:  # failed spawn: don't leave the pin behind
                ensure_gpu_dropin(inst["unit"], None)
            audit(svc["id"], inst["id"], "spawn", "failed:" + err, ip)
            return 500, {"error": "systemctl start failed: %s" % err}
        if not wait_for_port(inst["port"], svc["probe_path"], PORT_COMEUP_WAIT):
            audit(svc["id"], inst["id"], "spawn", "unit-up-port-down", ip)
            return 502, {"error": "unit started but port %d did not come up"
                                 % inst["port"]}
        remember_instance(svc["id"], idx,
                          inst["gpus"] if gpus is not None else None)
        audit(svc["id"], inst["id"], "spawn", "spawned:port=%d,gpus=%s"
              % (inst["port"], inst["gpus"]), ip)
        return 201, {"action": "spawn", "result": "spawned",
                     "instance": instance_detail(inst)}


def remove_extra_instance(svc_id, extra_id):
    """Remove an extra instance entry from config.json on disk (atomic
    rewrite, everything else preserved) and hot-reload the registry. Returns
    True on success, False if the service/entry is not in the on-disk file.
    Raises on unreadable/broken on-disk config."""
    with _config_lock:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            raw = json.load(f)
        svc = raw.get("services", {}).get(svc_id)
        if not isinstance(svc, dict):
            return False
        extras = svc.get("extra_instances", [])
        kept = [e for e in extras if not (isinstance(e, dict)
                                          and str(e.get("id")) == extra_id)]
        if len(kept) == len(extras):
            return False
        if kept:
            svc["extra_instances"] = kept
        else:
            svc.pop("extra_instances", None)
        tmp = CONFIG_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(raw, f, indent=2)
            f.write("\n")
        os.replace(tmp, CONFIG_PATH)
        global _config
        _config = load_config()  # hot-reload; raises if the rewrite is invalid
        return True


def action_forget_instance(inst, ip):
    """Forget a STOPPED instance (v0.5.3): spawned ones are dropped from the
    spawn-state (their index/port are free again); config-declared extras are
    removed from config.json (atomic rewrite + hot reload). The default
    instance (index 0) is never forgettable; a running instance is refused."""
    svc = inst["spec"]
    if inst["index"] == 0:  # covers single-instance services too
        audit(svc["id"], inst["id"], "forget", "refused-default", ip)
        return 409, {"error": "default instance cannot be forgotten"}
    if unit_is_active(inst["unit"]) or \
            probe_port(inst["port"], svc["probe_path"]):
        audit(svc["id"], inst["id"], "forget", "refused-running", ip)
        return 409, {"error": "instance is running"}
    if inst["index"] is None:
        # config-declared extra instance: remove it from config.json
        try:
            changed = remove_extra_instance(svc["id"], inst["id"])
        except (OSError, ValueError, TypeError) as exc:
            audit(svc["id"], inst["id"], "forget", "failed:" + str(exc), ip)
            return 500, {"error": "config rewrite failed: %s" % exc}
        if not changed:  # pragma: no cover — inst came from the live config
            audit(svc["id"], inst["id"], "forget", "not-in-config", ip)
            return 404, {"error": "unknown instance %r of service %r"
                                  % (inst["id"], svc["id"])}
        audit(svc["id"], inst["id"], "forget", "forgotten:config", ip)
    else:
        forget_spawn_index(svc["id"], inst["index"])
        # v0.6.0: free the index of its pinned GPU drop-in as well.
        ensure_gpu_dropin(inst["unit"], None)
        audit(svc["id"], inst["id"], "forget", "forgotten:spawn-state", ip)
    return 200, {"action": "forget", "result": "forgotten", "id": inst["id"]}


# --------------------------------------------------------------------------
# pi session aggregation (v0.7.0) — read-only views over the pi-sync repo
# --------------------------------------------------------------------------

PI_REPO_ENV = "ARTHUR_PI_REPO"
PI_STALE_SECS = 300      # updatedAt older than this → device entry stale
PI_TAIL_DEFAULT = 20     # default lines for the tail endpoint
PI_TAIL_MAX = 50         # hard cap on tail lines
PI_PREVIEW_CHARS = 120   # preview truncation for compacted tail entries
PI_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
# tail sandbox: only files directly under a user's pi sessions tree may be
# read — matched against the REALPATH of the status-recorded session path
PI_SESSIONS_SNDBOX_RE = re.compile(r"^/home/[^/]+/\.pi/agent/sessions/")


def pi_repo():
    """Root of the pi-sync mirror repo. Default ~/.pi/agent/pi-sync/repo;
    ARTHUR_PI_REPO overrides (test hook). The pi-sync 0.2.0 status pipe (via
    the pi-arthur extension) is the producer and is deployed independently —
    the agent must tolerate its absence (degradable, never fatal)."""
    root = os.environ.get(PI_REPO_ENV, "").strip()
    if root:
        return os.path.realpath(root)
    return os.path.join(os.path.expanduser("~"), ".pi", "agent",
                        "pi-sync", "repo")


def _pi_load_json(path):
    """Parsed dict from a JSON file, or None on any IO/parse problem."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def _pi_parse_ts(val):
    """ISO-8601 timestamp (Z or offset form) → aware datetime, else None."""
    if not isinstance(val, str) or not val.strip():
        return None
    try:
        t = val.strip()
        if t.endswith(("Z", "z")):
            t = t[:-1] + "+00:00"
        dt = datetime.fromisoformat(t)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _pi_device_entry(device, data):
    """Response entry for one <Device>.sessions.json. Contract:
    {device, hostname, updatedAt, sessions: [...], subagents: [...]}."""
    sessions = [s for s in data.get("sessions") if isinstance(s, dict)] \
        if isinstance(data.get("sessions"), list) else []
    subagents = [s for s in data.get("subagents") if isinstance(s, dict)] \
        if isinstance(data.get("subagents"), list) else []
    updated = _pi_parse_ts(data.get("updatedAt"))
    updated_raw = data.get("updatedAt")
    return {
        "device": device,
        "hostname": data.get("hostname")
                    if isinstance(data.get("hostname"), str) else None,
        "repoUpdatedAt": updated_raw if isinstance(updated_raw, str) else None,
        "sessionsCount": len(sessions),
        "activeSessions": sum(1 for s in sessions if s.get("active") is True),
        "subagentsRunning": sum(1 for s in subagents if s.get("state") == "running"),
        "sessions": sessions,
        "subagents": subagents,
        "stale": updated is None or
                 (datetime.now(timezone.utc) - updated).total_seconds() > PI_STALE_SECS,
    }


def pi_status():
    """GET /api/pi/status body: aggregate every status/<Device>.sessions.json
    in the pi-sync repo, with hostname merged in from devices/<Device>.json
    when present (the device-info file is the hostname authority). Missing
    repo or status/ → degradable 200 warning, never an error."""
    status_dir = os.path.join(pi_repo(), "status")
    if not os.path.isdir(status_dir):
        return {"devices": [], "generatedAt": _now_iso(),
                "warning": "pi-sync status unavailable"}
    devices = []
    for fn in sorted(os.listdir(status_dir)):
        if not fn.endswith(".sessions.json"):
            continue
        device = fn[:-len(".sessions.json")]
        data = _pi_load_json(os.path.join(status_dir, fn))
        if data is None:
            devices.append({"device": device, "hostname": None,
                            "repoUpdatedAt": None, "sessionsCount": 0,
                            "activeSessions": 0, "subagentsRunning": 0,
                            "sessions": [], "subagents": [], "stale": True,
                            "error": "unreadable status file"})
            continue
        entry = _pi_device_entry(device, data)
        dev_info = _pi_load_json(os.path.join(pi_repo(), "devices",
                                              "%s.json" % device))
        if dev_info and isinstance(dev_info.get("hostname"), str) \
                and dev_info["hostname"]:
            entry["hostname"] = dev_info["hostname"]
        devices.append(entry)
    return {"devices": devices, "generatedAt": _now_iso()}


def _pi_msg_preview(msg):
    """First ~PI_PREVIEW_CHARS of a message's text content (whitespace runs
    collapsed); toolResult messages are prefixed with their tool name."""
    def _texts(content):
        if isinstance(content, str):
            return [content]
        if isinstance(content, list):
            return [p.get("text") for p in content
                    if isinstance(p, dict) and isinstance(p.get("text"), str)]
        return []
    texts = [t for t in _texts(msg.get("content")) if t]
    text = " ".join(" ".join(t.split()) for t in texts)
    if msg.get("role") == "toolResult":
        name = msg.get("toolName") if isinstance(msg.get("toolName"), str) else None
        if not texts:
            return "%s: <no text>" % name if name else text
        return ("%s: %s" % (name, text[:PI_PREVIEW_CHARS])) \
            if name else text[:PI_PREVIEW_CHARS]
    return text[:PI_PREVIEW_CHARS]


def _pi_compact_entry(evt):
    """Session JSONL entry → the essentials: message entries become
    {type, role, preview, timestamp}; everything else {type, timestamp}.
    Returns None for entries without a type."""
    if not isinstance(evt, dict) or not isinstance(evt.get("type"), str):
        return None
    out = {"type": evt["type"]}
    if isinstance(evt.get("timestamp"), str):
        out["timestamp"] = evt["timestamp"]
    msg = evt.get("message")
    if evt["type"] == "message" and isinstance(msg, dict):
        if isinstance(msg.get("role"), str):
            out["role"] = msg["role"]
        out["preview"] = _pi_msg_preview(msg)
    return out


def pi_session_tail(device, session_id, n):
    """(code, body) for GET /api/pi/sessions/{device}/{sessionId}/tail.
    Resolves the session's JSONL path from the device's status file (repo
    data, never the request), then read-tails the last <=n lines as compacted
    entries. Path sandbox: matched against the RESOLVED path — only files
    under /home/*/.pi/agent/sessions/ may be read, so a tampered status file
    cannot point the tail at arbitrary files."""
    status_path = os.path.join(pi_repo(), "status", "%s.sessions.json" % device)
    if not os.path.isdir(os.path.dirname(status_path)):
        return 404, {"error": "pi-sync status unavailable"}
    if not os.path.isfile(status_path):
        return 404, {"error": "unknown device %r" % device}
    data = _pi_load_json(status_path)
    if data is None:
        return 500, {"error": "status file for %r is not valid JSON" % device}
    sessions = data.get("sessions") if isinstance(data.get("sessions"), list) else []
    entry = next((s for s in sessions if isinstance(s, dict)
                  and s.get("id") == session_id), None)
    if entry is None:
        return 404, {"error": "unknown session %r on device %r"
                              % (session_id, device)}
    raw = entry.get("path")
    if not isinstance(raw, str) or not os.path.isabs(raw):
        return 500, {"error": "session entry has no usable path"}
    path = os.path.realpath(raw)
    if not PI_SESSIONS_SNDBOX_RE.match(path):
        return 403, {"error": "session path is outside the sessions sandbox"}
    if not os.path.isfile(path):
        return 404, {"error": "session file not found"}
    recent = deque(maxlen=n)
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                if line.strip():
                    recent.append(line)
    except OSError as exc:
        return 500, {"error": "cannot read session file: %s" % exc}
    lines = []
    for line in recent:
        try:
            evt = json.loads(line)
        except ValueError:
            continue
        compact = _pi_compact_entry(evt)
        if compact is not None:
            lines.append(compact)
    return 200, {"device": device, "sessionId": session_id,
                 "count": len(lines), "lines": lines}


# --------------------------------------------------------------------------
# HTTP layer
# --------------------------------------------------------------------------

STATUS = {
    200: "OK", 201: "Created", 400: "Bad Request", 401: "Unauthorized",
    404: "Not Found", 405: "Method Not Allowed", 409: "Conflict",
    500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable",
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

    def read_json_body(self, limit=16384):
        """Optional JSON request body: None when empty, else the parsed value.
        Raises ValueError (→ 400 by the caller) on bad Content-Length or
        invalid JSON."""
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            raise ValueError("bad Content-Length header")
        if length <= 0:
            return None
        if length > limit:
            raise ValueError("request body too large (>%d bytes)" % limit)
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise ValueError("request body is not valid JSON")

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

    def service(self, svc_id):
        if not ID_RE.match(svc_id or ""):
            self.respond(400, {"error": "invalid service id"})
            return None
        svc = _config["services"].get(svc_id)
        if svc is None:
            self.respond(404, {"error": "unknown service %r" % svc_id})
            return None
        return svc

    def instance(self, svc, inst_id):
        inst = find_instance(svc, inst_id)
        if inst is None:
            self.respond(404, {"error": "unknown instance %r of service %r"
                                       % (inst_id, svc["id"])})
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
        force = query.get("force", ["0"])[0] in ("1", "true", "yes")

        if path == "/health":
            if verb != "GET":
                return self.respond(405, {"error": "method not allowed"})
            return self.respond(200, {"ok": True, "version": AGENT_VERSION})

        # everything below /api/ is token-gated
        if not path.startswith("/api/") and path != "/api":
            return self.respond(404, {"error": "not found"})
        if not self.authorized():
            return

        # ---- status / registry ----------------------------------------
        if path == "/api/gpus" and verb == "GET":
            gpus, err = gpu_stats()
            if gpus:
                return self.respond(200, {"gpus": gpus, "count": len(gpus)})
            # degradable, not fatal: still 200 with the failure reason
            return self.respond(200, {"gpus": [], "count": 0,
                                      "error": err or "nvidia-smi failed"})

        if path == "/api/status" and verb == "GET":
            return self.respond(200, {
                "version": AGENT_VERSION,
                "host_uptime": probe_host_uptime(),
                "services": [service_summary(s) for s in _config["services"].values()],
            })

        if path == "/api/services" and verb == "GET":
            # registry (config) merged with live state
            return self.respond(200, {
                "version": AGENT_VERSION,
                "services": [service_summary(s, detailed=True)
                             for s in _config["services"].values()],
            })

        m = re.match(r"^/api/services/([^/]+)$", path)
        if m and verb == "GET":
            svc = self.service(m.group(1))
            if svc is None:
                return
            return self.respond(200, service_summary(svc, detailed=True))

        # ---- service lifecycle ------------------------------------------
        m = re.match(r"^/api/services/([^/]+)/(start|stop)$", path)
        if m and verb == "POST":
            svc = self.service(m.group(1))
            if svc is None:
                return
            if m.group(2) == "start":
                return self.respond(*action_start_service(svc, self.client_ip()))
            return self.respond(*action_stop_service(svc, force, self.client_ip()))

        # ---- instances ---------------------------------------------------
        m = re.match(r"^/api/services/([^/]+)/instances$", path)
        if m and verb == "POST":
            svc = self.service(m.group(1))
            if svc is None:
                return
            if not svc["multi_instance"]:
                audit(svc["id"], None, "spawn", "refused-single-instance",
                      self.client_ip())
                return self.respond(409, {"error": "single-instance service"})
            # v0.6.0: optional {"gpus": [...]} body pins the instance's GPU
            # set; no body → the template modulo default (v0.5.x behavior).
            try:
                body = self.read_json_body()
            except ValueError as exc:
                return self.respond(400, {"error": str(exc)})
            gpus = None
            if body is not None:
                if not isinstance(body, dict):
                    return self.respond(400,
                                        {"error": "request body must be a "
                                                  "JSON object"})
                if "gpus" in body:
                    err = validate_gpus(body["gpus"])
                    if err is not None:
                        return self.respond(400, {"error": err})
                    gpus = list(body["gpus"])
            return self.respond(*action_spawn(svc, gpus, self.client_ip()))
        if m and verb == "GET":
            svc = self.service(m.group(1))
            if svc is None:
                return
            return self.respond(200, {"service": svc["id"],
                                      "instances": [instance_detail(i)
                                                    for i in service_instances(svc)]})

        m = re.match(r"^/api/services/([^/]+)/instances/([^/]+)$", path)
        if m and verb == "GET":
            svc = self.service(m.group(1))
            if svc is None:
                return
            inst = self.instance(svc, m.group(2))
            if inst is None:
                return
            return self.respond(200, instance_detail(inst))

        m = re.match(r"^/api/services/([^/]+)/instances/([^/]+)/(status)$", path)
        if m and verb == "GET":
            svc = self.service(m.group(1))
            if svc is None:
                return
            inst = self.instance(svc, m.group(2))
            if inst is None:
                return
            return self.respond(200, instance_detail(inst))

        m = re.match(r"^/api/services/([^/]+)/instances/([^/]+)"
                     r"/(start|stop|restart|forget)$", path)
        if m and verb == "POST":
            svc = self.service(m.group(1))
            if svc is None:
                return
            inst = self.instance(svc, m.group(2))
            if inst is None:
                return
            action = m.group(3)
            if action == "forget":
                code, body = action_forget_instance(inst, self.client_ip())
            else:
                code, body = (
                    action_start_instance(inst, self.client_ip()) if action == "start" else
                    action_stop_instance(inst, force, self.client_ip()) if action == "stop" else
                    action_restart_instance(inst, force, self.client_ip())
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

        # ---- pi session aggregation (v0.7.0) -----------------------------
        # read-only views over the pi-sync repo; NOT in the service registry
        # (pi sessions are not lifecycle-managed) and never audited (no mutations)
        if path == "/api/pi/status" and verb == "GET":
            return self.respond(200, pi_status())

        m = re.match(r"^/api/pi/sessions/([^/]+)/([^/]+)/tail$", path)
        if m and verb == "GET":
            device, sid = m.group(1), m.group(2)
            if not PI_NAME_RE.match(device) or not PI_NAME_RE.match(sid) \
                    or ".." in device or ".." in sid:
                return self.respond(400, {"error": "invalid device or session id"})
            try:
                n = int(query.get("lines", [str(PI_TAIL_DEFAULT)])[0])
            except ValueError:
                return self.respond(400, {"error": "lines must be an integer"})
            n = max(1, min(n, PI_TAIL_MAX))
            code, body = pi_session_tail(device, sid, n)
            return self.respond(code, body)

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
    load_state()  # touch once so corrupt state never surprises later
    bind, port = _config["bind"], _config["port"]
    httpd = ThreadingHTTPServer((bind, port), Handler)
    print("arthur-agent %s listening on %s:%d (config: %s, state: %s, audit: %s)"
          % (AGENT_VERSION, bind, port, CONFIG_PATH, STATE_PATH, AUDIT_PATH),
          flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
