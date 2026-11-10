import { assertCents, divRoundHalfUp } from './money.ts';

export interface FoodCostInput {
  /** Revenue less discounts and returns, ex GST. */
  netSalesCents: number;
  /**
   * Cost of food produced (COGS): what consumption used at standard cost. It
   * includes food later cancelled, comped or refunded, and is dated by when it
   * was made, not when it was sold.
   */
  cogsCents: number;
  wasteCents: number;
  /** Stock count shortfall; negative when a count found more than the books. */
  stockVarianceCents: number;
  /**
   * Recipe cost of what was sold: the cost at which sold lines were consumed, dated by the sale,
   * less refunded items on the day of the refund. Defaults to 0.
   */
  soldRecipeCents?: number;
}

export interface FoodCost extends Required<FoodCostInput> {
  /** What food actually cost: produced plus waste plus count shortfall. */
  actualFoodCostCents: number;
  /** Net sales less actual food cost. */
  grossProfitCents: number;
  /** Cost of food produced as a share of net sales, in basis points. */
  cogsBps: number | null;
  actualFoodCostBps: number | null;
  /** Gross profit as a share of net sales, in basis points. */
  grossMarginBps: number | null;
  /** Recipe cost of sales as a share of net sales: what the menu's recipes say food should cost. */
  theoreticalFoodCostBps: number | null;
  /** COGS less recipe cost of sales: produced but not sold that day; negative when sold later. */
  unsoldProductionCents: number;
}

/**
 * Food cost and gross profit from journal totals. Shares are basis points of
 * net sales, rounded half away from zero from exact integers. There is no
 * meaningful share of zero or negative sales, so those are null rather than
 * invented.
 */
export function foodCost(input: FoodCostInput): FoodCost {
  const { netSalesCents, cogsCents, wasteCents, stockVarianceCents } = input;
  const soldRecipeCents = input.soldRecipeCents ?? 0;
  for (const v of [netSalesCents, cogsCents, wasteCents, stockVarianceCents, soldRecipeCents]) {
    assertCents(v);
  }
  const actualFoodCostCents = cogsCents + wasteCents + stockVarianceCents;
  const grossProfitCents = netSalesCents - actualFoodCostCents;
  const bps = (amount: number) =>
    netSalesCents > 0
      ? Number(divRoundHalfUp(BigInt(amount) * 10_000n, BigInt(netSalesCents)))
      : null;
  return {
    ...input,
    soldRecipeCents,
    actualFoodCostCents,
    grossProfitCents,
    cogsBps: bps(cogsCents),
    actualFoodCostBps: bps(actualFoodCostCents),
    grossMarginBps: bps(grossProfitCents),
    theoreticalFoodCostBps: bps(soldRecipeCents),
    unsoldProductionCents: cogsCents - soldRecipeCents,
  };
}
