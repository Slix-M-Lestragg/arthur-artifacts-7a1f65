#!/usr/bin/env python3
"""arthur-agent — companion agent for the arthur Obsidian plugin.

Single-file Python 3 stdlib HTTP server (zero pip deps). Runs on the LAN
home server, token-gated, and drives a *service registry* of systemd units
(v0.5.4):

  services (from /etc/arthur-agent/config.json):
    comfyui    multi-instance  → template unit comfy@{i}
                 index i = lowest free index in 0..max_instances-1,
                 port = default_port + i, gpus = [i % NUM_GPUS]
                 (NUM_GPUS detected live via `nvidia-smi -L` at spawn time)
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

AGENT_VERSION = "0.5.4"

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
    File shape: {"comfyui": [0, 1, 2]}. Best-effort: unreadable → empty."""
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        known = data.get("known", {})
        if isinstance(known, dict):
            return {k: sorted(int(i) for i in v) for k, v in known.items()
                    if isinstance(v, list)}
    except (OSError, ValueError, TypeError):
        pass
    return {}


def remember_instance(svc_id, idx):
    """Record a spawned instance index so it survives restarts. Best-effort."""
    with _state_lock:
        state = load_state()
        idxs = state.setdefault(svc_id, [])
        if idx not in idxs:
            idxs.append(idx)
        state[svc_id] = sorted(idxs)
        try:
            os.makedirs(os.path.dirname(STATE_PATH), mode=0o755, exist_ok=True)
            tmp = STATE_PATH + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"known": state}, f)
            os.replace(tmp, STATE_PATH)
        except OSError:
            pass


def forget_spawn_index(svc_id, idx):
    """Drop a spawned instance index from the persisted state so the stopped
    instance disappears from listings and its index/port become free for a
    future spawn. Best-effort."""
    with _state_lock:
        state = load_state()
        idxs = state.get(svc_id)
        if idxs is None:
            return
        kept = [i for i in idxs if i != idx]
        if kept:
            state[svc_id] = kept
        else:
            state.pop(svc_id, None)
        try:
            os.makedirs(os.path.dirname(STATE_PATH), mode=0o755, exist_ok=True)
            tmp = STATE_PATH + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"known": state}, f)
            os.replace(tmp, STATE_PATH)
        except OSError:
            pass


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
        gpus = [idx % num_gpus()]
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
    known = set(load_state().get(svc["id"], []))
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
    for inst in insts:
        rc, _out, err = run_cmd(["systemctl", "stop", inst["unit"]])
        if rc != 0:
            errors.append({"id": inst["id"], "error": err})
        else:
            stopped.append(inst["id"])
    if not errors:
        # v0.5.4 stop-all semantics: also FORGET every spawned / non-default
        # roster instance so the service ends up cleanly down in the UI.
        # Same bookkeeping as the forget endpoint: drop spawn-state entries
        # for every non-default index (remembered or running). Config-declared
        # extras are kept (no config rewrite) and index 0 is never forgotten
        # (the default instance stays listed as the single down row).
        known = set(load_state().get(svc["id"], []))
        running_idxs = {i["index"] for i in insts}
        forgotten = []
        for idx in sorted((known | running_idxs) - {0}):
            iid = "%s-%d" % (svc["instance_prefix"], idx)
            forget_spawn_index(svc["id"], idx)
            audit(svc["id"], iid, "forget", "forgotten:spawn-state:auto-stop-all", ip)
            forgotten.append(iid)
        if 0 in known:  # index 0 is always listed anyway; empty the spawn state
            forget_spawn_index(svc["id"], 0)
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


def action_spawn(svc, ip):
    """Spawn a NEW multi-instance unit on the lowest free index:
    index = lowest i in 0..max-1 whose unit is not active, port =
    default_port + i, gpu = i % NUM_GPUS (detected live)."""
    with _spawn_lock:
        used = set(active_indexes(svc))
        idx = next((i for i in range(svc["max_instances"]) if i not in used), None)
        if idx is None:
            audit(svc["id"], None, "spawn", "refused-max:%d" % svc["max_instances"], ip)
            return 409, {"error": "max instances reached (%d)" % svc["max_instances"]}
        inst = make_instance(svc, idx)
        rc, _out, err = run_cmd(["systemctl", "start", inst["unit"]])
        if rc != 0:
            audit(svc["id"], inst["id"], "spawn", "failed:" + err, ip)
            return 500, {"error": "systemctl start failed: %s" % err}
        if not wait_for_port(inst["port"], svc["probe_path"], PORT_COMEUP_WAIT):
            audit(svc["id"], inst["id"], "spawn", "unit-up-port-down", ip)
            return 502, {"error": "unit started but port %d did not come up"
                                 % inst["port"]}
        remember_instance(svc["id"], idx)
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
        audit(svc["id"], inst["id"], "forget", "forgotten:spawn-state", ip)
    return 200, {"action": "forget", "result": "forgotten", "id": inst["id"]}


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
            return self.respond(*action_spawn(svc, self.client_ip()))
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
