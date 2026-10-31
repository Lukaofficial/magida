import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Cafe, Order, Stats } from '../shared/types.ts';
import { createApp } from './app.ts';
import { openDatabase } from './db.ts';
import { deleteOldDemoCafes } from './repo.ts';

const db = openDatabase(':memory:');
let server: Server;
let base = '';

beforeAll(async () => {
  server = createApp({ db, orderLimit: 10_000, demoLimit: 10_000 }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

async function newCafe() {
  const response = await fetch(`${base}/api/demo`, { method: 'POST' });
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  const { slug } = (await response.json()) as { slug: string };
  const cafe = (await (await fetch(`${base}/api/c/${slug}`)).json()) as Cafe;
  const staff = (path: string, init: RequestInit = {}) =>
    fetch(`${base}/api/c/${slug}${path}`, { ...init, headers: { 'Content-Type': 'application/json', cookie } });
  return { slug, cafe, cookie, staff, firstItem: cafe.categories[0].items[0], allItems: cafe.categories.flatMap((category) => category.items) };
}

let keys = 0;
function order(slug: string, body: Record<string, unknown>) {
  return fetch(`${base}/api/c/${slug}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tableNumber: 4, clientKey: `test-key-${++keys}`, ...body }),
  });
}

describe('placing an order', () => {
  it('saves it, with the total worked out by the server', async () => {
    const { slug, firstItem } = await newCafe();
    const response = await order(slug, { items: [{ itemId: firstItem.id, quantity: 2 }], note: 'no egg' });
    expect(response.status).toBe(201);
    const placed = (await response.json()) as Order;
    expect(placed.totalTetri).toBe(firstItem.priceTetri * 2);
    expect(placed.status).toBe('new');
    expect(placed.note).toBe('no egg');
  });

  it('ignores any price sent by the browser', async () => {
    const { slug, firstItem } = await newCafe();
    const response = await order(slug, { items: [{ itemId: firstItem.id, quantity: 1, priceTetri: 1 }], totalTetri: 1 });
    expect(((await response.json()) as Order).totalTetri).toBe(firstItem.priceTetri);
  });

  it('creates one order when the same request is sent twice', async () => {
    const { slug, firstItem, staff } = await newCafe();
    const body = { items: [{ itemId: firstItem.id, quantity: 1 }], clientKey: 'double-tap-key' };
    const first = await order(slug, body);
    const second = await order(slug, body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(((await second.json()) as Order).publicId).toBe(((await first.json()) as Order).publicId);
    expect(((await (await staff('/orders')).json()) as Order[])).toHaveLength(1);
  });

  it.each([
    ['an empty order', { items: [] }],
    ['a table that does not exist', { tableNumber: 99, items: [{ itemId: 1, quantity: 1 }] }],
    ['a negative quantity', { items: [{ itemId: 1, quantity: -3 }] }],
    ['an absurd quantity', { items: [{ itemId: 1, quantity: 5000 }] }],
    ['a fractional quantity', { items: [{ itemId: 1, quantity: 1.5 }] }],
  ])('refuses %s', async (_name, body) => {
    const { slug } = await newCafe();
    expect((await order(slug, body)).status).toBe(400);
  });

  it('refuses an item from another cafe', async () => {
    const one = await newCafe();
    const other = await newCafe();
    expect((await order(one.slug, { items: [{ itemId: other.firstItem.id, quantity: 1 }] })).status).toBe(400);
  });

  it('refuses something that has sold out, and says which', async () => {
    const { slug, firstItem, staff } = await newCafe();
    await staff(`/items/${firstItem.id}`, { method: 'PATCH', body: JSON.stringify({ soldOut: true }) });
    const response = await order(slug, { items: [{ itemId: firstItem.id, quantity: 1 }] });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { itemIds: number[] }).itemIds).toEqual([firstItem.id]);
  });

  it('keeps the old price on an old order', async () => {
    const { slug, firstItem } = await newCafe();
    const placed = (await (await order(slug, { items: [{ itemId: firstItem.id, quantity: 1 }] })).json()) as Order;
    db.prepare('UPDATE items SET price_tetri = 1 WHERE id = ?').run(firstItem.id);
    const again = (await (await fetch(`${base}/api/orders/${placed.publicId}`)).json()) as Order;
    expect(again.lines[0].priceTetri).toBe(firstItem.priceTetri);
  });
});

describe('the kitchen', () => {
  it('needs a login', async () => {
    const { slug } = await newCafe();
    expect((await fetch(`${base}/api/c/${slug}/orders`)).status).toBe(401);
    expect((await fetch(`${base}/api/c/${slug}/stats`)).status).toBe(401);
  });

  it('can’t be reached with a login for a different cafe', async () => {
    const one = await newCafe();
    const other = await newCafe();
    const response = await fetch(`${base}/api/c/${other.slug}/orders`, { headers: { cookie: one.cookie } });
    expect(response.status).toBe(401);
  });

  it('rejects a forged cookie', async () => {
    const { slug } = await newCafe();
    const response = await fetch(`${base}/api/c/${slug}/orders`, { headers: { cookie: 'magida_staff=1.9999999999999.abc' } });
    expect(response.status).toBe(401);
  });

  it('logs in with the right PIN only', async () => {
    const { slug } = await newCafe();
    const attempt = (pin: string) =>
      fetch(`${base}/api/c/${slug}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
    expect((await attempt('0000')).status).toBe(401);
    expect((await attempt('1234')).status).toBe(200);
  });

  it('moves an order through each step', async () => {
    const { slug, firstItem, staff } = await newCafe();
    const placed = (await (await order(slug, { items: [{ itemId: firstItem.id, quantity: 1 }] })).json()) as Order;
    for (const status of ['preparing', 'ready', 'served']) {
      const response = await staff(`/orders/${placed.publicId}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      expect(response.status).toBe(200);
    }
    expect(await (await staff('/orders')).json()).toEqual([]);
  });

  it('refuses to skip steps or go backwards', async () => {
    const { slug, firstItem, staff } = await newCafe();
    const placed = (await (await order(slug, { items: [{ itemId: firstItem.id, quantity: 1 }] })).json()) as Order;
    const move = (status: string) => staff(`/orders/${placed.publicId}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    expect((await move('served')).status).toBe(409);
    expect((await move('preparing')).status).toBe(200);
    expect((await move('new')).status).toBe(409);
  });
});

describe('live updates', () => {
  async function firstEvent(url: string, cookie: string | undefined, trigger: () => Promise<unknown>) {
    const controller = new AbortController();
    const response = await fetch(url, { signal: controller.signal, headers: cookie ? { cookie } : {} });
    const reader = response.body!.getReader();
    await reader.read();
    await trigger();
    let text = '';
    while (!text.includes('\n\n') || !text.includes('event:')) {
      const { value } = await reader.read();
      text += new TextDecoder().decode(value);
    }
    controller.abort();
    return text;
  }

  it('tells the kitchen about a new order right away', async () => {
    const { slug, firstItem, cookie } = await newCafe();
    const text = await firstEvent(`${base}/api/c/${slug}/stream`, cookie, () => order(slug, { items: [{ itemId: firstItem.id, quantity: 1 }], note: 'hello kitchen' }));
    expect(text).toContain('event: order');
    expect(text).toContain('hello kitchen');
  });

  it('tells the customer when their food is being made', async () => {
    const { slug, firstItem, staff } = await newCafe();
    const placed = (await (await order(slug, { items: [{ itemId: firstItem.id, quantity: 1 }] })).json()) as Order;
    const text = await firstEvent(`${base}/api/orders/${placed.publicId}/stream`, undefined, () =>
      staff(`/orders/${placed.publicId}`, { method: 'PATCH', body: JSON.stringify({ status: 'preparing' }) }),
    );
    expect(text).toContain('"status":"preparing"');
  });

  it('tells customers when something sells out', async () => {
    const { slug, firstItem, staff } = await newCafe();
    const text = await firstEvent(`${base}/api/c/${slug}/menu-stream`, undefined, () =>
      staff(`/items/${firstItem.id}`, { method: 'PATCH', body: JSON.stringify({ soldOut: true }) }),
    );
    expect(text).toContain('event: menu');
    expect(text).toContain('"soldOut":true');
  });
});

describe('the owner’s numbers', () => {
  it('come from a month of orders', async () => {
    const { staff } = await newCafe();
    const stats = (await (await staff('/stats')).json()) as Stats;
    expect(stats.topItems).toHaveLength(5);
    expect(stats.byHour.length).toBeGreaterThan(8);
    expect(stats.averageOrder).toBeGreaterThan(0);
    expect(stats.averagePrepMinutes).toBeGreaterThan(5);
  });

  it('count a new order in today’s revenue', async () => {
    const { slug, firstItem, staff } = await newCafe();
    const before = (await (await staff('/stats')).json()) as Stats;
    await order(slug, { items: [{ itemId: firstItem.id, quantity: 1 }] });
    const after = (await (await staff('/stats')).json()) as Stats;
    expect(after.revenueToday - before.revenueToday).toBe(firstItem.priceTetri);
    expect(after.ordersToday - before.ordersToday).toBe(1);
  });
});

describe('demo cafes', () => {
  it('are private to each visitor, and get cleaned up', async () => {
    const one = await newCafe();
    const other = await newCafe();
    await order(one.slug, { items: [{ itemId: one.firstItem.id, quantity: 1 }] });
    expect(await (await other.staff('/orders')).json()).toEqual([]);
    expect(deleteOldDemoCafes(db, new Date(Date.now() + 1000))).toBeGreaterThanOrEqual(2);
    expect((await fetch(`${base}/api/c/${one.slug}`)).status).toBe(404);
  });
});
