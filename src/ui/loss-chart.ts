/**
 * Hand-rolled SVG line chart for training loss series — plain DOM, no deps.
 * One polyline per metric key from a fixed palette; minimal axis text
 * (min/max step at the bottom corners, min/max loss at the left edge).
 *
 * Pure render function: takes accumulated series data, draws once into the
 * given container (the caller empties/rebuilds on refresh). Rebuilt per poll
 * tick while the chart panel is expanded; a full redraw keeps the code simple.
 */

import { el } from "../util";

export interface LossSeries {
	steps: number[];
	values: Array<number | null>;
}

/** Palette for the first N metric keys (drawn in series order). */
const COLORS = ["#7aa2f7", "#9ece6a", "#f7768e", "#e0af68", "#b4f9f8", "#c3a6ff", "#ff9e64", "#73daca"];

const NS = "http://www.w3.org/2000/svg";
const W = 900;
const H = 220;
const padL = 8;
const padR = 8;
const padT = 12;
const padB = 18;

function svgEl(tag: string, attrs: Record<string, string | number>, text?: string): SVGElement {
	const node = document.createElementNS(NS, tag);
	for (const [key, value] of Object.entries(attrs)) {
		node.setAttribute(key, String(value));
	}
	if (text !== undefined) node.textContent = text;
	return node;
}

/** Compact value label: 4 significant digits. */
function fmtVal(v: number): string {
	if (!Number.isFinite(v)) return "?";
	const abs = Math.abs(v);
	if (abs >= 10000 || (abs !== 0 && abs < 0.001)) return v.toExponential(2);
	return String(parseFloat(v.toPrecision(4)));
}

/** Render loss series into `root` (emptied first); shows a note when empty. */
export function renderLossChart(
	root: HTMLElement,
	series: Array<{ key: string; data: LossSeries }>,
): void {
	root.empty();

	// Legend row — one entry per metric key, in render order.
	const legend = root.createEl("div", { cls: "arthur-chart-legend" });
	for (let i = 0; i < series.length; i++) {
		legend.append(
			el("span", {
				cls: "arthur-legend-item",
				children: [
					el("span", {
						cls: "arthur-legend-swatch",
						attrs: { style: `background:${COLORS[i % COLORS.length]}` },
					}),
					document.createTextNode(series[i].key),
				],
			}),
		);
	}

	// Compute non-null point segments per series.
	const plot = series.map((s) => {
		const segs: Array<Array<[number, number]>> = [];
		let cur: Array<[number, number]> = [];
		for (let j = 0; j < s.data.steps.length; j++) {
			const v = s.data.values[j];
			if (typeof v !== "number" || !Number.isFinite(v)) {
				if (cur.length > 1) segs.push(cur);
				cur = [];
				continue;
			}
			cur.push([s.data.steps[j], v]);
		}
		if (cur.length > 1) segs.push(cur);
		return { color: COLORS[series.indexOf(s) % COLORS.length], segs };
	});

	if (!plot.some((p) => p.segs.length > 0)) {
		root.createEl("div", {
			cls: "arthur-note",
			text: "no loss data recorded yet",
		});
		return;
	}

	const all = plot.flatMap((p) => p.segs).flat();
	const xMin = Math.min(...all.map((p) => p[0]));
	const xMax = Math.max(...all.map((p) => p[0]));
	const yMin = Math.min(...all.map((p) => p[1]));
	const yMax = Math.max(...all.map((p) => p[1]));

	const sx = (step: number): number =>
		padL + (W - padL - padR) * (xMax === xMin ? 0.5 : (step - xMin) / (xMax - xMin));
	const sy = (v: number): number =>
		padT + (H - padT - padB) * (1 - (yMax === yMin ? 0.5 : (v - yMin) / (yMax - yMin)));

	const svg = svgEl("svg", {
		cls: "arthur-chart-svg",
		viewBox: `0 0 ${W} ${H}`,
		role: "img",
		"aria-label": "training loss chart",
	});
	for (const { color, segs } of plot) {
		for (const seg of segs) {
			svg.append(svgEl("polyline", {
				points: seg.map(([s, v]) => `${sx(s).toFixed(1)},${sy(v).toFixed(1)}`).join(" "),
				fill: "none",
				stroke: color,
				"stroke-width": 1.5,
			}));
		}
	}
	// Minimal axes: step range at the bottom corners, loss range at the left.
	const axis = { "font-size": 10, fill: "currentColor", opacity: 0.6 };
	svg.append(
		svgEl("text", { ...axis, x: padL, y: H - 4, "text-anchor": "start" }, `step ${xMin}`),
		svgEl("text", { ...axis, x: W - padR, y: H - 4, "text-anchor": "end" }, String(xMax)),
		svgEl("text", { ...axis, x: 2, y: H - padB, "text-anchor": "start" }, fmtVal(yMin)),
		svgEl("text", { ...axis, x: 2, y: padT, "text-anchor": "start" }, fmtVal(yMax)),
	);
	root.append(svg);
}
