import { DomainError } from './errors.ts';
import { assertCents, cents, divRoundHalfUp, type Cents } from './money.ts';

export interface CashSettlement {
  /** Amount the customer must hand over in cash (total rounded to the increment). */
  readonly payableCents: Cents;
  /** payable − total: negative when rounded down, positive when rounded up. */
  readonly roundingCents: Cents;
  readonly tenderedCents: Cents;
  readonly changeCents: Cents;
}

/**
 * Settles a cash payment. Cash totals round to the nearest `incrementCents`
 * (5 in Australia: 1–2c down, 3–4c up), half up on exact midpoints. Card
 * payments never round. The order total itself is not changed.
 */
export function settleCash(
  totalCents: number,
  tenderedCents: number,
  incrementCents: number,
): CashSettlement {
  assertCents(totalCents);
  assertCents(tenderedCents);
  if (!Number.isSafeInteger(incrementCents) || incrementCents < 1) {
    throw new Error(`Invalid cash rounding increment ${incrementCents}`);
  }
  if (totalCents < 0 || tenderedCents < 0) {
    throw new DomainError('AMOUNT_OUT_OF_RANGE', 'Amounts must not be negative');
  }
  const payable = cashPayableCents(totalCents, incrementCents);
  if (tenderedCents < payable) {
    throw new DomainError(
      'INSUFFICIENT_TENDER',
      `Cash tendered is less than the ${payable} cents due`,
      {
        payableCents: payable,
        tenderedCents,
      },
    );
  }
  return {
    payableCents: payable,
    roundingCents: cents(payable - totalCents),
    tenderedCents: cents(tenderedCents),
    changeCents: cents(tenderedCents - payable),
  };
}

/** Amount due when paying `totalCents` in cash: rounded to the nearest increment, half up. */
export function cashPayableCents(totalCents: number, incrementCents: number): Cents {
  assertCents(totalCents);
  if (!Number.isSafeInteger(incrementCents) || incrementCents < 1) {
    throw new Error(`Invalid cash rounding increment ${incrementCents}`);
  }
  const inc = BigInt(incrementCents);
  return cents(Number(divRoundHalfUp(BigInt(totalCents), inc) * inc));
}
