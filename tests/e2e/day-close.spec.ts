import { expect, test, type Browser } from '@playwright/test';

async function signIn(browser: Browser, email: string) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  await page.goto('/staff');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('kitchos-demo-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  return page;
}

test('a manager sees why today cannot close, and closes an ended day exactly once', async ({
  browser,
}) => {
  const manager = await signIn(browser, 'manager@central.kitchos.test');
  await manager.getByRole('link', { name: 'Day close' }).first().click();
  await expect(manager.getByRole('heading', { name: 'Day close' })).toBeVisible();

  // Starts on yesterday. Pick a day this journey owns: closed days stay closed between runs.
  const dayInput = manager.getByLabel('Business day');
  await expect(dayInput).not.toHaveValue('');
  const yesterday = await dayInput.inputValue();
  const offset = 2 + (Date.now() % 3000);
  const d = new Date(`${yesterday}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - offset);
  const target = d.toISOString().slice(0, 10);

  // Today is not over: it shows the reason and the button stays off.
  const t = new Date(`${yesterday}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  await dayInput.fill(t.toISOString().slice(0, 10));
  await expect(manager.getByTestId('day-blockers')).toContainText('has not ended');
  await expect(manager.getByRole('button', { name: 'Close this day' })).toBeDisabled();

  await dayInput.fill(target);
  await expect(manager.getByTestId('day-status')).toHaveText('Open');
  await manager.getByLabel('Close notes').fill('Journey close');
  await manager.getByRole('button', { name: 'Close this day' }).click();
  await expect(manager.getByTestId('day-status')).toHaveText('Closed');
  await expect(manager.getByText(/Closed by Priya Natarajan/)).toContainText('Journey close');
  await expect(manager.getByRole('button', { name: 'Close this day' })).toHaveCount(0);
  await manager.screenshot({ path: 'test-results/screens/12-day-close.png' });

  // Still closed after a reload: this came from the database, not the page.
  await manager.reload();
  await manager.getByLabel('Business day').fill(target);
  await expect(manager.getByTestId('day-status')).toHaveText('Closed');
});

test('a manager adds a drawer that crew can then use, and retires it', async ({ browser }) => {
  const manager = await signIn(browser, 'manager@central.kitchos.test');
  await manager.getByRole('link', { name: 'Cash drawers' }).first().click();
  const admin = manager.getByRole('region', { name: 'Manage drawers' });
  const code = `e2e-${Date.now() % 1_000_000}`;
  await admin.getByLabel('Drawer name').fill(`Till ${code}`);
  await admin.getByLabel('Drawer code').fill(code);
  await admin.getByRole('button', { name: 'Add drawer' }).click();
  const row = admin.getByTestId('admin-drawer').filter({ hasText: code });
  await expect(row).toBeVisible();

  const crew = await signIn(browser, 'supervisor@central.kitchos.test');
  await crew.getByRole('link', { name: 'Point of sale' }).click();
  await crew.getByTestId('drawer-button').click();
  await expect(crew.getByRole('button', { name: new RegExp(code) })).toBeVisible();

  await row.getByRole('button', { name: 'Retire' }).click();
  await expect(row).toContainText('Retired');
  await crew.reload();
  await crew.getByTestId('drawer-button').click();
  await expect(crew.getByRole('button', { name: /Till 1/ })).toBeVisible();
  await expect(crew.getByRole('button', { name: new RegExp(code) })).toHaveCount(0);
});
