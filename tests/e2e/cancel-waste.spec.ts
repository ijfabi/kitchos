import { expect, test } from '@playwright/test';

const API = 'http://localhost:4000/v1';

test('cancelling a cooked order records its food as waste, with the count the manager chose', async ({
  browser,
  request,
}) => {
  const slug = 'kitchos-central';
  const menu = (await (await request.get(`${API}/public/restaurants/${slug}/menu`)).json()) as {
    items: { id: string; name: string }[];
  };
  const burger = menu.items.find((i) => i.name === 'Cheeseburger')!;
  const placed = await request.post(`${API}/public/restaurants/${slug}/orders`, {
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    data: {
      fulfilmentType: 'takeaway',
      customerName: 'Cancel Journey',
      lines: [{ menuItemId: burger.id, quantity: 2 }],
    },
  });
  expect(placed.status()).toBe(201);
  const order = (await placed.json()) as { id: string; orderNumber: number; publicToken: string };
  const paid = await request.post(`${API}/public/orders/${order.publicToken}/payments`, {
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    data: { method: 'card', paymentToken: 'tok_sandbox_approve' },
  });
  expect(paid.ok()).toBe(true);

  // The kitchen starts it: the burgers are cooked (consumed).
  const crewLogin = await request.post(`${API}/auth/login`, {
    data: { email: 'crew1@central.kitchos.test', password: 'kitchos-demo-pass' },
  });
  const { accessToken: crewToken } = (await crewLogin.json()) as { accessToken: string };
  const auth = { Authorization: `Bearer ${crewToken}` };
  const me = (await (await request.get(`${API}/me`, { headers: auth })).json()) as {
    restaurants: { id: string; slug: string }[];
  };
  const central = me.restaurants.find((r) => r.slug === slug)!;
  const tasks = (await (
    await request.get(`${API}/restaurants/${central.id}/kitchen/tasks`, { headers: auth })
  ).json()) as { id: string; orderId: string }[];
  for (const t of tasks.filter((x) => x.orderId === order.id)) {
    const started = await request.post(
      `${API}/restaurants/${central.id}/kitchen/tasks/${t.id}/start`,
      {
        headers: auth,
        data: {},
      },
    );
    expect(started.ok()).toBe(true);
  }

  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  await page.goto('/staff');
  await page.getByLabel('Email').fill('manager@central.kitchos.test');
  await page.getByLabel('Password').fill('kitchos-demo-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Expo & handoff' }).first().click();

  const card = page.locator(`li[data-order-id="${order.id}"]`);
  await card.getByRole('button', { name: 'Cancel' }).click();
  const form = page.getByRole('form', { name: `Cancel order ${order.orderNumber}` });
  await form.getByLabel('Cancel reason').fill('Customer left before pickup');
  // Both burgers are prefilled as waste; one went to another customer.
  const count = form.getByLabel('Cheeseburger');
  await expect(count).toHaveValue('2');
  await count.fill('1');
  await form.getByRole('button', { name: 'Cancel order' }).click();
  await expect(card).toHaveCount(0);

  // The waste log shows exactly what was chosen, as cancelled after preparation.
  await page.goto('/staff');
  await page.getByRole('link', { name: 'Inventory & waste' }).first().click();
  await page.getByRole('button', { name: 'Waste log' }).click();
  const record = page
    .getByRole('region', { name: 'Recent waste' })
    .locator(`[data-testid="waste-record"][data-order-id="${order.id}"]`)
    .filter({ hasText: `Order #${order.orderNumber} cancelled` });
  await expect(record).toHaveCount(1);
  await expect(record).toContainText('1 × Cheeseburger');
  await expect(record).toContainText('Cancelled after preparation');
  await page.screenshot({ path: 'test-results/screens/14-cancel-waste.png' });
});
