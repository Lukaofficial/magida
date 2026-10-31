/** Every SQL query in the project lives here. */
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Cafe, MenuCategory, Order, OrderStatus, Stats } from '../shared/types.ts';
import { transaction } from './db.ts';
import { tableNumbers } from './floor.ts';

export type CafeRow = { id: number; slug: string; name: string; pin_hash: string; is_demo: number };

export function findCafe(db: DatabaseSync, slug: string): CafeRow | undefined {
  return db.prepare('SELECT * FROM cafes WHERE slug = ?').get(slug) as CafeRow | undefined;
}

export function getCafeWithMenu(db: DatabaseSync, cafe: CafeRow): Cafe {
  const categories = db.prepare('SELECT * FROM categories WHERE cafe_id = ? ORDER BY position').all(cafe.id) as {
    id: number;
    name: string;
    name_ka: string;
  }[];
  const items = db.prepare('SELECT * FROM items WHERE cafe_id = ? ORDER BY position').all(cafe.id) as {
    id: number;
    category_id: number;
    name: string;
    name_ka: string;
    description: string;
    description_ka: string;
    price_tetri: number;
    sold_out: number;
  }[];
  const menu: MenuCategory[] = categories.map((category) => ({
    id: category.id,
    name: category.name,
    nameKa: category.name_ka,
    items: items
      .filter((item) => item.category_id === category.id)
      .map((item) => ({
        id: item.id,
        name: item.name,
        nameKa: item.name_ka,
        description: item.description,
        descriptionKa: item.description_ka,
        priceTetri: item.price_tetri,
        soldOut: item.sold_out === 1,
      })),
  }));
  return { slug: cafe.slug, name: cafe.name, tableNumbers: tableNumbers(db, cafe.id), categories: menu };
}

type OrderRow = {
  id: number;
  public_id: string;
  table_number: number;
  status: OrderStatus;
  note: string;
  total_tetri: number;
  created_at: string;
};

function toOrder(db: DatabaseSync, row: OrderRow): Order {
  const lines = db.prepare('SELECT name, name_ka, price_tetri, quantity FROM order_lines WHERE order_id = ? ORDER BY id').all(row.id) as {
    name: string;
    name_ka: string;
    price_tetri: number;
    quantity: number;
  }[];
  return {
    publicId: row.public_id,
    tableNumber: row.table_number,
    status: row.status,
    note: row.note,
    totalTetri: row.total_tetri,
    createdAt: row.created_at,
    lines: lines.map((line) => ({ name: line.name, nameKa: line.name_ka, priceTetri: line.price_tetri, quantity: line.quantity })),
  };
}

export function findOrder(db: DatabaseSync, publicId: string): (Order & { cafeId: number }) | undefined {
  const row = db.prepare('SELECT *, cafe_id FROM orders WHERE public_id = ?').get(publicId) as (OrderRow & { cafe_id: number }) | undefined;
  return row ? { ...toOrder(db, row), cafeId: row.cafe_id } : undefined;
}

export function activeOrders(db: DatabaseSync, cafeId: number): Order[] {
  const rows = db
    .prepare("SELECT * FROM orders WHERE cafe_id = ? AND status IN ('new', 'preparing', 'ready') ORDER BY created_at")
    .all(cafeId) as OrderRow[];
  return rows.map((row) => toOrder(db, row));
}

export type NewOrder = {
  tableNumber: number;
  items: { itemId: number; quantity: number }[];
  note: string;
  clientKey: string;
};

export type PlaceResult = { kind: 'created' | 'replayed'; order: Order } | { kind: 'sold-out'; itemIds: number[] } | { kind: 'unknown-item' };

/**
 * Saves an order. Prices come from the database, never from the browser, so nobody can order a
 * khachapuri for 1 tetri by editing a request. A retried request with the same key returns the first
 * order, so a double tap on bad cafe wifi can't send two meals to the kitchen.
 */
export function placeOrder(db: DatabaseSync, cafeId: number, input: NewOrder, now = new Date()): PlaceResult {
  return transaction(db, (): PlaceResult => {
    const existing = db.prepare('SELECT * FROM orders WHERE cafe_id = ? AND client_key = ?').get(cafeId, input.clientKey) as OrderRow | undefined;
    if (existing) return { kind: 'replayed', order: toOrder(db, existing) };

    const findItem = db.prepare('SELECT id, name, name_ka, price_tetri, sold_out FROM items WHERE id = ? AND cafe_id = ?');
    const found = input.items.map((line) => ({
      quantity: line.quantity,
      item: findItem.get(line.itemId, cafeId) as { id: number; name: string; name_ka: string; price_tetri: number; sold_out: number } | undefined,
    }));
    if (found.some((line) => !line.item)) return { kind: 'unknown-item' };
    const soldOut = found.filter((line) => line.item!.sold_out === 1).map((line) => line.item!.id);
    if (soldOut.length > 0) return { kind: 'sold-out', itemIds: soldOut };

    const total = found.reduce((sum, line) => sum + line.item!.price_tetri * line.quantity, 0);
    const row = db
      .prepare(
        `INSERT INTO orders (public_id, cafe_id, table_number, status, note, total_tetri, client_key, created_at)
         VALUES (?, ?, ?, 'new', ?, ?, ?, ?) RETURNING *`,
      )
      .get(randomBytes(12).toString('hex'), cafeId, input.tableNumber, input.note, total, input.clientKey, now.toISOString()) as OrderRow;
    const addLine = db.prepare('INSERT INTO order_lines (order_id, item_id, name, name_ka, price_tetri, quantity) VALUES (?, ?, ?, ?, ?, ?)');
    for (const { item, quantity } of found) addLine.run(row.id, item!.id, item!.name, item!.name_ka, item!.price_tetri, quantity);
    return { kind: 'created', order: toOrder(db, row) };
  });
}

const NEXT_STATUS: Record<OrderStatus, OrderStatus[]> = {
  new: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['served'],
  served: [],
  cancelled: [],
};

export type UpdateResult = { kind: 'updated'; order: Order } | { kind: 'not-found' } | { kind: 'invalid'; from: OrderStatus };

/** Moves an order on, only along the allowed steps. A served meal can't go back to "preparing". */
export function updateOrderStatus(db: DatabaseSync, cafeId: number, publicId: string, status: OrderStatus, now = new Date()): UpdateResult {
  const row = db.prepare('SELECT * FROM orders WHERE public_id = ? AND cafe_id = ?').get(publicId, cafeId) as OrderRow | undefined;
  if (!row) return { kind: 'not-found' };
  if (!NEXT_STATUS[row.status].includes(status)) return { kind: 'invalid', from: row.status };
  const readyAt = status === 'ready' ? now.toISOString() : null;
  const updated = db
    .prepare('UPDATE orders SET status = ?, ready_at = COALESCE(?, ready_at) WHERE id = ? RETURNING *')
    .get(status, readyAt, row.id) as OrderRow;
  return { kind: 'updated', order: toOrder(db, updated) };
}

export function setSoldOut(db: DatabaseSync, cafeId: number, itemId: number, soldOut: boolean): boolean {
  return db.prepare('UPDATE items SET sold_out = ? WHERE id = ? AND cafe_id = ?').run(soldOut ? 1 : 0, itemId, cafeId).changes > 0;
}

/** The owner's numbers. All dates are worked out in Tbilisi time (UTC+4), since that's when a day ends for a cafe. */
export function getStats(db: DatabaseSync, cafeId: number): Stats {
  const local = "date(created_at, '+4 hours')";
  const today = "date('now', '+4 hours')";
  const summary = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN ${local} = ${today} THEN total_tetri END), 0) AS revenue_today,
         COALESCE(SUM(CASE WHEN ${local} = date('now', '+4 hours', '-1 day') THEN total_tetri END), 0) AS revenue_yesterday,
         COUNT(CASE WHEN ${local} = ${today} THEN 1 END) AS orders_today
       FROM orders WHERE cafe_id = ? AND status != 'cancelled'`,
    )
    .get(cafeId) as { revenue_today: number; revenue_yesterday: number; orders_today: number };

  const week = db
    .prepare(
      `SELECT AVG(total_tetri) AS average_order,
              AVG((julianday(ready_at) - julianday(created_at)) * 1440) AS prep_minutes
       FROM orders
       WHERE cafe_id = ? AND status != 'cancelled' AND created_at >= datetime('now', '-7 days')`,
    )
    .get(cafeId) as { average_order: number | null; prep_minutes: number | null };

  const topItems = db
    .prepare(
      `SELECT l.name AS name, SUM(l.quantity) AS quantity, SUM(l.quantity * l.price_tetri) AS revenue
       FROM order_lines l JOIN orders o ON o.id = l.order_id
       WHERE o.cafe_id = ? AND o.status != 'cancelled' AND o.created_at >= datetime('now', '-30 days')
       GROUP BY l.name ORDER BY quantity DESC, l.name LIMIT 5`,
    )
    .all(cafeId) as { name: string; quantity: number; revenue: number }[];

  const hours = db
    .prepare(
      `SELECT CAST(strftime('%H', created_at, '+4 hours') AS INTEGER) AS hour, COUNT(*) AS orders
       FROM orders
       WHERE cafe_id = ? AND status != 'cancelled' AND created_at >= datetime('now', '-30 days')
       GROUP BY hour ORDER BY hour`,
    )
    .all(cafeId) as { hour: number; orders: number }[];

  return {
    revenueToday: summary.revenue_today,
    revenueYesterday: summary.revenue_yesterday,
    ordersToday: summary.orders_today,
    averageOrder: Math.round(week.average_order ?? 0),
    averagePrepMinutes: week.prep_minutes === null ? null : Math.round(week.prep_minutes * 10) / 10,
    topItems: topItems.map((item) => ({ ...item })),
    byHour: hours.map((hour) => ({ ...hour })),
  };
}

/** Demo cafes are per-visitor and temporary, so strangers never see each other's orders. */
export function deleteOldDemoCafes(db: DatabaseSync, olderThan: Date): number {
  return Number(db.prepare('DELETE FROM cafes WHERE is_demo = 1 AND created_at < ?').run(olderThan.toISOString()).changes);
}
