import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findPlanProblem, slotToIso, tbilisiDate } from '../shared/floor.ts';
import type { Availability, FloorPlan, LiveTable, Reservation, StaffReservation } from '../shared/floor.ts';
import { createApp } from './app.ts';
import { openDatabase } from './db.ts';
import { getPlan } from './floor.ts';
import { createDemoCafe } from './seed.ts';

const db = openDatabase(':memory:');
let server: Server;
let base = '';

beforeAll(async () => {
  server = createApp({ db, orderLimit: 10_000, demoLimit: 10_000, bookingLimit: 10_000 }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const json = { 'Content-Type': 'application/json' };

async function newCafe() {
  const response = await fetch(`${base}/api/demo`, { method: 'POST' });
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  const { slug } = (await response.json()) as { slug: string };
  const plan = (await (await fetch(`${base}/api/c/${slug}/floor`)).json()) as FloorPlan;
  const staff = (path: string, init: RequestInit = {}) => fetch(`${base}/api/c/${slug}${path}`, { ...init, headers: { ...json, cookie } });
  return { slug, plan, staff, cookie };
}

// Tomorrow morning: the seeded bookings are all in the evening, or within the next hour.
const date = tbilisiDate(new Date(), 2);
let keys = 0;
function book(slug: string, body: Record<string, unknown>) {
  return fetch(`${base}/api/c/${slug}/reservations`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ date, time: '10:00', partySize: 2, name: 'Nino', phone: '+995 555 12 34 56', clientKey: `booking-key-${++keys}`, ...body }),
  });
}

describe('booking a table', () => {
  it('works, and takes the table for 90 minutes', async () => {
    const { slug, plan } = await newCafe();
    const table = plan.tables[0];
    const response = await book(slug, { tableId: table.id });
    expect(response.status).toBe(201);
    const booking = (await response.json()) as Reservation;
    expect(booking.tableNumber).toBe(table.number);
    expect(new Date(booking.endsAt).getTime() - new Date(booking.startsAt).getTime()).toBe(90 * 60_000);

    const taken = async (time: string) =>
      ((await (await fetch(`${base}/api/c/${slug}/availability?date=${date}&time=${time}`)).json()) as Availability).takenTableIds;
    expect(await taken('10:00')).toContain(table.id);
    expect(await taken('11:00')).toContain(table.id);
    expect(await taken('11:30')).not.toContain(table.id);
  });

  it('never double-books, even with ten people pressing at once', async () => {
    const { slug, plan } = await newCafe();
    const responses = await Promise.all(Array.from({ length: 10 }, () => book(slug, { tableId: plan.tables[0].id })));
    const codes = responses.map((response) => response.status).sort();
    expect(codes.filter((code) => code === 201)).toHaveLength(1);
    expect(codes.filter((code) => code === 409)).toHaveLength(9);
  });

  it('is refused by the database itself, even if the code above it were wrong', async () => {
    const { slug, plan } = await newCafe();
    await book(slug, { tableId: plan.tables[0].id });
    const cafe = db.prepare('SELECT id FROM cafes WHERE slug = ?').get(slug) as { id: number };
    const startsAt = slotToIso(date, '10:30');
    expect(() =>
      db
        .prepare(
          `INSERT INTO reservations (public_id, cafe_id, table_id, table_number, guest_name, phone, party_size, starts_at, ends_at, status)
           VALUES ('x', ?, ?, 1, 'A', '1', 1, ?, ?, 'confirmed')`,
        )
        .run(cafe.id, plan.tables[0].id!, startsAt, startsAt),
    ).toThrow(/table-taken/);
  });

  it('allows a booking that starts when the last one ends', async () => {
    const { slug, plan } = await newCafe();
    await book(slug, { tableId: plan.tables[0].id, time: '10:00' });
    expect((await book(slug, { tableId: plan.tables[0].id, time: '11:30' })).status).toBe(201);
  });

  it('allows the table again once a booking is cancelled', async () => {
    const { slug, plan } = await newCafe();
    const first = (await (await book(slug, { tableId: plan.tables[0].id })).json()) as Reservation;
    expect((await fetch(`${base}/api/reservations/${first.publicId}/cancel`, { method: 'POST' })).status).toBe(200);
    expect((await book(slug, { tableId: plan.tables[0].id })).status).toBe(201);
  });

  it('creates one booking when the same request is sent twice', async () => {
    const { slug, plan } = await newCafe();
    const body = { tableId: plan.tables[0].id, clientKey: 'same-booking-key' };
    expect((await book(slug, body)).status).toBe(201);
    expect((await book(slug, body)).status).toBe(200);
  });

  it('refuses a party too big for the table', async () => {
    const { slug, plan } = await newCafe();
    const table = plan.tables[0];
    expect((await book(slug, { tableId: table.id, partySize: table.seats + 1 })).status).toBe(400);
  });

  it.each([
    ['a time in the past', { date: '2020-01-01' }],
    ['a date that does not exist', { date: '2030-02-31' }],
    ['a time the cafe is closed', { time: '03:00' }],
    ['a time not on the half hour', { time: '10:15' }],
    ['a date too far ahead', { date: '2099-01-01' }],
    ['a missing name', { name: '  ' }],
    ['a nonsense phone number', { phone: 'call me' }],
    ['nobody coming', { partySize: 0 }],
  ])('refuses %s', async (_name, body) => {
    const { slug, plan } = await newCafe();
    expect((await book(slug, { tableId: plan.tables[0].id, ...body })).status).toBe(400);
  });

  it('refuses a table from another cafe', async () => {
    const one = await newCafe();
    const other = await newCafe();
    expect((await book(one.slug, { tableId: other.plan.tables[0].id })).status).toBe(400);
  });

  it('never shows a guest’s name or phone number publicly', async () => {
    const { slug, plan } = await newCafe();
    await book(slug, { tableId: plan.tables[0].id, name: 'Secret Name', phone: '+995 599 99 99 99' });
    const text = await (await fetch(`${base}/api/c/${slug}/availability?date=${date}&time=10:00`)).text();
    expect(text).not.toContain('Secret');
    expect(text).not.toContain('599');
    expect((await fetch(`${base}/api/c/${slug}/reservations?date=${date}`)).status).toBe(401);
  });
});

describe('staff', () => {
  it('see the day’s bookings with phone numbers, and can mark an arrival', async () => {
    const { slug, plan, staff } = await newCafe();
    const placed = (await (await book(slug, { tableId: plan.tables[0].id })).json()) as Reservation;
    const list = (await (await staff(`/reservations?date=${date}`)).json()) as StaffReservation[];
    expect(list.find((item) => item.publicId === placed.publicId)?.phone).toBe('+995 555 12 34 56');

    const move = (status: string) => staff(`/reservations/${placed.publicId}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    expect((await move('arrived')).status).toBe(200);
    expect((await move('confirmed')).status).toBe(400);
    expect((await move('cancelled')).status).toBe(409);
  });

  it('see a table as ordering once someone there sends an order', async () => {
    const { slug, plan, staff } = await newCafe();
    const table = plan.tables[0];
    const before = (await (await staff('/floor/live')).json()) as LiveTable[];
    expect(before.find((row) => row.tableId === table.id)?.state).not.toBe('ordering');

    const menu = (await (await fetch(`${base}/api/c/${slug}`)).json()) as { categories: { items: { id: number }[] }[] };
    await fetch(`${base}/api/c/${slug}/orders`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ tableNumber: table.number, clientKey: 'floor-test-order', items: [{ itemId: menu.categories[0].items[0].id, quantity: 1 }] }),
    });
    const after = (await (await staff('/floor/live')).json()) as LiveTable[];
    expect(after.find((row) => row.tableId === table.id)?.state).toBe('ordering');
  });
});

describe('editing the floor plan', () => {
  const save = (staff: Awaited<ReturnType<typeof newCafe>>['staff'], plan: FloorPlan) => staff('/floor', { method: 'PUT', body: JSON.stringify(plan) });

  it('saves moved tables, and new ones', async () => {
    const { plan, staff, slug } = await newCafe();
    const free = plan.tables.filter((table) => table.number !== 1);
    const moved: FloorPlan = { tables: [...free, { number: 50, seats: 2, shape: 'round', x: 0, y: 0, w: 1, h: 1 }], fixtures: [] };
    expect((await save(staff, moved)).status).toBe(200);
    const stored = (await (await fetch(`${base}/api/c/${slug}/floor`)).json()) as FloorPlan;
    expect(stored.tables.map((table) => table.number)).toContain(50);
    expect(stored.fixtures).toEqual([]);
  });

  it('needs a login', async () => {
    const { slug, plan } = await newCafe();
    const response = await fetch(`${base}/api/c/${slug}/floor`, { method: 'PUT', headers: json, body: JSON.stringify(plan) });
    expect(response.status).toBe(401);
  });

  it('lets two tables swap numbers', async () => {
    const { plan, staff } = await newCafe();
    const [a, b, ...rest] = plan.tables;
    const swapped = { ...plan, tables: [{ ...a, number: b.number }, { ...b, number: a.number }, ...rest] };
    expect((await save(staff, swapped)).status).toBe(200);
  });

  it('refuses overlapping tables', async () => {
    const { plan, staff } = await newCafe();
    const [a, b, ...rest] = plan.tables;
    const response = await save(staff, { ...plan, tables: [a, { ...b, x: a.x, y: a.y }, ...rest] });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('overlap');
  });

  it('won’t remove a table with an upcoming booking', async () => {
    const { slug, plan, staff } = await newCafe();
    const table = plan.tables[0];
    await book(slug, { tableId: table.id });
    const response = await save(staff, { ...plan, tables: plan.tables.filter((other) => other.id !== table.id) });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain('upcoming bookings');
  });

  it('won’t shrink a table below an upcoming booking', async () => {
    const { slug, plan, staff } = await newCafe();
    const table = plan.tables.find((other) => other.seats >= 4)!;
    await book(slug, { tableId: table.id, partySize: 4 });
    const shrunk = plan.tables.map((other) => (other.id === table.id ? { ...other, seats: 2 } : other));
    expect((await save(staff, { ...plan, tables: shrunk })).status).toBe(409);
  });

  it('makes a removed table number invalid for ordering', async () => {
    const { slug, plan, staff } = await newCafe();
    const kept = plan.tables.filter((table) => table.number !== 12);
    const emptied = await fetch(`${base}/api/c/${slug}`);
    const menu = (await emptied.json()) as { categories: { items: { id: number }[] }[] };
    const removing = plan.tables.find((table) => table.number === 12)!;
    db.prepare('UPDATE reservations SET status = ? WHERE table_id = ?').run('cancelled', removing.id!);
    expect((await save(staff, { ...plan, tables: kept })).status).toBe(200);
    const response = await fetch(`${base}/api/c/${slug}/orders`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ tableNumber: 12, clientKey: 'removed-table-key', items: [{ itemId: menu.categories[0].items[0].id, quantity: 1 }] }),
    });
    expect(response.status).toBe(400);
  });
});

describe('upgrading', () => {
  it('opens a database made by the version before floor plans, and carries on working', () => {
    const folder = mkdtempSync(join(tmpdir(), 'magida-'));
    const path = join(folder, 'old.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE cafes (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, tables INTEGER NOT NULL,
      pin_hash TEXT NOT NULL, is_demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`);
    old.exec(`INSERT INTO cafes (slug, name, tables, pin_hash, is_demo, created_at) VALUES ('old-demo', 'Old', 12, 'x:y', 1, '2026-01-01')`);
    old.close();

    const upgraded = openDatabase(path);
    expect(upgraded.prepare("SELECT id FROM cafes WHERE slug = 'old-demo'").get()).toBeUndefined();
    expect(createDemoCafe(upgraded, 'new-demo')).toBeGreaterThan(0);
    expect(getPlan(upgraded, 1).tables.length + getPlan(upgraded, 2).tables.length).toBeGreaterThan(0);
    upgraded.close();
    openDatabase(path).close(); // Opening it a second time changes nothing.
    rmSync(folder, { recursive: true, force: true });
  });
});

describe('the shared rules', () => {
  const table = { number: 1, seats: 2, shape: 'round' as const, x: 0, y: 0, w: 2, h: 2 };

  it('accept a sensible plan', () => {
    expect(findPlanProblem({ tables: [table], fixtures: [] })).toBeNull();
  });

  it('let a table sit in front of a door, but not on the bar', () => {
    expect(findPlanProblem({ tables: [table], fixtures: [{ kind: 'door', x: 0, y: 0, w: 2, h: 1 }] })).toBeNull();
    expect(findPlanProblem({ tables: [table], fixtures: [{ kind: 'bar', x: 0, y: 0, w: 2, h: 1 }] })).toContain('overlaps');
  });

  it('let tables touch, without overlapping', () => {
    expect(findPlanProblem({ tables: [table, { ...table, number: 2, x: 2 }], fixtures: [] })).toBeNull();
  });

  it('catch duplicates, and anything outside the room', () => {
    expect(findPlanProblem({ tables: [table, { ...table, x: 5 }], fixtures: [] })).toContain('two tables');
    expect(findPlanProblem({ tables: [{ ...table, x: 23 }], fixtures: [] })).toContain('outside');
    expect(findPlanProblem({ tables: [], fixtures: [] })).toContain('at least one');
  });

  it('turn a Tbilisi time into the right moment', () => {
    expect(slotToIso('2030-06-01', '10:00')).toBe('2030-06-01T06:00:00.000Z');
    expect(slotToIso('2030-02-31', '10:00')).toBeNull();
    expect(slotToIso('2030-06-01', '10:15')).toBeNull();
  });

  it('work out the date in Tbilisi, not in UTC', () => {
    expect(tbilisiDate(new Date('2030-06-01T21:00:00Z'))).toBe('2030-06-02');
  });
});
