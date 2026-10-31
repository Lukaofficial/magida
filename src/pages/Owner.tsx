import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { formatGel } from '../../shared/types.ts';
import type { Cafe, Order, Stats } from '../../shared/types.ts';
import { ApiError, api, useLiveEvents } from '../lib/api.ts';
import { StaffGate } from './StaffGate.tsx';

/** What the cafe owner cares about: how today is going, what sells, when it's busy, and what's run out. */
export function Owner() {
  const { slug } = useParams();
  const [stats, setStats] = useState<Stats | null>(null);
  const [cafe, setCafe] = useState<Cafe | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);

  const load = useCallback(() => {
    Promise.all([api<Stats>(`/c/${slug}/stats`), api<Cafe>(`/c/${slug}`)])
      .then(([numbers, menu]) => {
        setStats(numbers);
        setCafe(menu);
        setNeedsLogin(false);
      })
      .catch((error) => {
        if (error instanceof ApiError && error.status === 401) setNeedsLogin(true);
      });
  }, [slug]);

  useEffect(load, [load]);
  useLiveEvents<Order>(needsLogin ? null : `/c/${slug}/stream`, 'order', load, load);

  if (needsLogin) return <StaffGate slug={slug!} onDone={load} />;
  if (!stats || !cafe) return <p className="centered">…</p>;

  const setSoldOut = async (itemId: number, soldOut: boolean) => {
    // Tick the box straight away, and put it back if the save fails.
    const before = cafe;
    setCafe({
      ...cafe,
      categories: cafe.categories.map((category) => ({
        ...category,
        items: category.items.map((item) => (item.id === itemId ? { ...item, soldOut } : item)),
      })),
    });
    try {
      setCafe(await api<Cafe>(`/c/${slug}/items/${itemId}`, { method: 'PATCH', body: { soldOut } }));
    } catch {
      setCafe(before);
    }
  };

  const change = stats.revenueYesterday > 0 ? Math.round(((stats.revenueToday - stats.revenueYesterday) / stats.revenueYesterday) * 100) : null;
  const busiest = Math.max(...stats.byHour.map((hour) => hour.orders), 1);
  const topMost = Math.max(...stats.topItems.map((item) => item.quantity), 1);

  return (
    <div className="owner">
      <dl className="tiles">
        <div>
          <dt>Sales today</dt>
          <dd data-testid="revenue-today">{formatGel(stats.revenueToday)}</dd>
          {change !== null && <dd className="tile__note">{change >= 0 ? '+' : ''}{change}% vs all of yesterday</dd>}
        </div>
        <div><dt>Orders today</dt><dd>{stats.ordersToday}</dd></div>
        <div><dt>Average order</dt><dd>{formatGel(stats.averageOrder)}</dd><dd className="tile__note">last 7 days</dd></div>
        <div>
          <dt>Time to prepare</dt>
          <dd>{stats.averagePrepMinutes === null ? '–' : `${stats.averagePrepMinutes} min`}</dd>
          <dd className="tile__note">last 7 days</dd>
        </div>
      </dl>

      <div className="owner__grid">
        <section>
          <h2>Busiest hours</h2>
          <p className="owner__sub">Orders by hour, last 30 days</p>
          <ol className="hours">
            {stats.byHour.map((hour) => (
              <li key={hour.hour} title={`${hour.hour}:00, ${hour.orders} orders`}>
                <i style={{ height: `${(hour.orders / busiest) * 100}%` }} />
                <span>{hour.hour}</span>
              </li>
            ))}
          </ol>
        </section>

        <section>
          <h2>Best sellers</h2>
          <p className="owner__sub">Last 30 days</p>
          <ol className="sellers">
            {stats.topItems.map((item) => (
              <li key={item.name}>
                <div><span>{item.name}</span><span>{item.quantity} sold · {formatGel(item.revenue)}</span></div>
                <i style={{ width: `${(item.quantity / topMost) * 100}%` }} />
              </li>
            ))}
          </ol>
        </section>
      </div>

      <section className="stock">
        <h2>Menu</h2>
        <p className="owner__sub">Mark something as sold out, and it changes on every customer&rsquo;s phone straight away.</p>
        <ul>
          {cafe.categories.flatMap((category) => category.items).map((item) => (
            <li key={item.id}>
              <label>
                <input type="checkbox" checked={item.soldOut} onChange={(event) => setSoldOut(item.id, event.target.checked)} data-testid={`sold-out-${item.id}`} />
                <span>{item.name}</span>
              </label>
              <span>{item.soldOut ? 'Sold out' : formatGel(item.priceTetri)}</span>
            </li>
          ))}
        </ul>
      </section>

      <p className="owner__foot"><Link to={`/c/${slug}/tables`} target="_top">Print the QR codes for your tables →</Link></p>
    </div>
  );
}
