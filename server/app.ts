import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import express from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { addMinutes, BOOKING_MINUTES, findPlanProblem, slotToIso, tbilisiDate } from '../shared/floor.ts';
import type { Availability, FloorPlan, ReservationStatus } from '../shared/floor.ts';
import type { OrderStatus } from '../shared/types.ts';
import { bookTable, findReservation, getPlan, liveFloor, reservationsBetween, savePlan, tableNumbers, takenTables, updateReservation } from './floor.ts';
import { activeOrders, findCafe, findOrder, getCafeWithMenu, getStats, placeOrder, setSoldOut, updateOrderStatus } from './repo.ts';
import type { CafeRow } from './repo.ts';
import { createDemoCafe } from './seed.ts';

const COOKIE = 'magida_staff';
const SESSION_MS = 12 * 3600_000;
const STATUSES: OrderStatus[] = ['new', 'preparing', 'ready', 'served', 'cancelled'];

/** Server-Sent Events: each open screen subscribes to a channel, and gets told when something changes. */
class LiveUpdates {
  private channels = new Map<string, Set<Response>>();

  subscribe(channel: string, response: Response, request: Request) {
    response.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    response.flushHeaders();
    response.write(': connected\n\n');
    const listeners = this.channels.get(channel) ?? new Set<Response>();
    this.channels.set(channel, listeners);
    listeners.add(response);
    // A comment every so often, so that proxies don't close a quiet connection.
    const heartbeat = setInterval(() => response.write(': ping\n\n'), 25_000);
    request.on('close', () => {
      clearInterval(heartbeat);
      listeners.delete(response);
      if (listeners.size === 0) this.channels.delete(channel);
    });
  }

  publish(channel: string, event: string, data: unknown) {
    for (const response of this.channels.get(channel) ?? []) {
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  }
}

/** A small fixed-window limit, so that one script can't flood a kitchen with fake orders. */
function rateLimit(limit: number, windowMs: number): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (request, response, next) => {
    const now = Date.now();
    if (hits.size > 10_000) hits.clear();
    const key = request.ip ?? 'unknown';
    const entry = hits.get(key);
    if (!entry || entry.resetAt < now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      next();
    } else if (++entry.count > limit) {
      response.status(429).json({ error: 'Too many requests. Try again in a minute.' });
    } else {
      next();
    }
  };
}

export type AppOptions = { db: DatabaseSync; secret?: string; secure?: boolean; orderLimit?: number; demoLimit?: number; bookingLimit?: number };

export function createApp({ db, secret = randomBytes(32).toString('hex'), secure = false, orderLimit = 30, demoLimit = 20, bookingLimit = 20 }: AppOptions) {
  const app = express();
  const live = new LiveUpdates();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '32kb' }));

  // ----- Staff sessions: a signed cookie saying which cafe this browser is logged in to ------------

  const sign = (value: string) => createHmac('sha256', secret).update(value).digest('hex');

  const startSession = (response: Response, cafeId: number) => {
    const value = `${cafeId}.${Date.now() + SESSION_MS}`;
    response.cookie(COOKIE, `${value}.${sign(value)}`, { httpOnly: true, sameSite: 'lax', secure, maxAge: SESSION_MS, path: '/' });
  };

  const sessionCafeId = (request: Request): number | null => {
    const cookie = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`));
    const [cafeId, expires, signature] = decodeURIComponent(cookie?.slice(COOKIE.length + 1) ?? '').split('.');
    if (!signature || Number(expires) < Date.now()) return null;
    const expected = Buffer.from(sign(`${cafeId}.${expires}`));
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given) ? Number(cafeId) : null;
  };

  const withCafe = (request: Request, response: Response): CafeRow | null => {
    const cafe = findCafe(db, String(request.params.slug));
    if (!cafe) response.status(404).json({ error: 'No such cafe.' });
    return cafe ?? null;
  };

  const withStaff = (request: Request, response: Response): CafeRow | null => {
    const cafe = withCafe(request, response);
    if (!cafe) return null;
    if (sessionCafeId(request) !== cafe.id) {
      response.status(401).json({ error: 'Log in first.' });
      return null;
    }
    return cafe;
  };

  // ----- The demo: every visitor gets their own private cafe ---------------------------------------

  app.post('/api/demo', rateLimit(demoLimit, 60_000), (_request, response) => {
    const slug = `demo-${randomBytes(5).toString('hex')}`;
    const cafeId = createDemoCafe(db, slug);
    startSession(response, cafeId);
    response.status(201).json({ slug });
  });

  // ----- For customers: no login, because they're just sitting at a table ---------------------------

  app.get('/api/c/:slug', (request, response) => {
    const cafe = withCafe(request, response);
    if (cafe) response.json(getCafeWithMenu(db, cafe));
  });

  app.get('/api/c/:slug/menu-stream', (request, response) => {
    const cafe = withCafe(request, response);
    if (cafe) live.subscribe(`menu:${cafe.id}`, response, request);
  });

  app.post('/api/c/:slug/orders', rateLimit(orderLimit, 60_000), (request, response) => {
    const cafe = withCafe(request, response);
    if (!cafe) return;
    const { tableNumber, items, note, clientKey } = request.body ?? {};
    const validItems =
      Array.isArray(items) &&
      items.length >= 1 &&
      items.length <= 30 &&
      items.every((line) => Number.isInteger(line?.itemId) && Number.isInteger(line?.quantity) && line.quantity >= 1 && line.quantity <= 20);
    if (!tableNumbers(db, cafe.id).includes(tableNumber)) {
      response.status(400).json({ error: 'That table doesn’t exist.' });
      return;
    }
    if (!validItems || typeof clientKey !== 'string' || clientKey.length < 8 || clientKey.length > 64) {
      response.status(400).json({ error: 'That order isn’t valid.' });
      return;
    }
    const cleanNote = typeof note === 'string' ? note.trim().slice(0, 140) : '';
    const result = placeOrder(db, cafe.id, { tableNumber, items, note: cleanNote, clientKey });
    if (result.kind === 'unknown-item') {
      response.status(400).json({ error: 'Something in your order is no longer on the menu.' });
    } else if (result.kind === 'sold-out') {
      response.status(409).json({ error: 'Something in your order just sold out.', itemIds: result.itemIds });
    } else {
      if (result.kind === 'created') live.publish(`cafe:${cafe.id}`, 'order', result.order);
      response.status(result.kind === 'created' ? 201 : 200).json(result.order);
    }
  });

  // The long random ID is what lets a phone follow its own order, and nobody else's.
  app.get('/api/orders/:publicId', (request, response) => {
    const order = findOrder(db, request.params.publicId);
    if (!order) {
      response.status(404).json({ error: 'No such order.' });
      return;
    }
    const { cafeId: _cafeId, ...publicOrder } = order;
    response.json(publicOrder);
  });

  app.get('/api/orders/:publicId/stream', (request, response) => {
    if (!findOrder(db, request.params.publicId)) {
      response.status(404).json({ error: 'No such order.' });
      return;
    }
    live.subscribe(`order:${request.params.publicId}`, response, request);
  });

  // ----- For staff ---------------------------------------------------------------------------------

  app.post('/api/c/:slug/login', rateLimit(10, 60_000), (request, response) => {
    const cafe = withCafe(request, response);
    if (!cafe) return;
    const [salt, hash] = cafe.pin_hash.split(':');
    const given = scryptSync(String(request.body?.pin ?? ''), salt, 32);
    if (!timingSafeEqual(given, Buffer.from(hash, 'hex'))) {
      response.status(401).json({ error: 'Wrong PIN.' });
      return;
    }
    startSession(response, cafe.id);
    response.json({ ok: true });
  });

  app.get('/api/c/:slug/orders', (request, response) => {
    const cafe = withStaff(request, response);
    if (cafe) response.json(activeOrders(db, cafe.id));
  });

  app.get('/api/c/:slug/stream', (request, response) => {
    const cafe = withStaff(request, response);
    if (cafe) live.subscribe(`cafe:${cafe.id}`, response, request);
  });

  app.patch('/api/c/:slug/orders/:publicId', (request, response) => {
    const cafe = withStaff(request, response);
    if (!cafe) return;
    const status = request.body?.status;
    if (!STATUSES.includes(status)) {
      response.status(400).json({ error: 'Unknown status.' });
      return;
    }
    const result = updateOrderStatus(db, cafe.id, request.params.publicId, status);
    if (result.kind === 'not-found') {
      response.status(404).json({ error: 'No such order.' });
    } else if (result.kind === 'invalid') {
      response.status(409).json({ error: `An order that's ${result.from} can't become ${status}.` });
    } else {
      live.publish(`cafe:${cafe.id}`, 'order', result.order);
      live.publish(`order:${result.order.publicId}`, 'order', result.order);
      response.json(result.order);
    }
  });

  app.patch('/api/c/:slug/items/:itemId', (request, response) => {
    const cafe = withStaff(request, response);
    if (!cafe) return;
    if (typeof request.body?.soldOut !== 'boolean') {
      response.status(400).json({ error: 'soldOut must be true or false.' });
      return;
    }
    if (!setSoldOut(db, cafe.id, Number(request.params.itemId), request.body.soldOut)) {
      response.status(404).json({ error: 'No such item.' });
      return;
    }
    const menu = getCafeWithMenu(db, cafe);
    live.publish(`menu:${cafe.id}`, 'menu', menu);
    response.json(menu);
  });

  app.get('/api/c/:slug/stats', (request, response) => {
    const cafe = withStaff(request, response);
    if (cafe) response.json(getStats(db, cafe.id));
  });

  // ----- The floor plan and bookings: public parts first, with no names or phone numbers -------------

  app.get('/api/c/:slug/floor', (request, response) => {
    const cafe = withCafe(request, response);
    if (cafe) response.json(getPlan(db, cafe.id));
  });

  app.get('/api/c/:slug/availability', (request, response) => {
    const cafe = withCafe(request, response);
    if (!cafe) return;
    const startsAt = slotToIso(String(request.query.date), String(request.query.time));
    if (!startsAt) {
      response.status(400).json({ error: 'That date or time isn\u2019t valid.' });
      return;
    }
    const endsAt = addMinutes(startsAt, BOOKING_MINUTES);
    const availability: Availability = { startsAt, endsAt, takenTableIds: takenTables(db, cafe.id, startsAt, endsAt) };
    response.json(availability);
  });

  app.post('/api/c/:slug/reservations', rateLimit(bookingLimit, 60_000), (request, response) => {
    const cafe = withCafe(request, response);
    if (!cafe) return;
    const { tableId, partySize, date, time, name, phone, clientKey } = request.body ?? {};
    const startsAt = slotToIso(String(date), String(time));
    const guestName = typeof name === 'string' ? name.trim().slice(0, 60) : '';
    const cleanPhone = typeof phone === 'string' ? phone.trim() : '';
    const refuse = (error: string) => response.status(400).json({ error });
    if (!startsAt || new Date(startsAt) <= new Date()) return void refuse('Please pick a time in the future.');
    if (String(date) > tbilisiDate(new Date(), 60)) return void refuse('Bookings open 60 days ahead.');
    if (!Number.isInteger(partySize) || partySize < 1 || partySize > 20) return void refuse('Please choose how many people are coming.');
    if (!guestName) return void refuse('Please add a name for the booking.');
    if (!/^\+?[\d\s()-]{6,20}$/.test(cleanPhone)) return void refuse('Please add a phone number, so that the cafe can reach you.');
    if (!Number.isInteger(tableId) || typeof clientKey !== 'string' || clientKey.length < 8 || clientKey.length > 64) return void refuse('That booking isn\u2019t valid.');

    const result = bookTable(db, cafe.id, { tableId, partySize, startsAt, guestName, phone: cleanPhone, clientKey });
    if (result.kind === 'no-table') return void refuse('That table isn\u2019t available.');
    if (result.kind === 'too-small') return void refuse(`That table only seats ${result.seats}.`);
    if (result.kind === 'taken') {
      response.status(409).json({ error: 'Someone just booked that table. Please pick another.' });
      return;
    }
    if (result.kind === 'created') {
      live.publish(`menu:${cafe.id}`, 'availability', {});
      live.publish(`cafe:${cafe.id}`, 'reservation', result.reservation);
    }
    response.status(result.kind === 'created' ? 201 : 200).json(result.reservation);
  });

  // As with orders, the long random ID is what lets a guest see and cancel their own booking.
  app.get('/api/reservations/:publicId', (request, response) => {
    const found = findReservation(db, request.params.publicId);
    if (!found) {
      response.status(404).json({ error: 'No such booking.' });
      return;
    }
    const { cafeId: _cafeId, ...reservation } = found;
    response.json(reservation);
  });

  app.post('/api/reservations/:publicId/cancel', (request, response) => {
    const found = findReservation(db, request.params.publicId);
    if (!found) {
      response.status(404).json({ error: 'No such booking.' });
      return;
    }
    const updated = updateReservation(db, request.params.publicId, found.cafeId, 'cancelled');
    if (typeof updated === 'string') {
      response.status(409).json({ error: 'This booking can\u2019t be cancelled any more.' });
      return;
    }
    live.publish(`menu:${found.cafeId}`, 'availability', {});
    live.publish(`cafe:${found.cafeId}`, 'reservation', updated);
    response.json(updated);
  });

  // ----- The floor plan and bookings: for staff ------------------------------------------------------

  app.put('/api/c/:slug/floor', (request, response) => {
    const cafe = withStaff(request, response);
    if (!cafe) return;
    const { tables, fixtures } = request.body ?? {};
    if (!Array.isArray(tables) || !Array.isArray(fixtures)) {
      response.status(400).json({ error: 'That isn\u2019t a floor plan.' });
      return;
    }
    const plan: FloorPlan = { tables, fixtures };
    const problem = findPlanProblem(plan);
    if (problem) {
      response.status(400).json({ error: problem });
      return;
    }
    const result = savePlan(db, cafe.id, plan);
    if (result.kind === 'blocked') {
      response.status(409).json({ error: result.message });
      return;
    }
    live.publish(`menu:${cafe.id}`, 'availability', {});
    live.publish(`cafe:${cafe.id}`, 'reservation', {});
    response.json(result.plan);
  });

  app.get('/api/c/:slug/floor/live', (request, response) => {
    const cafe = withStaff(request, response);
    if (cafe) response.json(liveFloor(db, cafe.id));
  });

  app.get('/api/c/:slug/reservations', (request, response) => {
    const cafe = withStaff(request, response);
    if (!cafe) return;
    const from = slotToIso(String(request.query.date), '09:00');
    if (!from) {
      response.status(400).json({ error: 'That date isn\u2019t valid.' });
      return;
    }
    // A full day, starting from opening time.
    response.json(reservationsBetween(db, cafe.id, from, addMinutes(from, 24 * 60)));
  });

  app.patch('/api/c/:slug/reservations/:publicId', (request, response) => {
    const cafe = withStaff(request, response);
    if (!cafe) return;
    const status = request.body?.status as ReservationStatus;
    if (!['arrived', 'cancelled', 'no-show'].includes(status)) {
      response.status(400).json({ error: 'Unknown status.' });
      return;
    }
    const updated = updateReservation(db, request.params.publicId, cafe.id, status);
    if (updated === 'not-found') {
      response.status(404).json({ error: 'No such booking.' });
    } else if (updated === 'invalid') {
      response.status(409).json({ error: 'That booking has already been dealt with.' });
    } else {
      live.publish(`menu:${cafe.id}`, 'availability', {});
      live.publish(`cafe:${cafe.id}`, 'reservation', updated);
      response.json(updated);
    }
  });

  app.use('/api', (_request, response) => {
    response.status(404).json({ error: 'Not found.' });
  });

  // ----- The built React app ------------------------------------------------------------------------

  const dist = join(import.meta.dirname, '..', 'dist');
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get('/{*path}', (_request, response) => response.sendFile(join(dist, 'index.html')));
  }
  return app;
}
