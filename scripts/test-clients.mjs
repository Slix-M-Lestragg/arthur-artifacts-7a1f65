#!/usr/bin/env node
/**
 * M1 live verification — exercises AiToolkitClient-shaped calls against the
 * live ai-toolkit server. No dependencies; uses node's global fetch via
 * scripts/lib/node-requester.mjs (same contract as src/api/transport.ts).
 *
 * Auth: reads AI_TOOLKIT_AUTH from the environment (the value ai-toolkit's
 * systemd unit would export; if the env var is unset the live service may run
 * unauthenticated — nothing is ever written anywhere).
 *
 * Usage: node scripts/test-clients.mjs [host] [port]
 */

import { parseComfyBinaryFrame } from "../src/comfy-frame.ts";
import { nodeFetchRequester, ensureOk } from "./lib/node-requester.mjs";

const host = process.argv[2] ?? "127.0.0.1";
const port = parseInt(process.argv[3] ?? "8675", 10);
const base = `http://${host}:${port}`;
const token = process.env.AI_TOOLKIT_AUTH || null;

const requester = nodeFetchRequester(token ? { Authorization: `Bearer ${token}` } : {});

// --- WS binary frame parser (M6) — pure unit test, runs offline ----------
// Frame: 4B BE event + payload. 1=PREVIEW_IMAGE (4B fmt code + bytes),
// 4=PREVIEW_IMAGE_WITH_METADATA (4B metaLen + meta JSON + bytes).
let frameTestFailures = 0;
function assertFrame(label, cond, detail = "") {
	if (!cond) {
		frameTestFailures++;
		console.log(`frame-parser FAIL ${label} ${detail}`);
	}
}
function u32be(n) {
	const b = new Uint8Array(4);
	new DataView(b.buffer).setUint32(0, n, false);
	return b;
}
function concat(...parts) {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const p of parts) { out.set(p, at); at += p.length; }
	return out;
}
const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xdb, 0x11, 0x22]);
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
{
	console.log("== WS binary frame parser (synthetic, offline) ==");
	// type 1: PREVIEW_IMAGE — fmt code 1 = JPEG, 2 = PNG
	const f1 = parseComfyBinaryFrame(concat(u32be(1), u32be(1), JPEG_MAGIC).buffer);
	assertFrame("t1-jpeg", f1?.mimeType === "image/jpeg" && f1?.event === 1 && f1?.data.length === JPEG_MAGIC.length,
		JSON.stringify({ mime: f1?.mimeType, len: f1?.data.length }));
	const f1p = parseComfyBinaryFrame(concat(u32be(1), u32be(2), PNG_MAGIC).buffer);
	assertFrame("t1-png", f1p?.mimeType === "image/png" && f1p?.data.length === PNG_MAGIC.length);
	// type 4: PREVIEW_IMAGE_WITH_METADATA — metaLen + meta JSON + raw image bytes
	const meta = new TextEncoder().encode(JSON.stringify({ node_id: "9", prompt_id: "abc" }));
	const f4 = parseComfyBinaryFrame(concat(u32be(4), u32be(meta.length), meta, JPEG_MAGIC).buffer);
	assertFrame("t4-meta", f4?.mimeType === "image/jpeg" && f4?.data.length === JPEG_MAGIC.length &&
		f4?.metadata?.node_id === "9" && f4?.metadata?.prompt_id === "abc",
		JSON.stringify({ mime: f4?.mimeType, len: f4?.data.length, meta: f4?.metadata }));
	// type 2: UNENCODED_PREVIEW_IMAGE — raw encoded bytes, MIME sniffed
	const f2 = parseComfyBinaryFrame(concat(u32be(2), PNG_MAGIC).buffer);
	assertFrame("t2-png", f2?.mimeType === "image/png" && f2?.data.length === PNG_MAGIC.length);
	// type 3 TEXT + unknown types + junk → null
	assertFrame("t3-text", parseComfyBinaryFrame(concat(u32be(3), new TextEncoder().encode("hello")).buffer) === null);
	assertFrame("t99-unknown", parseComfyBinaryFrame(concat(u32be(99), JPEG_MAGIC).buffer) === null);
	assertFrame("t1-bad-code", parseComfyBinaryFrame(concat(u32be(1), u32be(7), JPEG_MAGIC).buffer) === null);
	assertFrame("truncated", parseComfyBinaryFrame(new Uint8Array([0, 0, 0]).buffer) === null);
	assertFrame("t1-empty", parseComfyBinaryFrame(u32be(1).buffer) === null);
	assertFrame("t4-empty", parseComfyBinaryFrame(concat(u32be(4), u32be(0)).buffer) === null);
	const f4bad = parseComfyBinaryFrame(concat(u32be(4), u32be(2), new TextEncoder().encode("{}"), JPEG_MAGIC).buffer);
	assertFrame("t4-badmeta", f4bad?.mimeType === "image/jpeg" && f4bad?.data.length === JPEG_MAGIC.length);
	console.log(frameTestFailures === 0
		? "frame-parser: all checks passed"
		: `frame-parser: ${frameTestFailures} failure(s)`);
	if (frameTestFailures > 0) process.exitCode = 1;
}


async function get(path, params) {
	const search = params ? "?" + new URLSearchParams(params) : "";
	const resp = await requester.request({ url: base + path + search });
	await ensureOk(resp);
	return resp.json();
}

console.log(`== ai-toolkit ai-toolkit base: ${base} (auth: ${token ? "AI_TOOLKIT_AUTH env token" : "none/unauthenticated"})`);

// --- /api/jobs -------------------------------------------------------------
const jobsResp = await get("/api/jobs");
const jobs = jobsResp.jobs ?? [];
console.log(`api/jobs: ${jobs.length} job(s)`);

if (jobs.length > 0) {
	const first = jobs[0];
	console.log("first job field names:", Object.keys(first).join(", "));
	console.log("first job summary:", JSON.stringify(
		{
			id: first.id,
			name: first.name,
			gpu_ids: first.gpu_ids,
			status: first.status,
			step: first.step,
			total_steps: first.total_steps,
			speed_string: first.speed_string,
			queue_position: first.queue_position,
			pid: first.pid,
			job_type: first.job_type,
		},
		null,
		1,
	));

	// ---- /api/jobs/{id}/log — shape + offset/reset behavior ----------------
	try {
		const log = await get(`/api/jobs/${first.id}/log`, { offset: 0 });
		console.log(`api/jobs/{id}/log offset=0: keys=${Object.keys(log).join(",")} offset=${log.offset} reset=${log.reset} logLen=${(log.log ?? "").length}`);
		// incremental: follow-up from the returned offset must be empty + not reset
		const log2 = await get(`/api/jobs/${first.id}/log`, { offset: log.offset });
		console.log(`api/jobs/{id}/log incremental: offset=${log2.offset} reset=${log2.reset} logLen=${(log2.log ?? "").length} (expect empty/delta, reset=false)`);
		// reset path: offset beyond EOF → fresh tail + reset=true
		const log3 = await get(`/api/jobs/${first.id}/log`, { offset: log.offset + 100000 });
		console.log(`api/jobs/{id}/log past-EOF: offset=${log3.offset} reset=${log3.reset} logLen=${(log3.log ?? "").length} (expect reset=true, fresh tail)`);
	} catch (err) {
		console.log(`api/jobs/{id}/log: FAILED status=${err.status} msg=${err.message}`);
	}
	try {
		const zero = await get(`/api/jobs/${first.id}/loss`, { since_step: 0 });
		console.log(`api/jobs/{id}/loss: keys=${Object.keys(zero).join(",")} since_step=${zero.since_step}`);
		console.log(`  keys[]=${JSON.stringify(zero.keys)}`);
		for (const [k, s] of Object.entries(zero.series ?? {})) {
			console.log(`  series.${k}: steps=${s.steps.length} values=${s.values.length} lastStep=${s.steps.at(-1)} nullValues=${s.values.filter(v => v == null).length}`);
		}
		if (Object.keys(zero.series ?? {}).length === 0) {
			console.log("  (job has no loss_log.db data — empty shape confirmed)");
		} else {
			// incremental: re-request at the last step — only points at steps >= that returned
			const maxStep = Math.max(...Object.values(zero.series).map(s => s.steps.at(-1) ?? 0));
			const inc = await get(`/api/jobs/${first.id}/loss`, { since_step: maxStep });
			const incPts = Object.values(inc.series ?? {}).reduce((n, s) => n + s.steps.length, 0);
			console.log(`  incremental since_step=${maxStep}: total points=${incPts} (expect only step >= ${maxStep})`);
		}
	} catch (err) {
		console.log(`api/jobs/{id}/loss: FAILED status=${err.status} msg=${err.message}`);
	}
}

// --- /api/queue ------------------------------------------------------------
const queue = await get("/api/queue");
console.log("api/queue keys:", Object.keys(queue).join(", "));
console.log("api/queue queues:", JSON.stringify(queue.queues ?? queue));

// --- /api/gpu /api/cpu ------------------------------------------------------
const gpu = await get("/api/gpu");
console.log("api/gpu keys:", Object.keys(gpu).join(", "));
for (const g of gpu.gpus ?? []) {
	console.log(
		`  gpu${g.index}: ${g.name} mem free=${g.memory.free}/${g.memory.total}MB util=${g.utilization.gpu}% temp=${g.temperature}`,
	);
}
const cpu = await get("/api/cpu");
console.log(
	`api/cpu keys: ${Object.keys(cpu).join(", ")} (load=${cpu.currentLoad?.toFixed(1)}%, ramFree=${cpu.availableMemory}MB)`,
);

// --- ComfyUI (8188/8189) — probe only if already up -------------------------
console.log("\n== comfy probe (read-only, only if already up) ==");
for (const comfyPort of [8188, 8189]) {
	try {
		const r = await requester.request({ url: `http://${host}:${comfyPort}/system_stats` });
		await ensureOk(r);
		const stats = r.json();
		console.log(`comfy :${comfyPort}/system_stats: keys=${Object.keys(stats).join(",")} devices=${(stats.devices ?? []).length} — UP`);
		if (stats.devices?.[0]) {
			console.log(`  device keys: ${Object.keys(stats.devices[0]).join(",")} vram_free=${stats.devices[0].vram_free}`);
		}
		// queue + jobs shapes (read-only)
		const q = await (async () => {
			const qr = await requester.request({ url: `http://${host}:${comfyPort}/queue` });
			await ensureOk(qr);
			return qr.json();
		})();
		console.log(`comfy :${comfyPort}/queue: keys=${Object.keys(q).join(",")} running=${q.queue_running?.length} pending=${q.queue_pending?.length}`);
		const j = await (async () => {
			const jr = await requester.request({ url: `http://${host}:${comfyPort}/api/jobs?limit=2` });
			await ensureOk(jr);
			return jr.json();
		})();
		console.log(`comfy :${comfyPort}/api/jobs: keys=${Object.keys(j).join(",")} pagination=${JSON.stringify(j.pagination ?? null)}`);
	} catch (err) {
		console.log(`comfy :${comfyPort} DOWN/failed (status=${err.status}) — comfy live-test deferred (not started per instructions)`);
	}
}

console.log("\nDone.");
