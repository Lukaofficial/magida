import { expect, test } from '@playwright/test';
import type { FrameLocator, Page } from '@playwright/test';

async function openDemo(page: Page) {
  await page.goto('/');
  const phone = page.frameLocator('[data-testid=phone-frame]');
  const kitchen = page.frameLocator('[data-testid=kitchen-frame]');
  await expect(phone.getByRole('heading', { name: 'Café Kalaki' })).toBeVisible();
  await expect(kitchen.getByTestId('column-new')).toBeVisible();
  return { phone, kitchen };
}

async function orderKhachapuri(phone: FrameLocator) {
  await phone.getByRole('button', { name: 'Add: Adjaruli khachapuri' }).click();
  await phone.getByTestId('view-basket').click();
  await phone.getByPlaceholder('Anything the kitchen').fill('no egg please');
  await phone.getByTestId('send-order').click();
}

test('an order goes from the phone to the kitchen, and progress comes back', async ({ page }) => {
  const { phone, kitchen } = await openDemo(page);
  await orderKhachapuri(phone);

  const ticket = kitchen.getByTestId('column-new').getByTestId('ticket');
  await expect(ticket).toContainText('Table 4');
  await expect(ticket).toContainText('Adjaruli khachapuri');
  await expect(ticket).toContainText('no egg please');
  await expect(phone.getByTestId('tracker')).toHaveAttribute('data-status', 'new');

  await ticket.getByRole('button', { name: 'Start' }).click();
  await expect(phone.getByTestId('tracker')).toHaveAttribute('data-status', 'preparing');

  await kitchen.getByTestId('column-preparing').getByRole('button', { name: 'Ready' }).click();
  await expect(phone.getByTestId('tracker')).toHaveAttribute('data-status', 'ready');

  await kitchen.getByTestId('column-ready').getByRole('button', { name: 'Served' }).click();
  await expect(phone.getByTestId('tracker')).toHaveAttribute('data-status', 'served');
  await expect(kitchen.getByTestId('ticket')).toHaveCount(0);
});

test('the menu works in Georgian', async ({ page }) => {
  const { phone } = await openDemo(page);
  await phone.getByRole('button', { name: 'Change language' }).click();
  await expect(phone.getByText('აჭარული ხაჭაპური')).toBeVisible();
  await expect(phone.getByText('მაგიდა 4')).toBeVisible();
});

test('marking something sold out changes the phone, and the owner sees sales update', async ({ page }) => {
  const { phone } = await openDemo(page);
  await page.getByTestId('tab-owner').click();
  const owner = page.frameLocator('[data-testid=owner-frame]');
  const revenue = owner.getByTestId('revenue-today');
  await expect(revenue).toBeVisible();
  const before = await revenue.textContent();

  await orderKhachapuri(phone);
  await expect(revenue).not.toHaveText(before!);

  await phone.getByRole('button', { name: 'Order something else' }).click();
  await owner.getByRole('checkbox', { name: 'Lobiani' }).check();
  const dish = phone.getByTestId('dish').filter({ hasText: 'Lobiani' });
  await expect(dish).toContainText('Sold out');
  await expect(dish.getByRole('button')).toHaveCount(0);
});

test('two visitors never see each other’s orders', async ({ page, browser }) => {
  const { phone } = await openDemo(page);
  await orderKhachapuri(phone);

  const context = await browser.newContext();
  const second = await context.newPage();
  const other = await openDemo(second);
  await expect(other.kitchen.getByTestId('ticket')).toHaveCount(0);
  await context.close();
});

test('staff screens ask for a PIN, and every table gets a QR code', async ({ browser }) => {
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto('/');
  const frame = visitor.locator('[data-testid=phone-frame]');
  await expect(frame).toHaveAttribute('src', /\/c\/demo-/);
  const slug = (await frame.getAttribute('src'))!.split('/')[2];

  const stranger = await (await browser.newContext()).newPage();
  await stranger.goto(`/c/${slug}/kitchen`);
  await expect(stranger.getByRole('heading', { name: 'Staff only' })).toBeVisible();
  await stranger.getByLabel('PIN').fill('0000');
  await stranger.getByRole('button', { name: 'Log in' }).click();
  await expect(stranger.getByRole('alert')).toContainText('Wrong PIN');
  await stranger.getByLabel('PIN').fill('1234');
  await stranger.getByRole('button', { name: 'Log in' }).click();
  await expect(stranger.getByTestId('column-new')).toBeVisible();

  await stranger.goto(`/c/${slug}/tables`);
  await expect(stranger.getByTestId('qr')).toHaveCount(12);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('a real customer can order without the page overflowing', async ({ page, request }) => {
    const { slug } = await (await request.post('/api/demo')).json();
    await page.goto(`/c/${slug}/t/2`);
    await page.getByRole('button', { name: 'Add: Espresso' }).click();
    await page.getByTestId('view-basket').click();
    await page.getByTestId('send-order').click();
    await expect(page.getByTestId('tracker')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  });
});

async function openBooking(page: Page) {
  const { kitchen } = await openDemo(page);
  await page.getByTestId('tab-book').click();
  const phone = page.frameLocator('[data-testid=booking-frame]');
  await expect(phone.getByTestId('reserve')).toBeVisible();
  await expect(phone.getByTestId('table-3')).toBeVisible();
  return { phone, kitchen };
}

test('booking a table on the map shows up for the owner, and can be cancelled', async ({ page }) => {
  const { phone } = await openBooking(page);
  await page.getByTestId('tab-floor').click();
  const floor = page.frameLocator('[data-testid=floor-frame]');
  await expect(floor.getByTestId('plan')).toBeVisible();

  const day = await phone.getByTestId('booking-date').locator('option').nth(1).getAttribute('value');
  await phone.getByTestId('booking-date').selectOption(day!);
  await phone.getByTestId('booking-time').selectOption('10:00');
  await phone.getByTestId('table-3').click();
  await phone.getByTestId('booking-name').fill('Ada');
  await phone.getByTestId('booking-phone').fill('+995 555 11 22 33');
  await phone.getByTestId('booking-confirm').click();
  await expect(phone.getByTestId('booking')).toHaveAttribute('data-status', 'confirmed');
  await expect(phone.getByTestId('booking')).toContainText('Ada');

  await floor.getByRole('combobox', { name: 'Which day' }).selectOption(day!);
  await expect(floor.getByTestId('bookings')).toContainText('Ada');
  await expect(floor.getByTestId('bookings')).toContainText('+995 555 11 22 33');

  await phone.getByTestId('booking-cancel').click();
  await expect(phone.getByTestId('booking')).toHaveAttribute('data-status', 'cancelled');
});

test('a table is greyed out for a taken time, and for a party too big for it', async ({ page }) => {
  const { phone } = await openBooking(page);
  const table = phone.getByTestId('table-1');
  await expect(table).toHaveClass(/plan__table--free/);
  await phone.getByRole('button', { name: 'More people' }).click();
  await expect(table).toHaveClass(/plan__table--small/);
  await table.click({ force: true });
  await expect(phone.getByTestId('booking-name')).toHaveCount(0);
});

test('a table being booked by someone else disappears from your map live', async ({ page, request }) => {
  const { phone } = await openBooking(page);
  const src = await page.locator('[data-testid=booking-frame]').getAttribute('src');
  const slug = src!.split('/')[2];
  const day = await phone.getByTestId('booking-date').locator('option').nth(1).getAttribute('value');
  await phone.getByTestId('booking-date').selectOption(day!);
  await phone.getByTestId('booking-time').selectOption('10:00');
  await phone.getByTestId('table-3').click();
  await expect(phone.getByTestId('booking-name')).toBeVisible();

  const plan = await (await request.get(`/api/c/${slug}/floor`)).json();
  const tableId = plan.tables.find((table: { number: number }) => table.number === 3).id;
  const taken = await request.post(`/api/c/${slug}/reservations`, {
    data: { tableId, partySize: 2, date: day, time: '10:00', name: 'Someone', phone: '+995 555 44 55 66', clientKey: 'someone-else-key' },
  });
  expect(taken.status()).toBe(201);
  await expect(phone.getByTestId('table-3')).toHaveClass(/plan__table--taken/);
  await expect(phone.getByRole('alert')).toContainText('Someone just booked');
});

test('an order lights up its table on the live floor plan', async ({ page }) => {
  const { phone } = await openDemo(page);
  await page.getByTestId('tab-floor').click();
  const floor = page.frameLocator('[data-testid=floor-frame]');
  await expect(floor.getByTestId('table-4')).toBeVisible();
  await orderKhachapuri(phone);
  await expect(floor.getByTestId('table-4')).toHaveClass(/plan__table--ordering/);
});

test('the owner can drag a table, and it moves for customers once saved', async ({ page }) => {
  const { phone } = await openBooking(page);
  await page.getByTestId('tab-floor').click();
  const floor = page.frameLocator('[data-testid=floor-frame]');
  await floor.getByTestId('floor-edit').click();
  await expect(floor.getByTestId('editor')).toBeVisible();
  await expect(floor.getByTestId('save-plan')).toBeDisabled();

  // Table 12 has clear floor to its left.
  const table = floor.getByTestId('table-12');
  const box = (await table.boundingBox())!;
  const plan = (await floor.getByTestId('plan').boundingBox())!;
  const cell = plan.width / 24;
  const before = (await phone.getByTestId('table-12').locator('.plan__top').getAttribute('cx'))!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - cell * 2, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();

  await expect(floor.getByTestId('save-plan')).toBeEnabled();
  await floor.getByTestId('save-plan').click();
  await expect(floor.getByTestId('floor-live')).toHaveAttribute('aria-pressed', 'true');
  await expect(phone.getByTestId('table-12').locator('.plan__top')).not.toHaveAttribute('cx', before);
});

test('the editor stops you saving overlapping tables, and removing a booked one', async ({ page }) => {
  await openDemo(page);
  await page.getByTestId('tab-floor').click();
  const floor = page.frameLocator('[data-testid=floor-frame]');
  await floor.getByTestId('floor-edit').click();

  await floor.getByRole('button', { name: 'Round, 2 seats' }).click();
  await expect(floor.getByTestId('plan-problem')).toContainText('overlap');
  await expect(floor.getByTestId('save-plan')).toBeDisabled();
  await floor.getByTestId('edit-remove').click();
  await expect(floor.getByTestId('plan-problem')).toHaveCount(0);

  // Table 6 has bookings coming up, from the demo data.
  await floor.getByTestId('table-6').click();
  await floor.getByTestId('edit-remove').click();
  await floor.getByTestId('save-plan').click();
  await expect(floor.getByTestId('save-error')).toContainText('upcoming bookings');
});
