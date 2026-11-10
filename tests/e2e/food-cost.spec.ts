import { expect, test } from '@playwright/test';

const API = 'http://localhost:4000/v1';

/** Same output as formatAud in @kitchos/domain, sign included (this package does not depend on it). */
const aud = (cents: number) => {
  const abs = Math.abs(cents);
  const dollars = Math.trunc(abs / 100).toLocaleString('en-AU');
  return `${cents < 0 ? '-' : ''}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
};

test('the food cost screen shows what the books hold for each day', async ({
  browser,
  request,
}) => {
  const signIn = await request.post(`${API}/auth/login`, {
    data: { email: 'manager@central.kitchos.test', password: 'kitchos-demo-pass' },
  });
  const token = (await signIn.json()) as { data?: { accessToken: string }; accessToken?: string };
  const accessToken = token.data?.accessToken ?? token.accessToken!;
  const restaurants = (await (
    await request.get(`${API}/me`, { headers: { Authorization: `Bearer ${accessToken}` } })
  ).json()) as { restaurants: { id: string; slug: string }[] };
  const central = restaurants.restaurants.find((r) => r.slug === 'kitchos-central')!;
  const { businessDate } = (await (
    await request.get(`${API}/restaurants/${central.id}/accounting/business-date`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
  ).json()) as { businessDate: string };

  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  await page.goto('/staff');
  await page.getByLabel('Email').fill('manager@central.kitchos.test');
  await page.getByLabel('Password').fill('kitchos-demo-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Food cost' }).first().click();
  await expect(page.getByRole('heading', { name: 'Food cost' })).toBeVisible();

  // Seven days, ending today.
  await expect(page.getByTestId('food-cost-day')).toHaveCount(7);
  const todayRow = page.locator(`[data-testid="food-cost-day"][data-day="${businessDate}"]`);
  await expect(todayRow).toBeVisible();

  // The screen shows exactly what the API reports from the journal.
  const api = (await (
    await request.get(
      `${API}/restaurants/${central.id}/reports/food-cost?from=${businessDate}&to=${businessDate}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
  ).json()) as { days: { netSalesCents: number; soldRecipeCents: number }[] };
  // The dev API posts events in the background: reload so the page reads the same state.
  await page.reload();
  await expect(page.getByTestId('food-cost-day')).toHaveCount(7);
  await expect(todayRow.getByTestId('net-sales')).toHaveText(aud(api.days[0]!.netSalesCents));
  await expect(todayRow.getByTestId('sold-recipe')).toHaveText(aud(api.days[0]!.soldRecipeCents));

  // An impossible range is caught before asking the server.
  await page
    .getByLabel('From')
    .fill(`${Number(businessDate.slice(0, 4)) + 1}${businessDate.slice(4)}`);
  await expect(page.getByText('The start date is after the end date')).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/13-food-cost.png' });
});
