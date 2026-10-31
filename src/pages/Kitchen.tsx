import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Order, OrderStatus } from '../../shared/types.ts';
import { ApiError, api, useLiveEvents } from '../lib/api.ts';
import { StaffGate } from './StaffGate.tsx';

const COLUMNS: { status: OrderStatus; title: string; action: string; next: OrderStatus }[] = [
  { status: 'new', title: 'New', action: 'Start', next: 'preparing' },
  { status: 'preparing', title: 'Being made', action: 'Ready', next: 'ready' },
  { status: 'ready', title: 'Ready to serve', action: 'Served', next: 'served' },
];
/** An order waiting longer than this gets flagged, so that nobody's food is forgotten. */
const LATE_MINUTES = 15;

function minutesSince(iso: string, now: number) {
  return Math.max(Math.floor((now - new Date(iso).getTime()) / 60_000), 0);
}

/** The screen in the kitchen. New orders appear here by themselves. */
export function Kitchen() {
  const { slug } = useParams();
  const [orders, setOrders] = useState<Order[]>([]);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(() => {
    api<Order[]>(`/c/${slug}/orders`)
      .then((active) => {
        setOrders(active);
        setNeedsLogin(false);
      })
      .catch((error) => {
        if (error instanceof ApiError && error.status === 401) setNeedsLogin(true);
      });
  }, [slug]);

  useEffect(load, [load]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  const merge = (order: Order) =>
    setOrders((current) => {
      const others = current.filter((other) => other.publicId !== order.publicId);
      return order.status === 'served' || order.status === 'cancelled' ? others : [...others, order];
    });

  useLiveEvents<Order>(needsLogin ? null : `/c/${slug}/stream`, 'order', merge, load);

  const move = async (order: Order, status: OrderStatus) => {
    setFailed(null);
    try {
      merge(await api<Order>(`/c/${slug}/orders/${order.publicId}`, { method: 'PATCH', body: { status } }));
    } catch (error) {
      setFailed(error instanceof Error ? error.message : 'That didn’t save.');
      load();
    }
  };

  if (needsLogin) return <StaffGate slug={slug!} onDone={load} />;

  return (
    <div className="kitchen">
      {failed && <p className="kitchen__error" role="alert">{failed}</p>}
      <div className="board">
        {COLUMNS.map((column) => {
          const here = orders.filter((order) => order.status === column.status).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          return (
            <section key={column.status} className="column" data-testid={`column-${column.status}`}>
              <h2>{column.title} <span>{here.length}</span></h2>
              {here.length === 0 && <p className="column__empty">{column.status === 'new' ? 'Waiting for orders' : 'Nothing here'}</p>}
              {here.map((order) => {
                const age = minutesSince(order.createdAt, now);
                return (
                  <article key={order.publicId} className={age >= LATE_MINUTES ? 'ticket ticket--late' : 'ticket'} data-testid="ticket">
                    <header>
                      <strong>Table {order.tableNumber}</strong>
                      <time>{age === 0 ? 'just now' : `${age} min`}</time>
                    </header>
                    <ul>
                      {order.lines.map((line, index) => <li key={index}><b>{line.quantity}×</b> {line.name}</li>)}
                    </ul>
                    {order.note && <p className="ticket__note">{order.note}</p>}
                    <button type="button" onClick={() => move(order, column.next)}>{column.action}</button>
                  </article>
                );
              })}
            </section>
          );
        })}
      </div>
    </div>
  );
}
