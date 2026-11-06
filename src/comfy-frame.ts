/**
 * Parser for ComfyUI's typed WS binary frames (live mid-generation previews).
 *
 * Frame layout (shape-verified against the ComfyUI source on the server:
 * protocol.py BinaryEventTypes + server.py send_image / send_image_with_metadata):
 *
 *   frame := 4-byte big-endian uint32 event + payload
 *
 *   1 PREVIEW_IMAGE              := 4B format code (1=JPEG, 2=PNG) + image bytes
 *   2 UNENCODED_PREVIEW_IMAGE    := raw encoded image bytes (legacy hook path)
 *   3 TEXT                       := utf-8 bytes — not an image, ignored
 *   4 PREVIEW_IMAGE_WITH_METADATA:= 4B metadata length + metadata JSON + image
 *                                  bytes (no format code — MIME is sniffed from
 *                                  the magic bytes FF D8 FF / 89 50 4E 47)
 *
 * Pure and dependency-free so node can load it directly for unit tests
 * (scripts/test-clients.mjs) without Obsidian or a bundler in the loop.
 */

export type ComfyBinaryEvent =
	| 1 // PREVIEW_IMAGE
	| 2 // UNENCODED_PREVIEW_IMAGE
	| 3 // TEXT
	| 4; // PREVIEW_IMAGE_WITH_METADATA

export interface ComfyBinaryFrame {
	/** "image/jpeg" | "image/png" — MIME for the Blob. */
	mimeType: string;
	/** Raw encoded image bytes (a view into the original ArrayBuffer). */
	data: Uint8Array<ArrayBuffer>;
	/** Frame event type (see ComfyBinaryEvent). */
	event: ComfyBinaryEvent;
	/** Metadata dict from type-4 frames (node_id, prompt_id, …). */
	metadata?: Record<string, unknown>;
}

/** Sniff JPEG/PNG magic bytes; null for anything else. */
export function sniffImageMime(bytes: Uint8Array): "image/jpeg" | "image/png" | null {
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "image/jpeg";
	}
	if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
		return "image/png";
	}
	return null;
}

/** Parse one WS binary frame; null for non-image / malformed frames. */
export function parseComfyBinaryFrame(buffer: ArrayBuffer): ComfyBinaryFrame | null {
	if (buffer.byteLength < 4) return null;
	const view = new DataView(buffer);
	const event = view.getUint32(0, false);

	switch (event) {
		case 1: { // PREVIEW_IMAGE: format code + image bytes
			if (buffer.byteLength < 8) return null;
			const code = view.getUint32(4, false);
			const mime = code === 1 ? "image/jpeg" : code === 2 ? "image/png" : null;
			if (!mime) return null;
			return { mimeType: mime, data: new Uint8Array(buffer, 8), event: 1 };
		}
		case 2: { // UNENCODED_PREVIEW_IMAGE: raw encoded image bytes
			const data = new Uint8Array(buffer, 4);
			const mime = sniffImageMime(data);
			if (!mime) return null;
			return { mimeType: mime, data, event: 2 };
		}
		case 4: { // PREVIEW_IMAGE_WITH_METADATA: metaLen + meta JSON + image bytes
			if (buffer.byteLength < 8) return null;
			const metaLen = view.getUint32(4, false);
			const imgStart = 8 + metaLen;
			if (imgStart >= buffer.byteLength) return null;
			let metadata: Record<string, unknown> | undefined;
			try {
				const json = new TextDecoder("utf-8").decode(new Uint8Array(buffer, 8, metaLen));
				const parsed = JSON.parse(json);
				if (parsed !== null && typeof parsed === "object") metadata = parsed;
			} catch {
				// Bad metadata JSON — still fine to render the image itself.
			}
			const data = new Uint8Array(buffer, imgStart);
			const mime = sniffImageMime(data);
			if (!mime) return null;
			return { mimeType: mime, data, event: 4, metadata };
		}
		default: // 3 (TEXT) and anything unknown — not renderable
			return null;
	}
}
