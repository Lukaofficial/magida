/** SQL for the floor plan and reservations. */
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { addMinutes, BOOKING_MINUTES, formatTbilisiTime } from '../shared/floor.ts';
import type { FloorPlan, FloorTable, LiveTable, Reservation, ReservationStatus, StaffReservation } from '../shared/floor.ts';
import { transaction } from './db.ts';

type TableRow = { id: number; number: number; seats: number; shape: 'round' | 'rect'; x: number; y: number; w: number; h: number };

export function getPlan(db: DatabaseSync, cafeId: number): FloorPlan {
  const tables = db.prepare('SELECT id, number, seats, shape, x, y, w, h FROM floor_tables WHERE cafe_id = ? ORDER BY number').all(cafeId) as TableRow[];
  const fixtures = db.prepare('SELECT id, kind, x, y, w, h FROM fixtures WHERE cafe_id = ? ORDER BY id').all(cafeId) as FloorPlan['fixtures'];
  return { tables: tables.map((table) => ({ ...table })), fixtures: fixtures.map((fixture) => ({ ...fixture })) };
}

export function tableNumbers(db: DatabaseSync, cafeId: number): number[] {
  const rows = db.prepare('SELECT number FROM floor_tables WHERE cafe_id = ? ORDER BY number').all(cafeId) as { number: number }[];
  return rows.map((row) => row.number);
}

export type SaveResult = { kind: 'saved'; plan: FloorPlan } | { kind: 'blocked'; message: string };

/** Saves the whole plan. Tables keep their IDs, so that existing bookings stay attached to them. */
export function savePlan(db: DatabaseSync, cafeId: number, plan: FloorPlan, now = new Date()): SaveResult {
  return transaction(db, (): SaveResult => {
    const upcoming = db
      .prepare(
        `SELECT table_id, table_number, MAX(party_size) AS largest FROM reservations
         WHERE cafe_id = ? AND status IN ('confirmed', 'arrived') AND ends_at > ? AND table_id IS NOT NULL
         GROUP BY table_id`,
      )
      .all(cafeId, now.toISOString()) as { table_id: number; table_number: number; largest: number }[];
    for (const booked of upcoming) {
      const kept = plan.tables.find((table) => table.id === booked.table_id);
      if (!kept) return { kind: 'blocked', message: `Table ${booked.table_number} has upcoming bookings, so it can’t be removed yet.` };
      if (kept.seats < booked.largest) return { kind: 'blocked', message: `Table ${kept.number} has a booking for ${booked.largest}, so it needs at least that many seats.` };
    }

    const existing = db.prepare('SELECT id FROM floor_tables WHERE cafe_id = ?').all(cafeId) as { id: number }[];
    const keptIds = new Set(plan.tables.map((table) => table.id));
    const remove = db.prepare('DELETE FROM floor_tables WHERE id = ?');
    for (const { id } of existing) if (!keptIds.has(id)) remove.run(id);

    // Numbers are unique, so two tables swapping numbers would clash halfway through. Clear them first.
    db.prepare('UPDATE floor_tables SET number = -id WHERE cafe_id = ?').run(cafeId);
    const update = db.prepare('UPDATE floor_tables SET number = ?, seats = ?, shape = ?, x = ?, y = ?, w = ?, h = ? WHERE id = ? AND cafe_id = ?');
    const insert = db.prepare('INSERT INTO floor_tables (cafe_id, number, seats, shape, x, y, w, h) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const known = new Set(existing.map((row) => row.id));
    for (const table of plan.tables) {
      const values = [table.number, table.seats, table.shape, table.x, table.y, table.w, table.h] as const;
      if (table.id !== undefined && known.has(table.id)) update.run(...values, table.id, cafeId);
      else insert.run(cafeId, ...values);
    }

    db.prepare('DELETE FROM fixtures WHERE cafe_id = ?').run(cafeId);
    const addFixture = db.prepare('INSERT INTO fixtures (cafe_id, kind, x, y, w, h) VALUES (?, ?, ?, ?, ?, ?)');
    for (const fixture of plan.fixtures) addFixture.run(cafeId, fixture.kind, fixture.x, fixture.y, fixture.w, fixture.h);
    return { kind: 'saved', plan: getPlan(db, cafeId) };
  });
}

export function takenTables(db: DatabaseSync, cafeId: number, startsAt: string, endsAt: string): number[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT table_id FROM reservations
       WHERE cafe_id = ? AND table_id IS NOT NULL AND status IN ('confirmed', 'arrived') AND starts_at < ? AND ends_at > ?`,
    )
    .all(cafeId, endsAt, startsAt) as { table_id: number }[];
  return rows.map((row) => row.table_id);
}

type ReservationRow = {
  public_id: string;
  table_number: number;
  guest_name: string;
  phone: string;
  party_size: number;
  starts_at: string;
  ends_at: string;
  status: ReservationStatus;
};

function toReservation(row: ReservationRow): Reservation {
  return {
    publicId: row.public_id,
    tableNumber: row.table_number,
    guestName: row.guest_name,
    partySize: row.party_size,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
  };
}

export type NewReservation = { tableId: number; partySize: number; startsAt: string; guestName: string; phone: string; clientKey: string };
export type BookResult =
  | { kind: 'created' | 'replayed'; reservation: Reservation }
  | { kind: 'no-table' }
  | { kind: 'too-small'; seats: number }
  | { kind: 'taken' };

/**
 * Books a table. Two people can press "book" at the same moment, so the check that a table is free
 * can't be left to this code: a trigger in the database refuses overlapping bookings, whatever
 * happens up here. See `no_double_booking` in db.ts.
 */
export function bookTable(db: DatabaseSync, cafeId: number, input: NewReservation): BookResult {
  const replay = db.prepare('SELECT * FROM reservations WHERE cafe_id = ? AND client_key = ?').get(cafeId, input.clientKey) as ReservationRow | undefined;
  if (replay) return { kind: 'replayed', reservation: toReservation(replay) };

  const table = db.prepare('SELECT id, number, seats FROM floor_tables WHERE id = ? AND cafe_id = ?').get(input.tableId, cafeId) as FloorTable | undefined;
  if (!table) return { kind: 'no-table' };
  if (input.partySize > table.seats) return { kind: 'too-small', seats: table.seats };

  try {
    const row = db
      .prepare(
        `INSERT INTO reservations (public_id, cafe_id, table_id, table_number, guest_name, phone, party_size, starts_at, ends_at, status, client_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?) RETURNING *`,
      )
      .get(
        randomBytes(12).toString('hex'),
        cafeId,
        table.id!,
        table.number,
        input.guestName,
        input.phone,
        input.partySize,
        input.startsAt,
        addMinutes(input.startsAt, BOOKING_MINUTES),
        input.clientKey,
      ) as ReservationRow;
    return { kind: 'created', reservation: toReservation(row) };
  } catch (error) {
    if (error instanceof Error && error.message.includes('table-taken')) return { kind: 'taken' };
    throw error;
  }
}

export function findReservation(db: DatabaseSync, publicId: string): (Reservation & { cafeId: number }) | undefined {
  const row = db.prepare('SELECT * FROM reservations WHERE public_id = ?').get(publicId) as (ReservationRow & { cafe_id: number }) | undefined;
  return row ? { ...toReservation(row), cafeId: row.cafe_id } : undefined;
}

const NEXT: Record<ReservationStatus, ReservationStatus[]> = {
  confirmed: ['arrived', 'cancelled', 'no-show'],
  arrived: [],
  cancelled: [],
  'no-show': [],
};

/** Moves a booking on. There's deliberately no way back to "confirmed", since that table may be rebooked by then. */
export function updateReservation(db: DatabaseSync, publicId: string, cafeId: number, status: ReservationStatus): Reservation | 'not-found' | 'invalid' {
  const row = db.prepare('SELECT * FROM reservations WHERE public_id = ? AND cafe_id = ?').get(publicId, cafeId) as ReservationRow | undefined;
  if (!row) return 'not-found';
  if (!NEXT[row.status].includes(status)) return 'invalid';
  return toReservation(db.prepare('UPDATE reservations SET status = ? WHERE public_id = ? RETURNING *').get(status, publicId) as ReservationRow);
}

export function reservationsBetween(db: DatabaseSync, cafeId: number, from: string, to: string): StaffReservation[] {
  const rows = db
    .prepare(
      `SELECT r.*, COALESCE(t.number, r.table_number) AS table_number
       FROM reservations r LEFT JOIN floor_tables t ON t.id = r.table_id
       WHERE r.cafe_id = ? AND r.starts_at >= ? AND r.starts_at < ? ORDER BY r.starts_at, table_number`,
    )
    .all(cafeId, from, to) as ReservationRow[];
  return rows.map((row) => ({ ...toReservation(row), phone: row.phone }));
}

/**
 * The room right now, which is where ordering and booking meet: a table with an order in the kitchen
 * is ordering, whether or not anyone booked it.
 */
export function liveFloor(db: DatabaseSync, cafeId: number, now = new Date()): LiveTable[] {
  const nowIso = now.toISOString();
  const soon = new Date(now.getTime() + 60 * 60_000).toISOString();
  const tables = db.prepare('SELECT id, number FROM floor_tables WHERE cafe_id = ?').all(cafeId) as { id: number; number: number }[];
  const ordering = db
    .prepare("SELECT table_number, COUNT(*) AS orders FROM orders WHERE cafe_id = ? AND status IN ('new', 'preparing', 'ready') GROUP BY table_number")
    .all(cafeId) as { table_number: number; orders: number }[];
  const bookings = db
    .prepare(
      `SELECT table_id, guest_name, party_size, starts_at, status FROM reservations
       WHERE cafe_id = ? AND status IN ('confirmed', 'arrived') AND ends_at > ? AND starts_at < ? ORDER BY starts_at DESC`,
    )
    .all(cafeId, nowIso, soon) as { table_id: number; guest_name: string; party_size: number; starts_at: string; status: ReservationStatus }[];

  return tables.map((table): LiveTable => {
    const active = ordering.find((row) => row.table_number === table.number);
    if (active) return { tableId: table.id, state: 'ordering', label: `${active.orders} ${active.orders === 1 ? 'order' : 'orders'} in the kitchen` };
    const booking = bookings.find((row) => row.table_id === table.id);
    if (!booking) return { tableId: table.id, state: 'free', label: 'Free' };
    const who = `${booking.guest_name}, ${booking.party_size}, ${formatTbilisiTime(booking.starts_at)}`;
    if (booking.status === 'arrived') return { tableId: table.id, state: 'seated', label: `Seated: ${who}` };
    return { tableId: table.id, state: booking.starts_at <= nowIso ? 'booked' : 'soon', label: `${booking.starts_at <= nowIso ? 'Expected now' : 'Booked soon'}: ${who}` };
  });
}
