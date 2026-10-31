/** The floor plan and booking rules. The browser and the server both use these, so they can't disagree. */

export const PLAN_WIDTH = 24;
export const PLAN_HEIGHT = 16;
export const BOOKING_MINUTES = 90;

export type TableShape = 'round' | 'rect';
export type FixtureKind = 'bar' | 'wall' | 'plant' | 'door' | 'window';

type Box = { x: number; y: number; w: number; h: number };

export type FloorTable = Box & { id?: number; number: number; seats: number; shape: TableShape };
export type Fixture = Box & { id?: number; kind: FixtureKind };
export type FloorPlan = { tables: FloorTable[]; fixtures: Fixture[] };

/** Doors and windows are on the wall, so a table can sit next to them. Everything else takes up floor. */
const SOLID: FixtureKind[] = ['bar', 'wall', 'plant'];

function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function inBounds(box: Box): boolean {
  return (
    [box.x, box.y, box.w, box.h].every(Number.isInteger) &&
    box.w >= 1 &&
    box.h >= 1 &&
    box.x >= 0 &&
    box.y >= 0 &&
    box.x + box.w <= PLAN_WIDTH &&
    box.y + box.h <= PLAN_HEIGHT
  );
}

/** What's wrong with a floor plan, in words for the owner, or `null` if it's fine. */
export function findPlanProblem(plan: FloorPlan): string | null {
  if (plan.tables.length === 0) return 'A cafe needs at least one table.';
  if (plan.tables.length > 60 || plan.fixtures.length > 60) return 'That’s too many things for one floor plan.';
  const numbers = new Set<number>();
  for (const table of plan.tables) {
    if (!Number.isInteger(table.number) || table.number < 1 || table.number > 999) return 'Table numbers must be between 1 and 999.';
    if (numbers.has(table.number)) return `There are two tables numbered ${table.number}.`;
    numbers.add(table.number);
    if (!Number.isInteger(table.seats) || table.seats < 1 || table.seats > 20) return `Table ${table.number} needs between 1 and 20 seats.`;
    if (table.shape !== 'round' && table.shape !== 'rect') return `Table ${table.number} has an unknown shape.`;
    if (!inBounds(table)) return `Table ${table.number} is outside the room.`;
  }
  for (const fixture of plan.fixtures) {
    if (!['bar', 'wall', 'plant', 'door', 'window'].includes(fixture.kind)) return 'Something on the plan is of an unknown kind.';
    if (!inBounds(fixture)) return `A ${fixture.kind} is outside the room.`;
  }
  for (let i = 0; i < plan.tables.length; i++) {
    for (let j = i + 1; j < plan.tables.length; j++) {
      if (boxesOverlap(plan.tables[i], plan.tables[j])) return `Tables ${plan.tables[i].number} and ${plan.tables[j].number} overlap.`;
    }
    for (const fixture of plan.fixtures) {
      if (SOLID.includes(fixture.kind) && boxesOverlap(plan.tables[i], fixture)) return `Table ${plan.tables[i].number} overlaps the ${fixture.kind}.`;
    }
  }
  return null;
}

// ----- Booking times. Georgia is UTC+4 all year, with no daylight saving. ---------------------------

export function bookingSlots(): string[] {
  const slots: string[] = [];
  for (let minutes = 9 * 60; minutes <= 20 * 60 + 30; minutes += 30) {
    slots.push(`${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`);
  }
  return slots;
}

/** Today's date in Tbilisi, as YYYY-MM-DD, moved by some number of days. */
export function tbilisiDate(now: Date, addDays = 0): string {
  return new Date(now.getTime() + 4 * 3600_000 + addDays * 86_400_000).toISOString().slice(0, 10);
}

/** Turns a date and time in Tbilisi into a UTC timestamp, or `null` if it isn't a real one. */
export function slotToIso(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !bookingSlots().includes(time)) return null;
  const parsed = new Date(`${date}T${time}:00+04:00`);
  if (Number.isNaN(parsed.getTime()) || tbilisiDate(parsed) !== date) return null;
  return parsed.toISOString();
}

export function addMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

export function formatTbilisiTime(iso: string): string {
  return new Date(new Date(iso).getTime() + 4 * 3600_000).toISOString().slice(11, 16);
}

export type ReservationStatus = 'confirmed' | 'arrived' | 'cancelled' | 'no-show';

/** What a guest sees, through their private link. */
export type Reservation = {
  publicId: string;
  tableNumber: number;
  guestName: string;
  partySize: number;
  startsAt: string;
  endsAt: string;
  status: ReservationStatus;
};

/** What staff see, which adds the phone number. */
export type StaffReservation = Reservation & { phone: string };

export type Availability = { startsAt: string; endsAt: string; takenTableIds: number[] };

export type LiveTable = { tableId: number; state: 'free' | 'soon' | 'booked' | 'seated' | 'ordering'; label: string };
