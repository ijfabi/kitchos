/**
 * A violated business rule. `code` is stable and machine-readable; the API
 * layer maps codes to HTTP statuses. Never throw DomainError for programmer
 * errors — those should crash loudly.
 */
export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export type DomainErrorCode =
  | 'INVALID_STATE_TRANSITION'
  | 'MENU_ITEM_NOT_FOUND'
  | 'MENU_ITEM_UNAVAILABLE'
  | 'MODIFIER_NOT_FOUND'
  | 'MODIFIER_SELECTION_INVALID'
  | 'COMBO_COMPONENT_INVALID'
  | 'INVALID_QUANTITY'
  | 'INSUFFICIENT_STOCK'
  | 'AMOUNT_OUT_OF_RANGE'
  | 'CONCURRENT_MODIFICATION'
  | 'INSUFFICIENT_TENDER'
  | 'DISCOUNT_INVALID'
  | 'UNBALANCED_JOURNAL';
