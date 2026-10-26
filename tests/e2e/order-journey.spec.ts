import { expect, test } from '@playwright/test';

const PASSWORD = 'kitchos-demo-pass';

test('customer order flows through the kitchen to handoff, live', async ({ browser }) => {
  // ---- Customer orders a customised meal
  const customer = await browser.newPage();
  await customer.goto('/order/kitchos-central');
  await expect(customer.getByRole('heading', { name: 'Menu' })).toBeVisible();
  await customer.getByRole('button', { name: /Cheeseburger Meal/ }).click();

  const dialog = customer.getByRole('dialog', { name: 'Cheeseburger Meal' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('checkbox', { name: 'Extra cheese' }).check();
  await expect(dialog.getByRole('button', { name: /Add to order · \$13\.90/ })).toBeVisible();
  await dialog.getByRole('button', { name: /Add to order/ }).click();

  await expect(customer.getByText('1 × Cheeseburger Meal')).toBeVisible();
  await customer.getByLabel('Name for your order').fill('E2E Tester');
  await customer.screenshot({ path: 'test-results/screens/01-customer-cart.png', fullPage: true });
  await customer.getByRole('button', { name: 'Pay and place order' }).click();

  await customer.waitForURL(/\/order\/track\/[0-9a-f]{32}$/);
  const status = customer.getByTestId('order-status');
  await expect(status).toHaveText('Order received');
  await expect(customer.getByText('$13.90').first()).toBeVisible();
  const orderNumber = (
    await customer.getByLabel('Order progress').locator('..').locator('p.text-6xl').textContent()
  )?.trim();
  expect(orderNumber).toMatch(/^\d+$/);
  await customer.screenshot({
    path: 'test-results/screens/02-customer-tracking.png',
    fullPage: true,
  });

  // ---- Crew member signs in and works the kitchen display
  const crewContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const crew = await crewContext.newPage();
  await crew.goto('/staff');
  await crew.getByLabel('Email').fill('crew1@central.kitchos.test');
  await crew.getByLabel('Password').fill(PASSWORD);
  await crew.getByRole('button', { name: 'Sign in' }).click();
  await crew.getByRole('link', { name: 'Kitchen display' }).click();

  const ticket = crew
    .locator('li', { has: crew.getByText(`#${orderNumber}`, { exact: true }) })
    .first();
  await expect(ticket).toBeVisible();
  await expect(ticket.getByText('Extra cheese')).toBeVisible();
  await expect(ticket.getByRole('button', { name: 'Done' })).toHaveCount(3);
  await crew.screenshot({ path: 'test-results/screens/03-kitchen-display.png', fullPage: true });

  // Start the burger, then bump everything.
  await ticket
    .locator('li', { hasText: 'Cheeseburger (Cheeseburger Meal)' })
    .getByRole('button', { name: 'Start' })
    .click();
  await expect(status).toHaveText('Being prepared');
  for (let remaining = 3; remaining > 0; remaining--) {
    await ticket.getByRole('button', { name: 'Done' }).first().click();
    await expect(ticket.getByRole('button', { name: 'Done' })).toHaveCount(remaining - 1);
  }
  await expect(status).toHaveText('Ready for pickup');

  // ---- Public pickup board shows the number as ready
  const board = await browser.newPage();
  await board.goto('/pickup/kitchos-central');
  await expect(
    board
      .getByRole('region', { name: 'Ready to collect' })
      .getByText(orderNumber!, { exact: true }),
  ).toBeVisible();
  await board.screenshot({ path: 'test-results/screens/04-pickup-board.png' });

  // ---- Expo hands the order off exactly once
  await crew.goto('/staff');
  await crew.getByRole('link', { name: 'Expo & handoff' }).first().click();
  const expoCard = crew
    .locator('li', { has: crew.getByText(`#${orderNumber}`, { exact: true }) })
    .first();
  await expect(expoCard).toBeVisible();
  await crew.screenshot({ path: 'test-results/screens/05-expo.png', fullPage: true });
  await expoCard.getByRole('button', { name: 'Hand off' }).click();
  await expect(expoCard).toHaveCount(0);

  await expect(status).toHaveText('Collected');
  await customer.screenshot({
    path: 'test-results/screens/06-customer-collected.png',
    fullPage: true,
  });
});
