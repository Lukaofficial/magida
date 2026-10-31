import { randomBytes, scryptSync } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { addMinutes, BOOKING_MINUTES, slotToIso, tbilisiDate } from '../shared/floor.ts';
import { transaction } from './db.ts';

export function hashPin(pin: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pin, salt, 32).toString('hex')}`;
}

type SeedItem = [name: string, nameKa: string, description: string, descriptionKa: string, gel: number];

/** A made-up cafe, so that the demo doesn't speak for any real business. */
const MENU: [string, string, SeedItem[]][] = [
  ['Baked', 'ცომეული', [
    ['Adjaruli khachapuri', 'აჭარული ხაჭაპური', 'Cheese boat, egg and butter', 'ყველი, კვერცხი და კარაქი', 24],
    ['Imeruli khachapuri', 'იმერული ხაჭაპური', 'Round, with sulguni and imeruli cheese', 'სულგუნი და იმერული ყველი', 18],
    ['Lobiani', 'ლობიანი', 'Bread filled with spiced beans', 'პური სუნელებიანი ლობიოთი', 12],
  ]],
  ['Kitchen', 'სამზარეულო', [
    ['Khinkali (5)', 'ხინკალი (5)', 'Beef and pork, with black pepper', 'საქონლისა და ღორის ხორცით', 13],
    ['Mtsvadi', 'მწვადი', 'Pork skewers over vine wood, with onion', 'ღორის მწვადი ვაზის ნაკვერჩხალზე', 26],
    ['Lobio in a clay pot', 'ლობიო ქოთანში', 'Red beans with mchadi and pickles', 'მჭადითა და მწნილით', 14],
    ['Pkhali plate', 'ფხალი', 'Spinach, beetroot and walnut', 'ისპანახი, ჭარხალი და ნიგოზი', 15],
  ]],
  ['Drinks', 'სასმელი', [
    ['Espresso', 'ესპრესო', 'Double shot', 'ორმაგი', 6],
    ['Flat white', 'ფლეტ უაითი', 'Double shot with steamed milk', 'ორმაგი ესპრესო და რძე', 9],
    ['Tarragon lemonade', 'ტარხუნის ლიმონათი', 'Made here, not too sweet', 'ადგილზე მომზადებული', 7],
    ['Saperavi, glass', 'საფერავი, ჭიქა', 'Dry red from Kakheti', 'მშრალი წითელი, კახეთი', 14],
  ]],
  ['Sweet', 'ტკბილი', [
    ['Honey cake', 'თაფლის ნამცხვარი', 'Thin layers with sour cream', 'თხელი ფენები არაჟნით', 11],
    ['Pelamushi', 'ფელამუში', 'Grape pudding with walnuts', 'ყურძნის ფაფა ნიგვზით', 9],
  ]],
];

/** How busy each hour is, 09:00 to 22:00 in Tbilisi. */
const HOUR_WEIGHTS = [2, 4, 5, 4, 6, 9, 8, 4, 3, 4, 6, 8, 7, 3];
const TBILISI_OFFSET_MS = 4 * 3600_000;

/** Creates a cafe with a full menu and a month of past orders, so the owner's dashboard has a story. */
export function createDemoCafe(db: DatabaseSync, slug: string, now = new Date()): number {
  return transaction(db, () => {
    const cafe = db
      .prepare('INSERT INTO cafes (slug, name, pin_hash, is_demo, created_at) VALUES (?, ?, ?, 1, ?) RETURNING id')
      .get(slug, 'Café Kalaki', hashPin('1234'), now.toISOString()) as { id: number };

    const addCategory = db.prepare('INSERT INTO categories (cafe_id, name, name_ka, position) VALUES (?, ?, ?, ?) RETURNING id');
    const addItem = db.prepare(
      `INSERT INTO items (cafe_id, category_id, name, name_ka, description, description_ka, price_tetri, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    );
    const items: { id: number; name: string; nameKa: string; price: number }[] = [];
    MENU.forEach(([name, nameKa, entries], categoryPosition) => {
      const category = addCategory.get(cafe.id, name, nameKa, categoryPosition) as { id: number };
      entries.forEach(([itemName, itemKa, description, descriptionKa, gel], position) => {
        const price = gel * 100;
        const row = addItem.get(cafe.id, category.id, itemName, itemKa, description, descriptionKa, price, position) as { id: number };
        items.push({ id: row.id, name: itemName, nameKa: itemKa, price });
      });
    });

    seedHistory(db, cafe.id, items, now);
    seedFloor(db, cafe.id, now);
    return cafe.id;
  });
}

/** A believable room: tables by the windows, a long table in the middle, and the bar along the back. */
const TABLES: [number: number, seats: number, shape: 'round' | 'rect', x: number, y: number, w: number, h: number][] = [
  [1, 2, 'round', 1, 2, 3, 3],
  [2, 2, 'round', 6, 2, 3, 3],
  [3, 2, 'round', 11, 2, 3, 3],
  [4, 4, 'rect', 16, 2, 4, 3],
  [5, 4, 'rect', 1, 7, 4, 3],
  [6, 8, 'rect', 7, 7, 8, 3],
  [7, 4, 'rect', 17, 7, 4, 3],
  [8, 2, 'round', 1, 12, 3, 3],
  [9, 2, 'round', 5, 12, 3, 3],
  [10, 4, 'rect', 9, 12, 4, 3],
  [11, 2, 'round', 14, 12, 3, 3],
  [12, 2, 'round', 21, 10, 3, 3],
];
const FIXTURES: [kind: string, x: number, y: number, w: number, h: number][] = [
  ['window', 1, 0, 8, 1],
  ['window', 11, 0, 9, 1],
  ['door', 22, 0, 2, 1],
  ['bar', 18, 14, 6, 2],
  ['plant', 22, 3, 2, 2],
];
const GUESTS = ['Nino', 'Giorgi', 'Mariam', 'Davit', 'Ana', 'Levan', 'Tamar', 'Irakli'];

function seedFloor(db: DatabaseSync, cafeId: number, now: Date) {
  const addTable = db.prepare('INSERT INTO floor_tables (cafe_id, number, seats, shape, x, y, w, h) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id');
  const ids = new Map<number, number>();
  for (const table of TABLES) ids.set(table[0], (addTable.get(cafeId, ...table) as { id: number }).id);
  const addFixture = db.prepare('INSERT INTO fixtures (cafe_id, kind, x, y, w, h) VALUES (?, ?, ?, ?, ?, ?)');
  for (const fixture of FIXTURES) addFixture.run(cafeId, ...fixture);

  const addBooking = db.prepare(
    `INSERT INTO reservations (public_id, cafe_id, table_id, table_number, guest_name, phone, party_size, starts_at, ends_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const book = (number: number, seats: number, startsAt: string, status: string, guest: number) =>
    addBooking.run(
      randomBytes(12).toString('hex'),
      cafeId,
      ids.get(number)!,
      number,
      GUESTS[guest % GUESTS.length],
      `+995 555 00 00 ${String(10 + guest % 90)}`,
      seats,
      startsAt,
      addMinutes(startsAt, BOOKING_MINUTES),
      status,
    );

  // Someone already seated, and someone due soon, so that the live view of the room has a story.
  const halfHour = 30 * 60_000;
  const nextSlot = Math.ceil(now.getTime() / halfHour) * halfHour;
  book(7, 3, new Date(nextSlot - halfHour).toISOString(), 'arrived', 0);
  book(4, 4, new Date(nextSlot).toISOString(), 'confirmed', 1);

  // A fuller week of evenings ahead.
  let guest = 2;
  for (let day = 1; day <= 7; day++) {
    const date = tbilisiDate(now, day);
    for (const [number, seats, time] of [[2, 2, '19:00'], [5, 4, '19:30'], [6, 6, '20:00'], [10, 3, '18:30']] as const) {
      if ((day + number) % 3 === 0) continue;
      book(number, seats, slotToIso(date, time)!, 'confirmed', guest++);
    }
  }
}

function seedHistory(db: DatabaseSync, cafeId: number, items: { id: number; name: string; nameKa: string; price: number }[], now: Date) {
  // A small fixed generator, so that every demo cafe gets the same believable month.
  let state = 20260601;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const pick = (limit: number) => Math.floor(random() * limit);

  const addOrder = db.prepare(
    `INSERT INTO orders (public_id, cafe_id, table_number, status, total_tetri, created_at, ready_at)
     VALUES (?, ?, ?, 'served', ?, ?, ?) RETURNING id`,
  );
  const addLine = db.prepare('INSERT INTO order_lines (order_id, item_id, name, name_ka, price_tetri, quantity) VALUES (?, ?, ?, ?, ?, ?)');

  const localToday = new Date(now.getTime() + TBILISI_OFFSET_MS);
  localToday.setUTCHours(0, 0, 0, 0);
  for (let daysAgo = 30; daysAgo >= 0; daysAgo--) {
    const weekday = new Date(localToday.getTime() - daysAgo * 86_400_000).getUTCDay();
    const busy = weekday === 0 || weekday === 6 ? 1.5 : 1;
    HOUR_WEIGHTS.forEach((weight, offset) => {
      const count = Math.round(weight * busy * (0.7 + random() * 0.6));
      for (let index = 0; index < count; index++) {
        const local = localToday.getTime() - daysAgo * 86_400_000 + (9 + offset) * 3600_000 + pick(3600_000);
        const created = local - TBILISI_OFFSET_MS;
        if (created >= now.getTime()) continue;
        const lines = Array.from({ length: 1 + pick(3) }, () => items[Math.floor(random() ** 1.5 * items.length)]);
        const total = lines.reduce((sum, line) => sum + line.price, 0);
        const ready = created + (6 + pick(14)) * 60_000;
        const order = addOrder.get(
          randomBytes(12).toString('hex'),
          cafeId,
          1 + pick(12),
          total,
          new Date(created).toISOString(),
          new Date(ready).toISOString(),
        ) as { id: number };
        for (const line of lines) addLine.run(order.id, line.id, line.name, line.nameKa, line.price, 1);
      }
    });
  }
}
