/**
 * constants — plugin-wide constant values with more than one consumer.
 *
 * Keep this module Node-free (no imports) so it is safe to load on mobile.
 */

/** Default WebSocket endpoint of the AHP (Farm View) server. */
export const DEFAULT_AHP_SERVER_URL = 'ws://localhost:4500';

/** Max option labels rendered as native notification action buttons (macOS UI gets crowded past this). */
export const MAX_NOTIFICATION_ACTIONS = 3;