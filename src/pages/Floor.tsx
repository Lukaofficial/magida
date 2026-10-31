import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useParams } from 'react-router-dom';
import { findPlanProblem, formatTbilisiTime, PLAN_HEIGHT, PLAN_WIDTH, tbilisiDate } from '../../shared/floor.ts';
import type { Fixture, FloorPlan, FloorTable, LiveTable, StaffReservation } from '../../shared/floor.ts';
import { ApiError, api, useLiveEvents } from '../lib/api.ts';
import { FloorPlanView } from './FloorPlanView.tsx';
import { StaffGate } from './StaffGate.tsx';

type Selection = { kind: 'table' | 'fixture'; index: number };

/** The owner's view of the room: what's happening right now, and where to move things. */
export function Floor() {
  const { slug } = useParams();
  const [plan, setPlan] = useState<FloorPlan | null>(null);
  const [mode, setMode] = useState<'live' | 'edit'>('live');
  const [needsLogin, setNeedsLogin] = useState(false);

  const load = useCallback(() => {
    api<FloorPlan>(`/c/${slug}/floor`).then(setPlan).catch(() => {});
    api(`/c/${slug}/floor/live`)
      .then(() => setNeedsLogin(false))
      .catch((error) => {
        if (error instanceof ApiError && error.status === 401) setNeedsLogin(true);
      });
  }, [slug]);
  useEffect(load, [load]);

  if (needsLogin) return <StaffGate slug={slug!} onDone={load} />;
  if (!plan) return <p className="centered">…</p>;

  return (
    <div className="floor">
      <div className="floor__top">
        <span className="tabs" role="group" aria-label="Floor plan mode">
          <button type="button" aria-pressed={mode === 'live'} onClick={() => setMode('live')} data-testid="floor-live">Right now</button>
          <button type="button" aria-pressed={mode === 'edit'} onClick={() => setMode('edit')} data-testid="floor-edit">Edit the room</button>
        </span>
      </div>
      {mode === 'live' ? (
        <LiveRoom slug={slug!} plan={plan} onPlanChanged={load} />
      ) : (
        <Editor
          slug={slug!}
          saved={plan}
          onSaved={(next) => {
            setPlan(next);
            setMode('live');
          }}
        />
      )}
    </div>
  );
}

function LiveRoom({ slug, plan, onPlanChanged }: { slug: string; plan: FloorPlan; onPlanChanged: () => void }) {
  const [live, setLive] = useState<LiveTable[]>([]);
  const [date, setDate] = useState(() => tbilisiDate(new Date()));
  const [bookings, setBookings] = useState<StaffReservation[]>([]);
  const [hovered, setHovered] = useState<FloorTable | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api<LiveTable[]>(`/c/${slug}/floor/live`).then(setLive).catch(() => {});
    api<StaffReservation[]>(`/c/${slug}/reservations?date=${date}`).then(setBookings).catch(() => {});
  }, [slug, date]);
  useEffect(refresh, [refresh]);
  useEffect(() => {
    const timer = setInterval(refresh, 60_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const latest = useRef({ refresh, onPlanChanged });
  useEffect(() => {
    latest.current = { refresh, onPlanChanged };
  });
  const onEvent = () => {
    latest.current.refresh();
    latest.current.onPlanChanged();
  };
  useLiveEvents<unknown>(`/c/${slug}/stream`, ['order', 'reservation'], onEvent, onEvent);

  const liveOf = (table: FloorTable) => live.find((row) => row.tableId === table.id);
  const setStatus = async (booking: StaffReservation, status: string) => {
    setFailed(null);
    try {
      await api(`/c/${slug}/reservations/${booking.publicId}`, { method: 'PATCH', body: { status } });
      refresh();
    } catch (error) {
      setFailed(error instanceof Error ? error.message : 'That didn’t save.');
    }
  };
  const dates = Array.from({ length: 14 }, (_, index) => tbilisiDate(new Date(), index));

  return (
    <div className="floor__layout">
      <div>
        <FloorPlanView
          plan={plan}
          stateOf={(table) => liveOf(table)?.state ?? 'plain'}
          describe={(table) => `Table ${table.number}, ${table.seats} seats. ${liveOf(table)?.label ?? ''}`}
          onHover={setHovered}
        />
        <ul className="plan-key" aria-hidden="true">
          <li><i style={{ background: '#e6f1e8', borderColor: 'var(--green)' }} /> Free</li>
          <li><i style={{ background: '#f6e3b4', borderColor: 'var(--amber)', borderStyle: 'dashed' }} /> Booked soon</li>
          <li><i style={{ background: '#2f6b4f', borderColor: '#204c38' }} /> Seated</li>
          <li><i style={{ background: 'var(--accent)', borderColor: 'var(--accent-dark)' }} /> Ordering</li>
        </ul>
        <p className="floor__tip" data-testid="floor-tip">
          {hovered ? `Table ${hovered.number}: ${liveOf(hovered)?.label ?? ''}` : 'Point at a table for details. This updates by itself.'}
        </p>
      </div>
      <aside className="floor__panel">
        <h2>Bookings</h2>
        <select value={date} onChange={(event) => setDate(event.target.value)} aria-label="Which day">
          {dates.map((day) => (
            <option key={day} value={day}>
              {new Date(`${day}T12:00:00+04:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Tbilisi' })}
            </option>
          ))}
        </select>
        {failed && <p className="tools__problem" role="alert">{failed}</p>}
        {bookings.length === 0 && <p className="bookings__empty">No bookings on this day.</p>}
        <ul className="bookings" data-testid="bookings">
          {bookings.map((booking) => (
            <li key={booking.publicId} data-testid="booking-row">
              <div>
                <span>{formatTbilisiTime(booking.startsAt)} · Table {booking.tableNumber}</span>
                {booking.status !== 'confirmed' && <span className="bookings__state">{booking.status === 'no-show' ? 'No show' : booking.status === 'arrived' ? 'Seated' : 'Cancelled'}</span>}
              </div>
              {booking.guestName}, {booking.partySize} {booking.partySize === 1 ? 'person' : 'people'}
              <br />
              <a className="bookings__phone" href={`tel:${booking.phone.replaceAll(' ', '')}`}>{booking.phone}</a>
              {booking.status === 'confirmed' && (
                <div className="bookings__actions">
                  <button type="button" onClick={() => setStatus(booking, 'arrived')}>Arrived</button>
                  <button type="button" onClick={() => setStatus(booking, 'no-show')}>No show</button>
                  <button type="button" onClick={() => setStatus(booking, 'cancelled')}>Cancel</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

const ADD_TABLES: { label: string; seats: number; shape: FloorTable['shape']; w: number; h: number }[] = [
  { label: 'Round, 2 seats', seats: 2, shape: 'round', w: 3, h: 3 },
  { label: 'Square, 4 seats', seats: 4, shape: 'rect', w: 4, h: 3 },
  { label: 'Long, 8 seats', seats: 8, shape: 'rect', w: 8, h: 3 },
];
const ADD_FIXTURES: { label: string; kind: Fixture['kind']; w: number; h: number }[] = [
  { label: 'Bar', kind: 'bar', w: 6, h: 2 },
  { label: 'Wall', kind: 'wall', w: 6, h: 1 },
  { label: 'Plant', kind: 'plant', w: 2, h: 2 },
  { label: 'Door', kind: 'door', w: 2, h: 1 },
  { label: 'Window', kind: 'window', w: 6, h: 1 },
];

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** Drag things around on a grid. Nothing changes for customers until Save, and the server checks it all again. */
function Editor({ slug, saved, onSaved }: { slug: string; saved: FloorPlan; onSaved: (plan: FloorPlan) => void }) {
  const [plan, setPlan] = useState<FloorPlan>(saved);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ selection: Selection; offsetX: number; offsetY: number } | null>(null);

  const problem = findPlanProblem(plan);
  const dirty = JSON.stringify(plan) !== JSON.stringify(saved);
  const item = selected ? (selected.kind === 'table' ? plan.tables[selected.index] : plan.fixtures[selected.index]) : null;

  const toCell = (event: { clientX: number; clientY: number }) => {
    const rect = svg.current!.getBoundingClientRect();
    return { x: ((event.clientX - rect.left) / rect.width) * PLAN_WIDTH, y: ((event.clientY - rect.top) / rect.height) * PLAN_HEIGHT };
  };

  const change = (selection: Selection, update: Partial<FloorTable>) =>
    setPlan((current) => {
      const key = selection.kind === 'table' ? 'tables' : 'fixtures';
      const list = current[key].map((entry, index) => {
        if (index !== selection.index) return entry;
        const next = { ...entry, ...update };
        next.w = clamp(next.w, 1, PLAN_WIDTH);
        next.h = clamp(next.h, 1, PLAN_HEIGHT);
        next.x = clamp(next.x, 0, PLAN_WIDTH - next.w);
        next.y = clamp(next.y, 0, PLAN_HEIGHT - next.h);
        return next;
      });
      return { ...current, [key]: list };
    });

  const grab = (event: ReactPointerEvent, kind: Selection['kind'], index: number) => {
    event.preventDefault();
    const target = kind === 'table' ? plan.tables[index] : plan.fixtures[index];
    const cell = toCell(event);
    setSelected({ kind, index });
    drag.current = { selection: { kind, index }, offsetX: cell.x - target.x, offsetY: cell.y - target.y };
    svg.current?.setPointerCapture(event.pointerId);
  };

  const onMove = (event: ReactPointerEvent) => {
    const held = drag.current;
    if (!held) return;
    const cell = toCell(event);
    change(held.selection, { x: Math.round(cell.x - held.offsetX), y: Math.round(cell.y - held.offsetY) });
  };

  const keyMove = (event: KeyboardEvent, kind: Selection['kind'], index: number) => {
    const moves: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const move = moves[event.key];
    setSelected({ kind, index });
    if (!move) return;
    event.preventDefault();
    const target = kind === 'table' ? plan.tables[index] : plan.fixtures[index];
    change({ kind, index }, { x: target.x + move[0], y: target.y + move[1] });
  };

  const addTable = (template: (typeof ADD_TABLES)[number]) => {
    const number = Math.max(0, ...plan.tables.map((table) => table.number)) + 1;
    const table: FloorTable = { number, seats: template.seats, shape: template.shape, x: 0, y: 0, w: template.w, h: template.h };
    setPlan({ ...plan, tables: [...plan.tables, table] });
    setSelected({ kind: 'table', index: plan.tables.length });
  };
  const addFixture = (template: (typeof ADD_FIXTURES)[number]) => {
    setPlan({ ...plan, fixtures: [...plan.fixtures, { kind: template.kind, x: 0, y: 0, w: template.w, h: template.h }] });
    setSelected({ kind: 'fixture', index: plan.fixtures.length });
  };
  const remove = () => {
    if (!selected) return;
    const key = selected.kind === 'table' ? 'tables' : 'fixtures';
    setPlan({ ...plan, [key]: plan[key].filter((_, index) => index !== selected.index) });
    setSelected(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      onSaved(await api<FloorPlan>(`/c/${slug}/floor`, { method: 'PUT', body: plan }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That didn’t save.');
    } finally {
      setSaving(false);
    }
  };

  const table = selected?.kind === 'table' ? plan.tables[selected.index] : null;

  return (
    <div className="floor__layout" data-testid="editor">
      <div onPointerMove={onMove} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
        <FloorPlanView plan={plan} editing svgRef={svg} onGrab={grab} selected={selected} onKeyMove={keyMove} stateOf={() => 'plain'} />
        <p className="floor__tip">Drag anything to move it. It snaps to the grid, and customers see nothing until you save.</p>
      </div>
      <aside className="floor__panel tools">
        <div>
          <h3>Add a table</h3>
          <div className="tools__row">
            {ADD_TABLES.map((template) => <button key={template.label} type="button" onClick={() => addTable(template)}>{template.label}</button>)}
          </div>
        </div>
        <div>
          <h3>Add to the room</h3>
          <div className="tools__row">
            {ADD_FIXTURES.map((template) => <button key={template.label} type="button" onClick={() => addFixture(template)} data-testid={`add-${template.kind}`}>{template.label}</button>)}
          </div>
        </div>
        {item && selected && (
          <div>
            <h3>{table ? `Table ${table.number}` : (item as Fixture).kind}</h3>
            {table && (
              <>
                <label className="tools__field">Number <input type="number" min={1} max={999} value={table.number} onChange={(event) => change(selected, { number: Number(event.target.value) })} data-testid="edit-number" /></label>
                <label className="tools__field">Seats <input type="number" min={1} max={20} value={table.seats} onChange={(event) => change(selected, { seats: Number(event.target.value) })} data-testid="edit-seats" /></label>
                <div className="tools__field">
                  Shape
                  <span className="tools__row">
                    <button type="button" aria-pressed={table.shape === 'round'} onClick={() => change(selected, { shape: 'round' })}>Round</button>
                    <button type="button" aria-pressed={table.shape === 'rect'} onClick={() => change(selected, { shape: 'rect' })}>Square</button>
                  </span>
                </div>
              </>
            )}
            <label className="tools__field">Width <input type="number" min={1} max={PLAN_WIDTH} value={item.w} onChange={(event) => change(selected, { w: Number(event.target.value) })} /></label>
            <label className="tools__field">Height <input type="number" min={1} max={PLAN_HEIGHT} value={item.h} onChange={(event) => change(selected, { h: Number(event.target.value) })} /></label>
            <div className="tools__row">
              <button type="button" onClick={() => change(selected, { w: item.h, h: item.w })}>Rotate</button>
              <button type="button" className="tools__danger" onClick={remove} data-testid="edit-remove">Remove</button>
            </div>
          </div>
        )}
        {problem && <p className="tools__problem" role="alert" data-testid="plan-problem">{problem}</p>}
        {error && <p className="tools__problem" role="alert" data-testid="save-error">{error}</p>}
        <div className="tools__save">
          <button type="button" className="big" disabled={Boolean(problem) || !dirty || saving} onClick={save} data-testid="save-plan"><span>{saving ? 'Saving…' : 'Save the room'}</span></button>
          <button type="button" className="quiet" disabled={!dirty} onClick={() => { setPlan(saved); setSelected(null); setError(null); }}>Undo</button>
        </div>
      </aside>
    </div>
  );
}
