import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cafes (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  pin_hash    TEXT NOT NULL,
  is_demo     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id        INTEGER PRIMARY KEY,
  cafe_id   INTEGER NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  name_ka   TEXT NOT NULL,
  position  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id              INTEGER PRIMARY KEY,
  cafe_id         INTEGER NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
  category_id     INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  name_ka         TEXT NOT NULL,
  description     TEXT NOT NULL,
  description_ka  TEXT NOT NULL,
  price_tetri     INTEGER NOT NULL CHECK (price_tetri >= 0),
  sold_out        INTEGER NOT NULL DEFAULT 0,
  position        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id            INTEGER PRIMARY KEY,
  public_id     TEXT NOT NULL UNIQUE,
  cafe_id       INTEGER NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
  table_number  INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('new', 'preparing', 'ready', 'served', 'cancelled')),
  note          TEXT NOT NULL DEFAULT '',
  total_tetri   INTEGER NOT NULL,
  client_key    TEXT,
  created_at    TEXT NOT NULL,
  ready_at      TEXT,
  UNIQUE (cafe_id, client_key)
);
CREATE INDEX IF NOT EXISTS orders_by_cafe_time ON orders (cafe_id, created_at);
CREATE INDEX IF NOT EXISTS orders_by_cafe_status ON orders (cafe_id, status);

-- Name and price are copied at order time, so changing the menu later can't rewrite past orders.
CREATE TABLE IF NOT EXISTS order_lines (
  id           INTEGER PRIMARY KEY,
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id      INTEGER REFERENCES items(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  name_ka      TEXT NOT NULL,
  price_tetri  INTEGER NOT NULL,
  quantity     INTEGER NOT NULL CHECK (quantity > 0)
);
CREATE INDEX IF NOT EXISTS lines_by_order ON order_lines (order_id);

CREATE TABLE IF NOT EXISTS floor_tables (
  id       INTEGER PRIMARY KEY,
  cafe_id  INTEGER NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
  number   INTEGER NOT NULL,
  seats    INTEGER NOT NULL CHECK (seats > 0),
  shape    TEXT NOT NULL CHECK (shape IN ('round', 'rect')),
  x        INTEGER NOT NULL,
  y        INTEGER NOT NULL,
  w        INTEGER NOT NULL,
  h        INTEGER NOT NULL,
  UNIQUE (cafe_id, number)
);

CREATE TABLE IF NOT EXISTS fixtures (
  id       INTEGER PRIMARY KEY,
  cafe_id  INTEGER NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL CHECK (kind IN ('bar', 'wall', 'plant', 'door', 'window')),
  x        INTEGER NOT NULL,
  y        INTEGER NOT NULL,
  w        INTEGER NOT NULL,
  h        INTEGER NOT NULL
);

-- The table number is copied, so that past bookings still make sense after a table is removed.
CREATE TABLE IF NOT EXISTS reservations (
  id            INTEGER PRIMARY KEY,
  public_id     TEXT NOT NULL UNIQUE,
  cafe_id       INTEGER NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
  table_id      INTEGER REFERENCES floor_tables(id) ON DELETE SET NULL,
  table_number  INTEGER NOT NULL,
  guest_name    TEXT NOT NULL,
  phone         TEXT NOT NULL,
  party_size    INTEGER NOT NULL CHECK (party_size > 0),
  starts_at     TEXT NOT NULL,
  ends_at       TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('confirmed', 'arrived', 'cancelled', 'no-show')),
  client_key    TEXT,
  UNIQUE (cafe_id, client_key)
);
CREATE INDEX IF NOT EXISTS reservations_by_table ON reservations (table_id, starts_at);
CREATE INDEX IF NOT EXISTS reservations_by_cafe ON reservations (cafe_id, starts_at);

-- Two bookings overlap if each one starts before the other ends. Keeping this rule in the database
-- means no bug in the code above it, and no two requests arriving together, can double-book a table.
CREATE TRIGGER IF NOT EXISTS no_double_booking
BEFORE INSERT ON reservations
WHEN NEW.status IN ('confirmed', 'arrived') AND EXISTS (
  SELECT 1 FROM reservations r
  WHERE r.table_id = NEW.table_id
    AND r.status IN ('confirmed', 'arrived')
    AND r.starts_at < NEW.ends_at
    AND r.ends_at > NEW.starts_at
)
BEGIN
  SELECT RAISE(ABORT, 'table-taken');
END;
`;

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Each step upgrades a database made by an older version. `user_version` records which have run. */
function migrate(db: DatabaseSync) {
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (version < 1) {
    // Tables moved from a count on the cafe to rows on the floor plan.
    const columns = db.prepare('PRAGMA table_info(cafes)').all() as { name: string }[];
    if (columns.some((column) => column.name === 'tables')) db.exec('ALTER TABLE cafes DROP COLUMN tables');
    // Demo cafes from before then have no floor plan. They're temporary anyway, so remove them.
    db.exec(`DELETE FROM cafes WHERE is_demo = 1 AND id NOT IN (SELECT cafe_id FROM floor_tables)`);
    db.exec('PRAGMA user_version = 1');
  }
}

/** Runs `work` in one transaction, so that an order and its lines are saved together or not at all. */
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
