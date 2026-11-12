import { expect, test, type APIRequestContext } from '@playwright/test';

const API = 'http://localhost:4000/v1';

/** Same output as formatAud in @kitchos/domain. */
const aud = (cents: number) => {
  const abs = Math.abs(cents);
  const dollars = Math.trunc(abs / 100).toLocaleString('en-AU');
  return `${cents < 0 ? '-' : ''}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
};

async function token(request: APIRequestContext, email: string) {
  const res = await request.post(`${API}/auth/login`, {
    data: { email, password: 'kitchos-demo-pass' },
  });
  const body = (await res.json()) as { data?: { accessToken: string }; accessToken?: string };
  return body.data?.accessToken ?? body.accessToken!;
}

test('a supervisor runs a shift across a cashier’s drawer, and closes it once counted', async ({
  browser,
  request,
}) => {
  // Drive: no other journey trades there, so its shift holds only this drawer.
  const crew = await token(request, 'crew1@drive.kitchos.test');
  const supervisorApi = await token(request, 'supervisor@drive.kitchos.test');
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const me = (await (await request.get(`${API}/me`, { headers: auth(crew) })).json()) as {
    restaurants: { id: string; slug: string }[];
  };
  const drive = me.restaurants.find((r) => r.slug === 'kitchos-drive')!;
  const base = `${API}/restaurants/${drive.id}`;

  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  await page.goto('/staff');
  await page.getByLabel('Email').fill('supervisor@drive.kitchos.test');
  await page.getByLabel('Password').fill('kitchos-demo-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Shift' }).first().click();
  await page.getByRole('button', { name: 'Open a shift' }).click();
  const shift = page.getByRole('region', { name: 'Current shift' });
  await expect(shift.getByTestId('shift-status')).toHaveText('Open');

  // The cashier opens a drawer and takes a cash sale.
  const drawers = (await (
    await request.get(`${base}/cash/drawers`, { headers: auth(crew) })
  ).json()) as {
    id: string;
    activeSession: unknown;
  }[];
  const session = (await (
    await request.post(
      `${base}/cash/drawers/${drawers.find((d) => !d.activeSession)!.id}/sessions`,
      {
        headers: auth(crew),
        data: { openingFloatCents: 10_000 },
      },
    )
  ).json()) as { id: string };
  const menu = (await (
    await request.get(`${API}/public/restaurants/kitchos-drive/menu`)
  ).json()) as {
    items: { id: string; name: string }[];
  };
  const order = (await (
    await request.post(`${base}/orders`, {
      headers: { ...auth(crew), 'Idempotency-Key': crypto.randomUUID() },
      data: {
        fulfilmentType: 'takeaway',
        lines: [
          { menuItemId: menu.items.find((i) => i.name === 'Cheeseburger Meal')!.id, quantity: 1 },
        ],
      },
    })
  ).json()) as { id: string; totalCents: number };
  const paid = await request.post(`${base}/orders/${order.id}/payments`, {
    headers: { ...auth(crew), 'Idempotency-Key': crypto.randomUUID() },
    data: { method: 'cash', tenderedCents: order.totalCents + 1000 },
  });
  expect(paid.status()).toBe(200);
  const cashTaken = (
    (await paid.json()) as { payment: { amountCents: number; cashRoundingCents: number } }
  ).payment;

  // Uncounted: the shift cannot close, and cash stays hidden.
  await page.reload();
  await expect(shift.getByTestId('shift-blockers')).toContainText('Jack Thompson');
  await expect(shift.getByTestId('shift-cash')).toHaveText('After counts');
  await expect(shift.getByRole('button', { name: 'Close shift' })).toBeDisabled();

  // The cashier counts exactly (the supervisor, not the cashier, can see what is expected).
  const expected = (
    (await (
      await request.get(`${base}/cash/sessions/${session.id}`, { headers: auth(supervisorApi) })
    ).json()) as {
      expected: { expectedCents: number };
    }
  ).expected.expectedCents;
  const counted = await request.post(`${base}/cash/sessions/${session.id}/count`, {
    headers: { ...auth(crew), 'Idempotency-Key': crypto.randomUUID() },
    data: { countedCents: expected },
  });
  expect(counted.status()).toBe(200);

  await page.reload();
  await expect(shift.getByTestId('shift-blockers')).toHaveCount(0);
  await expect(shift.getByTestId('shift-cash')).toHaveText(
    aud(cashTaken.amountCents + cashTaken.cashRoundingCents),
  );
  await shift.getByLabel('Handover notes').fill('All tills counted, quiet lunch');
  await shift.getByRole('button', { name: 'Close shift' }).click();

  const earlier = page.getByRole('region', { name: /Shift closed at/ }).first();
  await expect(earlier.getByTestId('shift-status')).toHaveText('Closed');
  await expect(earlier).toContainText('All tills counted, quiet lunch');
  await expect(
    earlier
      .locator('[data-testid="shift-person"][data-person="Jack Thompson"]')
      .getByTestId('person-sales'),
  ).toHaveText(aud(order.totalCents));
  await expect(page.getByRole('button', { name: 'Open a shift' })).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/14-shift-close.png' });
});
