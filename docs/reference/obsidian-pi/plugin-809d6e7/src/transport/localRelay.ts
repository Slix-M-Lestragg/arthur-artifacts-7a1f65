/**
 * Prefer-local routing (AUDIT FIX SLICE H) — pure URI/session matching for
 * `ahp-session:/ext-<device>-<instanceId>` resources published by a host agent.
 *
 * A host agent registers this machine's local pi instances with the AHP broker
 * as `kind:"external"` sessions whose resource is
 * `ahp-session:/ext-<hostAgentDeviceName>-<instanceId>`. When such a session
 * is opened from THIS device, attaching through the broker would self-relay
 * the local PTY back to us over the broker loop — instead it should open
 * directly as a local terminal (with session resume). These helpers identify
 * those own-device rows; the caller resolves the local instance and opens it.
 */

/** A successfully parsed own-device relay resource. */
export interface LocalRelayMatch {
  /** Device name the URI was matched against (original case). */
  device: string;
  /** Instance id from the URI, original case (e.g. `default`, `local-1`). */
  instanceId: string;
}

/**
 * Parse an `ahp-session:/ext-<device>-<instanceId>` resource against the given
 * device name (case-insensitive). Pure — no settings, no instance manager.
 * Returns null when the resource is not an ext- URI owned by `deviceName`.
 */
export function parseLocalRelayUri(resource: string, deviceName: string): LocalRelayMatch | null {
  const name = (deviceName ?? '').trim();
  if (!name || !resource) return null;
  const lowerResource = resource.toLowerCase();
  const prefix = `ahp-session:/ext-${name.toLowerCase()}-`;
  if (!lowerResource.startsWith(prefix)) return null;
  const instanceId = resource.slice(prefix.length);
  if (!instanceId) return null;
  return { device: name, instanceId };
}

/**
 * Match a catalogue session to an own-device relay/external row. Pure — the
 * caller resolves the instance id against its instance manager.
 *
 * External rows tell us their owning host directly (`hostAgentName`); relay
 * rows encode the device name only in the resource, so the device name is
 * tested against the local device's name either way.
 */
export function matchLocalRelaySession(
  session: Pick<SessionLike, 'resource' | 'hostAgentName'>,
  deviceName: string,
): LocalRelayMatch | null {
  const localDevice = (deviceName || 'Voyager').trim();
  const hostName = session.hostAgentName?.trim();
  const owner =
    hostName && hostName.toLowerCase() === localDevice.toLowerCase() ? hostName : localDevice;
  return parseLocalRelayUri(session.resource, owner);
}

/** Minimal structural subset of `SessionSummary` (avoids a transport cycle). */
export interface SessionLike {
  resource: string;
  hostAgentName?: string;
}