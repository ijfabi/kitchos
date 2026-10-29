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

test('a short blind count waits for a manager, who approves the variance', async ({ browser }) => {
  const crew = await signIn(browser, 'crew2@central.kitchos.test');
  await crew.getByRole('link', { name: 'Point of sale' }).click();
  const ticket = crew.getByRole('complementary', { name: 'Current order' });
  await crew.getByTestId('drawer-button').click();
  const drawer = ticket.getByRole('region', { name: 'Cash drawer' });
  await drawer.getByRole('button', { name: /Till 2/ }).click();
  await drawer.getByLabel('Opening float').fill('100');
  await drawer.getByRole('button', { name: 'Open drawer' }).click();
  await expect(crew.getByTestId('drawer-button')).toHaveText('Till 2');

  // A $40 safe drop, then a blind count that comes up $20 short.
  await drawer.getByRole('button', { name: 'Safe drop' }).click();
  await drawer.getByLabel('Amount').fill('40');
  await drawer.getByLabel('Reason').fill('Mid-shift drop');
  await drawer.getByRole('button', { name: 'Record safe drop' }).click();
  await drawer.getByRole('button', { name: 'Count & close' }).click();
  await expect(drawer.getByText(/Expected \$/)).toHaveCount(0); // blind until submitted
  await drawer.getByLabel('Counted cash').fill('40');
  await drawer.getByRole('button', { name: 'Submit count' }).click();
  const result = drawer.getByTestId('count-result');
  await expect(result).toContainText('Expected $60.00');
  await expect(result).toContainText('a manager must approve');
  await expect(crew.getByTestId('drawer-button')).toHaveText('Drawer awaiting approval');

  const manager = await signIn(browser, 'manager@central.kitchos.test');
  await manager.getByRole('link', { name: 'Cash drawers' }).first().click();
  const card = manager
    .getByTestId('drawer-session')
    .filter({ hasText: 'Lachlan Reid' })
    .filter({ hasText: 'Needs approval' });
  await expect(card.getByTestId('variance')).toHaveText('-$20.00');
  await card.getByLabel('Approval notes').fill('Recounted with Lachlan, $20 short');
  await card.getByRole('button', { name: 'Approve variance' }).click();
  const closed = manager
    .getByTestId('drawer-session')
    .filter({ hasText: 'variance approved by Priya Natarajan' });
  await expect(closed.first()).toBeVisible();
  await expect(card).toHaveCount(0);
  await manager.screenshot({ path: 'test-results/screens/10-cash-drawers.png' });
});
