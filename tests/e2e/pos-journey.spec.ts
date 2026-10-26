import { expect, test } from '@playwright/test';

test('crew rings up a cash sale with change, then parks, recalls and card-pays an order', async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  await page.goto('/staff');
  await page.getByLabel('Email').fill('crew1@central.kitchos.test');
  await page.getByLabel('Password').fill('kitchos-demo-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Point of sale' }).click();
  await expect(page.getByRole('heading', { name: 'Point of sale' })).toBeVisible();

  const products = page.getByRole('region', { name: 'Products' });
  // Customisable item opens the modifier dialog.
  await products.getByRole('button', { name: /^Cheeseburger\s*\$7\.90/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Cheeseburger' });
  await dialog.getByRole('checkbox', { name: 'No onion' }).check();
  await dialog.getByRole('button', { name: /Add to order/ }).click();
  // Plain item goes straight onto the ticket.
  await products.getByRole('button', { name: /^Medium Cola/ }).click();

  const ticket = page.getByRole('complementary', { name: 'Current order' });
  await expect(ticket.getByText('1 × Cheeseburger')).toBeVisible();
  await expect(ticket.getByText('No onion')).toBeVisible();
  await expect(page.getByTestId('pos-total')).toHaveText('$12.10');

  await ticket.getByRole('button', { name: 'Cash' }).click();
  await expect(page.getByTestId('cash-due')).toHaveText('$12.10');
  await ticket.getByRole('button', { name: '$20.00' }).click();
  await page.screenshot({ path: 'test-results/screens/07-pos-cash.png' });
  await ticket.getByRole('button', { name: 'Take cash' }).click();
  await expect(page.getByTestId('change-due')).toHaveText('$7.90');
  await expect(ticket.getByText(/^#\d+$/)).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/08-pos-change.png' });
  await ticket.getByRole('button', { name: 'New sale' }).click();

  // Park an order, recall it, take a card payment.
  await products.getByRole('button', { name: /^Medium Fries/ }).click();
  await page.getByLabel('Customer name or table').fill('Table 9');
  await ticket.getByRole('button', { name: 'Park' }).click();
  await expect(page.getByTestId('pos-total')).toHaveText('$0.00');
  await ticket.getByText(/Parked orders/).click();
  const parkedRow = ticket.locator('li', { hasText: 'Table 9' }).last();
  await parkedRow.getByRole('button', { name: 'Recall' }).click();
  await expect(page.getByTestId('pos-total')).toHaveText('$4.50');
  await ticket.getByRole('button', { name: 'Card' }).click();
  await expect(ticket.getByText(/Paid by visa/)).toBeVisible();
  await ticket.getByRole('button', { name: 'New sale' }).click();
  await expect(ticket.locator('li', { hasText: 'Table 9' })).toHaveCount(0);
});

test('a discount above the crew limit is approved by a manager at the terminal', async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  await page.goto('/staff');
  await page.getByLabel('Email').fill('crew1@central.kitchos.test');
  await page.getByLabel('Password').fill('kitchos-demo-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Point of sale' }).click();

  const products = page.getByRole('region', { name: 'Products' });
  await products.getByRole('button', { name: /^Cheeseburger Meal/ }).click();
  await page
    .getByRole('dialog', { name: 'Cheeseburger Meal' })
    .getByRole('button', { name: /Add to order/ })
    .click();
  const ticket = page.getByRole('complementary', { name: 'Current order' });

  await ticket.getByRole('button', { name: 'Discount' }).click();
  await ticket.getByLabel('Discount percent').fill('50');
  await ticket.getByLabel('Discount reason').selectOption('customer_service');
  await ticket.getByRole('button', { name: 'Apply discount' }).click();

  const approval = ticket.getByRole('form', { name: 'Manager approval' });
  await expect(approval.getByText('Manager approval for $6.45 off')).toBeVisible();
  await approval.getByLabel('Manager email').fill('manager@central.kitchos.test');
  await approval.getByLabel('Manager password').fill('kitchos-demo-pass');
  await approval.getByRole('button', { name: 'Approve discount' }).click();

  await expect(page.getByTestId('discount-line')).toContainText('approved by Priya Natarajan');
  await expect(page.getByTestId('pos-total')).toHaveText('$6.45');
  await page.screenshot({ path: 'test-results/screens/09-pos-discount.png' });
  await ticket.getByRole('button', { name: 'Card' }).click();
  await expect(ticket.getByText('Paid by visa · $6.45')).toBeVisible();
});
