/**
 * User Attribution Module
 *
 * Composes the per-message `[@username]:` sender prefix applied at the
 * send boundary for every genuine user turn.
 */

export { formatUserTurn, shouldAttribute } from './formatter.js';
