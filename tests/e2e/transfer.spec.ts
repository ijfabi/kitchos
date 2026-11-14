import { expect, test, type Browser, type Page } from '@playwright/test';

async function signIn(browser: Browser, email: string) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  await page.goto('/staff');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('kitchos-demo-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Inventory & waste' }).first().click();
  return page;
}

/** On-hand burger buns in milli-units, read from the stock screen (exact, no floats). */
async function buns(page: Page) {
  await page.getByRole('button', { name: 'Stock levels' }).click();
  await expect(page.locator('tr[data-sku]').first()).toBeVisible();
  // A restaurant that has never held the item has no row for it.
  const row = page.locator('tr[data-sku="BUN-REG"]');
  if ((await row.count()) === 0) return 0;
  const text = (await row.getByTestId('on-hand').innerText()).trim();
  const [whole, frac = ''] = text.split('.');
  const sign = whole!.startsWith('-') ? -1 : 1;
  return sign * (Math.abs(Number(whole)) * 1000 + Number(frac.padEnd(3, '0')));
}

test('one restaurant sends stock, the other records what arrived and the shortage', async ({
  browser,
}) => {
  const note = `Weekend top-up ${Date.now()}`;
  const sender = await signIn(browser, 'manager@central.kitchos.test');
  const sentFrom = await buns(sender);
  await sender.getByRole('button', { name: 'Transfers' }).click();
  const form = sender.getByRole('form', { name: 'Send stock' });
  await form.getByLabel('Send to').selectOption({ label: 'KitchOS Express' });
  await form.getByLabel('Item').selectOption({ label: 'Burger bun (each)' });
  await form.getByLabel(/^Quantity/).fill('12');
  await form.getByLabel('Notes (optional)').fill(note);
  await form.getByRole('button', { name: 'Send stock' }).click();
  await expect(sender.getByTestId('transfer-sent')).toContainText('Sent to KitchOS Express');
  expect(await buns(sender)).toBe(sentFrom - 12_000);

  const receiver = await signIn(browser, 'manager@express.kitchos.test');
  const before = await buns(receiver);
  await receiver.getByRole('button', { name: 'Transfers' }).click();
  // Other runs may have left transfers waiting; this one carries our note.
  const arrival = receiver
    .getByRole('form', { name: 'Receive transfer from KitchOS Central' })
    .filter({ hasText: note });
  await expect(arrival.getByLabel('Burger bun received')).toHaveValue('12');
  await arrival.getByLabel('Burger bun received').fill('11');
  await arrival.getByLabel('Notes (optional)').fill('One bun squashed');
  await arrival.getByRole('button', { name: 'Record arrival' }).click();
  const recent = receiver
    .getByTestId('transfer-row')
    .filter({ hasText: 'From KitchOS Central' })
    .first();
  await expect(recent).toContainText('Received');
  await expect(recent.getByTestId('shortage')).toContainText('short');
  await receiver.screenshot({ path: 'test-results/screens/16-stock-transfer.png' });
  expect(await buns(receiver)).toBe(before + 11_000);
});

test('the sender cancels a transfer before it arrives, and the stock is back on its shelf', async ({
  browser,
}) => {
  const note = `Wrong store ${Date.now()}`;
  const sender = await signIn(browser, 'manager@central.kitchos.test');
  const start = await buns(sender);
  await sender.getByRole('button', { name: 'Transfers' }).click();
  const form = sender.getByRole('form', { name: 'Send stock' });
  await form.getByLabel('Send to').selectOption({ label: 'KitchOS Express' });
  await form.getByLabel('Item').selectOption({ label: 'Burger bun (each)' });
  await form.getByLabel(/^Quantity/).fill('5');
  await form.getByLabel('Notes (optional)').fill(note);
  await form.getByRole('button', { name: 'Send stock' }).click();
  await expect(sender.getByTestId('transfer-sent')).toContainText('Sent to KitchOS Express');

  const card = sender.getByTestId('outgoing-transfer').filter({ hasText: note });
  await expect(card).toContainText('5 each Burger bun');
  await card.getByRole('button', { name: 'Cancel transfer' }).click();
  const cancel = card.getByRole('form', { name: 'Cancel transfer to KitchOS Express' });
  await expect(
    cancel.getByRole('button', { name: 'Cancel transfer and return stock' }),
  ).toBeDisabled();
  await cancel.getByLabel('Reason').fill('Sent to the wrong store');
  await cancel.getByRole('button', { name: 'Cancel transfer and return stock' }).click();
  await expect(card).toHaveCount(0);
  await expect(
    sender.getByTestId('transfer-row').filter({ hasText: 'To KitchOS Express' }).first(),
  ).toContainText('Cancelled');
  await sender.screenshot({ path: 'test-results/screens/17-transfer-cancelled.png' });
  expect(await buns(sender)).toBe(start);

  // It never reaches the receiver's Arriving list.
  const receiver = await signIn(browser, 'manager@express.kitchos.test');
  await receiver.getByRole('button', { name: 'Transfers' }).click();
  await expect(receiver.getByRole('heading', { name: 'Arriving' })).toBeVisible();
  await expect(
    receiver
      .getByRole('form', { name: 'Receive transfer from KitchOS Central' })
      .filter({ hasText: note }),
  ).toHaveCount(0);
});
