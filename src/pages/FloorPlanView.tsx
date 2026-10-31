import type { KeyboardEvent, PointerEvent as ReactPointerEvent, Ref } from 'react';
import { PLAN_HEIGHT, PLAN_WIDTH } from '../../shared/floor.ts';
import type { Fixture, FloorPlan, FloorTable } from '../../shared/floor.ts';

/** How many drawing units one square of the floor is. */
const CELL = 40;

export type TableKey = string | number;

const FIXTURE_LABELS: Record<Fixture['kind'], string> = { bar: 'Bar', wall: '', plant: 'Plant', door: 'Door', window: 'Window' };

/** Where the chairs go: evenly round a circle, or along the long sides of a rectangle. */
function chairPositions(table: FloorTable): { x: number; y: number }[] {
  const cx = (table.x + table.w / 2) * CELL;
  const cy = (table.y + table.h / 2) * CELL;
  const chairs: { x: number; y: number }[] = [];
  if (table.shape === 'round') {
    const radius = (Math.min(table.w, table.h) * CELL) / 2 - 3;
    for (let seat = 0; seat < table.seats; seat++) {
      const angle = -Math.PI / 2 + (seat / table.seats) * Math.PI * 2;
      chairs.push({ x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius });
    }
    return chairs;
  }
  const wide = table.w >= table.h;
  const first = Math.ceil(table.seats / 2);
  const place = (count: number, side: number) => {
    for (let seat = 0; seat < count; seat++) {
      const along = ((seat + 0.5) / count - 0.5) * (wide ? table.w : table.h) * CELL;
      const across = (side * (wide ? table.h : table.w) * CELL) / 2 - side * 5;
      chairs.push(wide ? { x: cx + along, y: cy + across } : { x: cx + across, y: cy + along });
    }
  };
  place(first, -1);
  place(table.seats - first, 1);
  return chairs;
}

export type PlanProps = {
  plan: FloorPlan;
  /** Adds a state class to a table, which is what colours it. */
  stateOf?: (table: FloorTable) => string;
  /** Tables with no click handler, or for which this says no, can't be pressed. */
  canPress?: (table: FloorTable) => boolean;
  onPress?: (table: FloorTable) => void;
  describe?: (table: FloorTable) => string;
  editing?: boolean;
  svgRef?: Ref<SVGSVGElement>;
  onGrab?: (event: ReactPointerEvent, kind: 'table' | 'fixture', index: number) => void;
  onHover?: (table: FloorTable | null) => void;
  selected?: { kind: 'table' | 'fixture'; index: number } | null;
  onKeyMove?: (event: KeyboardEvent, kind: 'table' | 'fixture', index: number) => void;
};

/** The cafe from above, in SVG. Booking, the live view and the editor all draw it with this. */
export function FloorPlanView({ plan, stateOf, canPress, onPress, describe, editing, svgRef, onGrab, onHover, selected, onKeyMove }: PlanProps) {
  const lines = [];
  for (let x = 1; x < PLAN_WIDTH; x++) lines.push(<line key={`x${x}`} className="plan__grid" x1={x * CELL} x2={x * CELL} y1={0} y2={PLAN_HEIGHT * CELL} />);
  for (let y = 1; y < PLAN_HEIGHT; y++) lines.push(<line key={`y${y}`} className="plan__grid" x1={0} x2={PLAN_WIDTH * CELL} y1={y * CELL} y2={y * CELL} />);

  return (
    <svg
      ref={svgRef}
      className={editing ? 'plan plan--editing' : 'plan'}
      viewBox={`0 0 ${PLAN_WIDTH * CELL} ${PLAN_HEIGHT * CELL}`}
      role="group"
      aria-label="Floor plan of the cafe"
      data-testid="plan"
    >
      {editing && lines}
      {plan.fixtures.map((fixture, index) => {
        const grabbed = selected?.kind === 'fixture' && selected.index === index;
        return (
          <g
            key={fixture.id ?? `new-${index}`}
            className={`plan__fixture plan__fixture--${fixture.kind}${grabbed ? ' plan__fixture--grabbed' : ''}`}
            data-testid={editing ? `fixture-${fixture.kind}` : undefined}
            {...(editing
              ? {
                  role: 'button',
                  tabIndex: 0,
                  'aria-label': `${fixture.kind}. Drag to move, or use the arrow keys.`,
                  style: { cursor: 'grab' },
                  onPointerDown: (event: ReactPointerEvent) => onGrab?.(event, 'fixture', index),
                  onKeyDown: (event: KeyboardEvent) => onKeyMove?.(event, 'fixture', index),
                }
              : {})}
          >
            <rect x={fixture.x * CELL + 2} y={fixture.y * CELL + 2} width={fixture.w * CELL - 4} height={fixture.h * CELL - 4} rx={5} />
            {fixture.w * CELL > 70 && fixture.h * CELL >= 40 && (
              <text x={(fixture.x + fixture.w / 2) * CELL} y={(fixture.y + fixture.h / 2) * CELL}>{FIXTURE_LABELS[fixture.kind]}</text>
            )}
          </g>
        );
      })}
      {plan.tables.map((table, index) => {
        const pressable = !editing && Boolean(onPress) && (canPress?.(table) ?? true);
        const grabbed = selected?.kind === 'table' && selected.index === index;
        const cx = (table.x + table.w / 2) * CELL;
        const cy = (table.y + table.h / 2) * CELL;
        const label = describe?.(table) ?? `Table ${table.number}, ${table.seats} seats`;
        return (
          <g
            key={table.id ?? `new-${table.number}-${index}`}
            className={`plan__table plan__table--${stateOf?.(table) ?? 'plain'}${grabbed ? ' plan__table--grabbed' : ''}`}
            data-testid={`table-${table.number}`}
            onPointerEnter={() => onHover?.(table)}
            onPointerLeave={() => onHover?.(null)}
            {...(pressable
              ? {
                  role: 'button',
                  tabIndex: 0,
                  'aria-label': label,
                  onClick: () => onPress?.(table),
                  onKeyDown: (event: KeyboardEvent) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onPress?.(table);
                    }
                  },
                }
              : editing
                ? {
                    role: 'button',
                    tabIndex: 0,
                    'aria-label': `${label}. Drag to move, or use the arrow keys.`,
                    style: { cursor: 'grab' },
                    onPointerDown: (event: ReactPointerEvent) => onGrab?.(event, 'table', index),
                    onKeyDown: (event: KeyboardEvent) => onKeyMove?.(event, 'table', index),
                  }
                : { role: 'img', 'aria-label': label })}
          >
            {chairPositions(table).map((chair, seat) => <circle key={seat} className="plan__chair" cx={chair.x} cy={chair.y} r={9} />)}
            {table.shape === 'round' ? (
              <circle className="plan__top" cx={cx} cy={cy} r={(Math.min(table.w, table.h) * CELL) / 2 - 13} />
            ) : (
              <rect className="plan__top" x={table.x * CELL + 13} y={table.y * CELL + 13} width={table.w * CELL - 26} height={table.h * CELL - 26} rx={8} />
            )}
            <text className="plan__number" x={cx} y={cy - 8}>{table.number}</text>
            <text className="plan__seats" x={cx} y={cy + 19}>{table.seats} seats</text>
          </g>
        );
      })}
    </svg>
  );
}
