import { expect, test, type Browser, type Page } from '@playwright/test';

async function signIn(browser: Browser, email: string) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  await page.goto('/staff');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('kitchos-demo-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  return page;
}

const onHand = async (page: Page, sku: string) =>
  (await page.locator(`tr[data-sku="${sku}"]`).getByTestId('on-hand').innerText()).trim();

/** Exact decimal difference in milli-units, without floats. */
const milli = (text: string) => {
  const [whole, frac = ''] = text.split('.');
  return Number(whole) * 1000 + Number(frac.padEnd(3, '0'));
};

async function openStock(page: Page) {
  await page.getByRole('button', { name: 'Stock levels' }).click();
  await expect(page.locator('tr[data-sku="BUN-REG"]')).toBeVisible();
}

test('waste from an order is capped by the line, and prepared food is recorded apart', async ({
  browser,
  request,
}) => {
  const api = 'http://localhost:4000/v1/public';
  const slug = 'kitchos-central';
  const menu = (await (await request.get(`${api}/restaurants/${slug}/menu`)).json()) as {
    items: { id: string; name: string }[];
  };
  const burger = menu.items.find((i) => i.name === 'Cheeseburger')!;
  const placed = await request.post(`${api}/restaurants/${slug}/orders`, {
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    data: {
      fulfilmentType: 'takeaway',
      customerName: 'Waste Journey',
      lines: [{ menuItemId: burger.id, quantity: 1 }],
    },
  });
  expect(placed.status()).toBe(201);
  const order = (await placed.json()) as { orderNumber: number; publicToken: string };
  const paid = await request.post(`${api}/orders/${order.publicToken}/payments`, {
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    data: { method: 'card', paymentToken: 'tok_sandbox_approve' },
  });
  expect(paid.ok()).toBe(true);

  const crew = await signIn(browser, 'crew2@central.kitchos.test');
  await crew.getByRole('link', { name: 'Inventory & waste' }).first().click();
  const form = crew.getByRole('form', { name: 'Record waste' });
  const result = crew.getByTestId('waste-result');

  const wasteLine = async () => {
    const orderSelect = form.getByLabel(/^Order/); // the label's text includes its options
    const option = orderSelect.locator('option', { hasText: `#${order.orderNumber} ` });
    await expect(option).toHaveCount(1);
    await orderSelect.selectOption({ value: (await option.getAttribute('value'))! });
    await form.getByLabel('Item on the order').selectOption({ label: '1 × Cheeseburger' });
    await form.getByLabel('Portions').fill('1');
    await form.getByLabel('Reason').selectOption({ label: 'Dropped' });
    await form.getByRole('button', { name: 'Record waste' }).click();
  };
  await crew.getByRole('button', { name: 'From an order' }).click();
  await wasteLine();
  await expect(result).toContainText('1 × Cheeseburger');
  await wasteLine();
  await expect(form.getByRole('alert')).toContainText('already been recorded as waste');

  await crew.getByRole('button', { name: 'Prepared food' }).click();
  await expect(form.getByText(/takes the ingredients from stock again/)).toBeVisible();
  await form.getByLabel('Menu item').selectOption({ label: 'Medium Fries' });
  await form.getByLabel('Portions').fill('2');
  await form.getByLabel('Reason').selectOption({ label: 'Overproduction' });
  await form.getByRole('button', { name: 'Record waste' }).click();
  await expect(result).toContainText('2 × Medium Fries');
});

test('crew waste, manager review, receiving and counting all change real stock', async ({
  browser,
}) => {
  const manager = await signIn(browser, 'manager@central.kitchos.test');
  await manager.getByRole('link', { name: 'Inventory & waste' }).first().click();
  await openStock(manager);
  const start = milli(await onHand(manager, 'BUN-REG'));

  // Crew see only waste entry: no stock levels, approvals, receiving or counting.
  const crew = await signIn(browser, 'crew1@central.kitchos.test');
  await crew.getByRole('link', { name: 'Inventory & waste' }).first().click();
  await expect(crew.getByRole('heading', { name: 'Record waste' })).toBeVisible();
  for (const hidden of ['Stock levels', 'Waste log', 'Receive goods', 'Stock count']) {
    await expect(crew.getByRole('button', { name: hidden })).toHaveCount(0);
  }

  // 2 buns at 45c: under the limit, so simply recorded.
  const form = crew.getByRole('form', { name: 'Record waste' });
  await form.getByLabel('Ingredient').selectOption({ label: 'Burger bun (each)' });
  await form.getByLabel(/^Quantity/).fill('2');
  await form.getByLabel('Reason').selectOption({ label: 'Dropped' });
  await form.getByRole('button', { name: 'Record waste' }).click();
  const result = crew.getByTestId('waste-result');
  await expect(result).toContainText('$0.90');
  await expect(result).toContainText('Recorded');
  await expect(crew.getByTestId('my-waste').first()).toContainText('Burger bun');

  // 60 buns at 45c = $27: above the $20 limit, so it needs a manager.
  await form.getByLabel('Ingredient').selectOption({ label: 'Burger bun (each)' });
  await form.getByLabel(/^Quantity/).fill('60');
  await form.getByLabel('Reason').selectOption({ label: 'Spoiled' });
  await form.getByRole('button', { name: 'Record waste' }).click();
  await expect(result).toContainText('$27.00');
  await expect(result).toContainText('a manager needs to review this');

  // The manager rejects it: the 60 buns come back, the 2 stay gone.
  await manager.reload();
  await manager.getByRole('button', { name: 'Waste log' }).click();
  const pending = manager
    .getByRole('region', { name: 'Needs approval' })
    .getByTestId('waste-record')
    .filter({ hasText: '60 × Burger bun' })
    .first();
  await expect(pending).toContainText('Needs approval');
  await pending.getByLabel('Review reason').fill('Recount found these fine');
  await pending.getByRole('button', { name: 'Reject' }).click();
  await expect(
    manager
      .getByRole('region', { name: 'Recent waste' })
      .getByTestId('waste-record')
      .filter({ hasText: 'Recount found these fine' })
      .first(),
  ).toContainText('Rejected');

  await openStock(manager);
  await expect.poll(async () => milli(await onHand(manager, 'BUN-REG'))).toBe(start - 2000);

  // Receive 10.5 buns' worth of stock with a lot and expiry.
  await manager.getByRole('button', { name: 'Receive goods' }).click();
  const receipt = manager.getByRole('form', { name: 'Receive goods' });
  await receipt.getByLabel('Supplier (optional)').fill('Bakers Delight');
  await receipt.getByLabel('Item').selectOption({ label: 'Burger bun (each)' });
  await receipt.getByLabel(/^Quantity/).fill('10.5');
  await receipt.getByLabel('Lot (optional)').fill('LOT-42');
  await receipt.getByRole('button', { name: 'Record delivery' }).click();
  await expect(manager.getByTestId('receipt-result')).toContainText('10.5 × Burger bun');

  await openStock(manager);
  const afterReceipt = start - 2000 + 10500;
  await expect.poll(async () => milli(await onHand(manager, 'BUN-REG'))).toBe(afterReceipt);

  // Count one item 1 short; every item left blank must stay untouched.
  const patties = await onHand(manager, 'PATTY-BEEF');
  await manager.getByRole('button', { name: 'Stock count' }).click();
  const count = manager.getByRole('form', { name: 'Stock count' });
  const countedBuns = afterReceipt - 1000;
  await count
    .getByLabel('Counted Burger bun')
    .fill(`${Math.trunc(countedBuns / 1000)}.${String(countedBuns % 1000).padStart(3, '0')}`);
  await count.getByRole('button', { name: 'Submit count (1)' }).click();
  await expect(manager.getByTestId('count-result')).toContainText('net variance -$0.45');

  await openStock(manager);
  await expect.poll(async () => milli(await onHand(manager, 'BUN-REG'))).toBe(countedBuns);
  expect(await onHand(manager, 'PATTY-BEEF')).toBe(patties);
  await manager.screenshot({ path: 'test-results/screens/11-inventory.png' });

  // All of it reaches the books, and they still reconcile.
  await manager.goto('/staff');
  await manager.getByRole('link', { name: 'Books' }).first().click();
  await expect(manager.getByTestId('reconciliation-status')).toHaveText('Reconciled', {
    timeout: 30_000,
  });
  await expect(manager.getByText('Goods received').first()).toBeVisible();
  await expect(manager.getByText('Stock count adjustment').first()).toBeVisible();
  await expect(manager.getByText('Waste reversed').first()).toBeVisible();
});
