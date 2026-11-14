import { expect, test, type APIRequestContext } from '@playwright/test';

const API = 'http://localhost:4000/v1';
const SLUG = 'kitchos-central';

/** A paid, cooked and handed-over order, made through the real API. */
async function finishedOrder(request: APIRequestContext, name: string, quantity: number) {
  const menu = (await (await request.get(`${API}/public/restaurants/${SLUG}/menu`)).json()) as {
    items: { id: string; name: string }[];
  };
  const placed = await request.post(`${API}/public/restaurants/${SLUG}/orders`, {
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    data: {
      fulfilmentType: 'takeaway',
      customerName: 'Item Refund',
      lines: [{ menuItemId: menu.items.find((i) => i.name === name)!.id, quantity }],
    },
  });
  const order = (await placed.json()) as { id: string; orderNumber: number; publicToken: string };
  await request.post(`${API}/public/orders/${order.publicToken}/payments`, {
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    data: { method: 'card', paymentToken: 'tok_sandbox_approve' },
  });
  const login = await request.post(`${API}/auth/login`, {
    data: { email: 'crew1@central.kitchos.test', password: 'kitchos-demo-pass' },
  });
  const auth = {
    Authorization: `Bearer ${((await login.json()) as { accessToken: string }).accessToken}`,
  };
  const me = (await (await request.get(`${API}/me`, { headers: auth })).json()) as {
    restaurants: { id: string; slug: string }[];
  };
  const rid = me.restaurants.find((r) => r.slug === SLUG)!.id;
  const tasks = (await (
    await request.get(`${API}/restaurants/${rid}/kitchen/tasks`, { headers: auth })
  ).json()) as { id: string; orderId: string }[];
  for (const t of tasks.filter((x) => x.orderId === order.id)) {
    await request.post(`${API}/restaurants/${rid}/kitchen/tasks/${t.id}/complete`, {
      headers: auth,
      data: {},
    });
  }
  const handed = await request.post(`${API}/restaurants/${rid}/orders/${order.id}/handoff`, {
    headers: auth,
  });
  expect(handed.ok()).toBe(true);
  return order;
}

test('a manager refunds one item at its price, it counts as waste, and replaces another', async ({
  browser,
  request,
}) => {
  const order = await finishedOrder(request, 'Cheeseburger', 3);

  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  await page.goto('/staff');
  await page.getByLabel('Email').fill('manager@central.kitchos.test');
  await page.getByLabel('Password').fill('kitchos-demo-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Orders & refunds' }).first().click();

  const card = page.locator(`[data-testid="order-card"][data-order-id="${order.id}"]`);
  await card.getByRole('button', { name: 'Refund', exact: true }).click();
  const form = card.getByRole('form', { name: /Refund order/ });
  // By item is the default: one of three burgers at its share of the line ($7.90 each).
  await form.getByLabel(/Cheeseburger/).fill('1');
  await form.getByLabel('Refund reason').selectOption('quality');
  await form.getByRole('button', { name: 'Refund $7.90' }).click();
  await expect(card.getByText(/\$7\.90 card refund \(quality\).*1 × Cheeseburger/)).toBeVisible();

  // Another burger is replaced rather than refunded.
  await card.getByRole('button', { name: 'Refund', exact: true }).click();
  await expect(form.getByText('(2 of 3 left)')).toBeVisible();
  await form.getByRole('button', { name: 'Replace' }).click();
  await expect(form.getByText(/Recorded as waste, and a fresh one made/)).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/15-item-refund.png' });

  // Both count as waste: the refunded burger and the replaced one.
  await page.goto('/staff');
  await page.getByRole('link', { name: 'Inventory & waste' }).first().click();
  await page.getByRole('button', { name: 'Waste log' }).click();
  const records = page
    .getByRole('region', { name: 'Recent waste' })
    .locator(`[data-testid="waste-record"][data-order-id="${order.id}"]`)
    .filter({ hasText: /Cheeseburger/ });
  await expect(records.filter({ hasText: `Order #${order.orderNumber} refunded` })).toHaveCount(1);
  await expect(records.filter({ hasText: 'Remade for the same order' }).first()).toBeVisible();
});
