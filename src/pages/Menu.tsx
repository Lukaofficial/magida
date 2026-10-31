import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { formatGel } from '../../shared/types.ts';
import type { Cafe, MenuItem, Order, OrderStatus } from '../../shared/types.ts';
import { ApiError, api, useLiveEvents } from '../lib/api.ts';

type Lang = 'en' | 'ka';

const TEXT = {
  en: {
    table: 'Table', add: 'Add', soldOut: 'Sold out', basket: 'Your order', note: 'Anything the kitchen should know?',
    place: 'Send to kitchen', sending: 'Sending…', payLater: 'You pay at the counter when you’re done.', view: 'View order', items: 'items',
    orderMore: 'Order something else', total: 'Total', soldOutNow: 'Sorry, that just sold out. It’s been removed from your order.',
    failed: 'That didn’t go through. Your order is still here, so try again.',
    new: ['Sent to the kitchen', 'They’ll start on it in a moment.'], preparing: ['Being made', 'Your order is being prepared now.'],
    ready: ['Ready', 'It’s on its way to your table.'], served: ['Enjoy', 'Pay at the counter when you’re ready.'], cancelled: ['Cancelled', 'Please ask a member of staff.'],
  },
  ka: {
    table: 'მაგიდა', add: 'დამატება', soldOut: 'ამოიწურა', basket: 'თქვენი შეკვეთა', note: 'რამე უნდა იცოდეს სამზარეულომ?',
    place: 'სამზარეულოში გაგზავნა', sending: 'იგზავნება…', payLater: 'გადახდა სალაროსთან, როცა მოგიხერხდებათ.', view: 'შეკვეთის ნახვა', items: 'ერთეული',
    orderMore: 'კიდევ რამის შეკვეთა', total: 'ჯამი', soldOutNow: 'ბოდიში, ეს ახლახან ამოიწურა და შეკვეთიდან ამოვიღეთ.',
    failed: 'ვერ გაიგზავნა. შეკვეთა შენახულია, სცადეთ თავიდან.',
    new: ['გაიგზავნა სამზარეულოში', 'მალე დაიწყებენ მომზადებას.'], preparing: ['მზადდება', 'თქვენი შეკვეთა ახლა მზადდება.'],
    ready: ['მზადაა', 'უკვე მოაქვთ თქვენს მაგიდასთან.'], served: ['გემრიელად მიირთვით', 'გადახდა სალაროსთან, როცა მოგიხერხდებათ.'], cancelled: ['გაუქმდა', 'გთხოვთ, მიმართოთ პერსონალს.'],
  },
} as const;

const STEPS: OrderStatus[] = ['new', 'preparing', 'ready', 'served'];

function newKey() {
  return crypto.randomUUID();
}

/** What a customer sees after scanning the QR code on their table. */
export function Menu() {
  const { slug, table } = useParams();
  const tableNumber = Number(table);
  const [cafe, setCafe] = useState<Cafe | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [lang, setLang] = useState<Lang>('en');
  const [basket, setBasket] = useState<Record<number, number>>({});
  const [note, setNote] = useState('');
  const [basketOpen, setBasketOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  // Kept across retries, so that resending after a dropped connection can't create a second order.
  const orderKey = useRef(newKey());
  const t = TEXT[lang];

  useEffect(() => {
    api<Cafe>(`/c/${slug}`).then(setCafe).catch(() => setLoadError(true));
  }, [slug]);

  useLiveEvents<Cafe>(`/c/${slug}/menu-stream`, 'menu', (menu) => {
    setCafe(menu);
    const gone = new Set(menu.categories.flatMap((category) => category.items).filter((item) => item.soldOut).map((item) => item.id));
    setBasket((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !gone.has(Number(id)))));
  });
  useLiveEvents<Order>(order ? `/orders/${order.publicId}/stream` : null, 'order', setOrder, () => {
    if (order) api<Order>(`/orders/${order.publicId}`).then(setOrder).catch(() => {});
  });

  const items = useMemo(() => cafe?.categories.flatMap((category) => category.items) ?? [], [cafe]);
  const lines = items.filter((item) => basket[item.id]).map((item) => ({ item, quantity: basket[item.id] }));
  const count = lines.reduce((sum, line) => sum + line.quantity, 0);
  const total = lines.reduce((sum, line) => sum + line.item.priceTetri * line.quantity, 0);
  const change = (id: number, by: number) =>
    setBasket((current) => {
      const next = { ...current, [id]: Math.max((current[id] ?? 0) + by, 0) };
      if (next[id] === 0) delete next[id];
      return next;
    });

  const send = async () => {
    setSending(true);
    setMessage(null);
    try {
      const placed = await api<Order>(`/c/${slug}/orders`, {
        method: 'POST',
        body: { tableNumber, note, clientKey: orderKey.current, items: lines.map((line) => ({ itemId: line.item.id, quantity: line.quantity })) },
      });
      setOrder(placed);
      setBasket({});
      setNote('');
      setBasketOpen(false);
      orderKey.current = newKey();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const gone = (error.data.itemIds as number[]) ?? [];
        setBasket((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !gone.includes(Number(id)))));
        orderKey.current = newKey();
        setMessage(t.soldOutNow);
      } else {
        setMessage(t.failed);
      }
    } finally {
      setSending(false);
    }
  };

  if (loadError) return <p className="centered">This menu isn&rsquo;t available. Please ask a member of staff.</p>;
  if (!cafe) return <p className="centered">…</p>;

  const name = (item: { name: string; nameKa: string }) => (lang === 'ka' ? item.nameKa : item.name);

  return (
    <div className="menu" lang={lang}>
      <header className="menu__head">
        <div>
          <h1>{cafe.name}</h1>
          <p>{t.table} {tableNumber}</p>
        </div>
        <button type="button" className="lang" onClick={() => setLang(lang === 'en' ? 'ka' : 'en')} aria-label="Change language">
          {lang === 'en' ? 'ქარ' : 'ENG'}
        </button>
      </header>

      {order && !basketOpen ? (
        <OrderTracker order={order} lang={lang} onMore={() => setOrder(null)} />
      ) : (
        <main className="menu__list">
          {cafe.categories.map((category) => (
            <section key={category.id}>
              <h2>{name(category)}</h2>
              {category.items.map((item) => (
                <Dish key={item.id} item={item} lang={lang} quantity={basket[item.id] ?? 0} onChange={(by) => change(item.id, by)} />
              ))}
            </section>
          ))}
        </main>
      )}

      {count > 0 && !basketOpen && (
        <div className="menu__bar">
          <button type="button" className="big" onClick={() => setBasketOpen(true)} data-testid="view-basket">
            <span>{t.view} · {count}</span>
            <span>{formatGel(total)}</span>
          </button>
        </div>
      )}

      {basketOpen && (
        <div className="sheet" role="dialog" aria-label={t.basket}>
          <div className="sheet__top">
            <h2>{t.basket}</h2>
            <button type="button" className="sheet__close" onClick={() => setBasketOpen(false)} aria-label="Close">×</button>
          </div>
          <ul className="basket">
            {lines.map(({ item, quantity }) => (
              <li key={item.id}>
                <span className="basket__name">{name(item)}</span>
                <Stepper quantity={quantity} onChange={(by) => change(item.id, by)} label={name(item)} />
                <span className="basket__price">{formatGel(item.priceTetri * quantity)}</span>
              </li>
            ))}
          </ul>
          <textarea value={note} maxLength={140} onChange={(event) => setNote(event.target.value)} placeholder={t.note} rows={2} />
          {message && <p className="sheet__message" role="alert">{message}</p>}
          <p className="basket__total"><span>{t.total}</span><strong>{formatGel(total)}</strong></p>
          <button type="button" className="big" disabled={sending || count === 0} onClick={send} data-testid="send-order">
            <span>{sending ? t.sending : t.place}</span>
          </button>
          <p className="sheet__hint">{t.payLater}</p>
        </div>
      )}
    </div>
  );
}

function Stepper({ quantity, onChange, label }: { quantity: number; onChange: (by: number) => void; label: string }) {
  return (
    <span className="stepper">
      <button type="button" onClick={() => onChange(-1)} aria-label={`One less ${label}`}>−</button>
      <span aria-live="polite">{quantity}</span>
      <button type="button" onClick={() => onChange(1)} disabled={quantity >= 20} aria-label={`One more ${label}`}>+</button>
    </span>
  );
}

function Dish({ item, lang, quantity, onChange }: { item: MenuItem; lang: Lang; quantity: number; onChange: (by: number) => void }) {
  const t = TEXT[lang];
  const name = lang === 'ka' ? item.nameKa : item.name;
  return (
    <article className={item.soldOut ? 'dish dish--out' : 'dish'} data-testid="dish">
      <div>
        <h3>{name}</h3>
        <p>{lang === 'ka' ? item.descriptionKa : item.description}</p>
        <p className="dish__price">{formatGel(item.priceTetri)}</p>
      </div>
      {item.soldOut ? (
        <span className="dish__out">{t.soldOut}</span>
      ) : quantity > 0 ? (
        <Stepper quantity={quantity} onChange={onChange} label={name} />
      ) : (
        <button type="button" className="dish__add" onClick={() => onChange(1)} aria-label={`${t.add}: ${name}`}>{t.add}</button>
      )}
    </article>
  );
}

function OrderTracker({ order, lang, onMore }: { order: Order; lang: Lang; onMore: () => void }) {
  const t = TEXT[lang];
  const [title, detail] = t[order.status];
  const step = STEPS.indexOf(order.status);
  return (
    <main className="tracker" data-testid="tracker" data-status={order.status}>
      <h2>{title}</h2>
      <p>{detail}</p>
      {order.status !== 'cancelled' && (
        <ol className="tracker__steps" aria-hidden="true">
          {STEPS.map((_, index) => <li key={index} className={index <= step ? 'on' : ''} />)}
        </ol>
      )}
      <ul className="basket basket--plain">
        {order.lines.map((line, index) => (
          <li key={index}>
            <span className="basket__name">{line.quantity} × {lang === 'ka' ? line.nameKa : line.name}</span>
            <span className="basket__price">{formatGel(line.priceTetri * line.quantity)}</span>
          </li>
        ))}
      </ul>
      <p className="basket__total"><span>{t.total}</span><strong>{formatGel(order.totalTetri)}</strong></p>
      <button type="button" className="quiet" onClick={onMore}>{t.orderMore}</button>
    </main>
  );
}
