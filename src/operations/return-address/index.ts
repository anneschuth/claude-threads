/**
 * Return-address delivery — guaranteed replies back to the requester's thread.
 * See handler.ts for the rationale.
 */

export {
  getReturnDeliveryState,
  captureReturnAddress,
  noteEvent,
  onTurnComplete,
  cancelReturnDelivery,
  deliveryPending,
  buildDeliveryMessage,
  QUIESCENCE_MS,
  MAX_DELIVERY_ATTEMPTS,
} from './handler.js';

export { findReturnAddressUrl } from './parser.js';

export {
  createReturnDeliveryState,
  type ReturnAddress,
  type ReturnDeliveryState,
  type PersistedReturnDeliveryState,
  type DeliveryTarget,
} from './types.js';
