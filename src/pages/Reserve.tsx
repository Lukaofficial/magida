import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { bookingSlots, slotToIso, tbilisiDate } from '../../shared/floor.ts';
import type { Availability, FloorPlan, FloorTable, Reservation } from '../../shared/floor.ts';
import type { Cafe } from '../../shared/types.ts';
import { ApiError, api, useLiveEvents } from '../lib/api.ts';
import { FloorPlanView } from './FloorPlanView.tsx';

type Lang = 'en' | 'ka';

const TEXT = {
  en: {
    book: 'Book a table', date: 'Date', time: 'Time', party: 'How many people?', pick: 'Tap a green table to book it.', none: 'Nothing fits at this time. Try another time.',
    tableFor: 'Table', seats: 'seats', name: 'Your name', phone: 'Phone number', confirm: 'Book this table', sending: 'Booking…', free: 'Free', taken: 'Booked', small: 'Too small',
    gone: 'Someone just booked that table. Please pick another.', failed: 'That didn’t go through. Please try again.', past: 'That time has passed.',
  },
  ka: {
    book: 'მაგიდის დაჯავშნა', date: 'თარიღი', time: 'დრო', party: 'რამდენი კაცი იქნებით?', pick: 'დასაჯავშნად აირჩიეთ მწვანე მაგიდა.', none: 'ამ დროს თავისუფალი მაგიდა არ არის. სცადეთ სხვა დრო.',
    tableFor: 'მაგიდა', seats: 'ადგილი', name: 'თქვენი სახელი', phone: 'ტელეფონის ნომერი', confirm: 'მაგიდის დაჯავშნა', sending: 'იჯავშნება…', free: 'თავისუფალი', taken: 'დაჯავშნილი', small: 'პატარაა',
    gone: 'ეს მაგიდა ახლახან დაიჯავშნა. გთხოვთ, აირჩიოთ სხვა.', failed: 'ვერ დაიჯავშნა. გთხოვთ, სცადოთ თავიდან.', past: 'ეს დრო უკვე გავიდა.',
  },
} as const;

const SLOTS = bookingSlots();
const DAYS = 14;

function firstFreeSlot(date: string, now: Date) {
  return SLOTS.find((slot) => new Date(slotToIso(date, slot)!) > now) ?? null;
}

/** Choosing a table on a map of the room, rather than from a list of numbers. */
export function Reserve() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const [now] = useState(() => new Date());
  const [lang, setLang] = useState<Lang>('en');
  const [cafe, setCafe] = useState<Cafe | null>(null);
  const [plan, setPlan] = useState<FloorPlan | null>(null);
  const [date, setDate] = useState(() => tbilisiDate(now, firstFreeSlot(tbilisiDate(now), now) ? 0 : 1));
  const [time, setTime] = useState(() => firstFreeSlot(date, now) ?? '19:00');
  const [party, setParty] = useState(2);
  const [taken, setTaken] = useState<number[] | null>(null);
  const [chosen, setChosen] = useState<FloorTable | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  const t = TEXT[lang];

  const loadPlan = useCallback(() => {
    api<FloorPlan>(`/c/${slug}/floor`).then(setPlan).catch(() => setMessage(TEXT.en.failed));
  }, [slug]);

  const loadAvailability = useCallback(() => {
    api<Availability>(`/c/${slug}/availability?date=${date}&time=${time}`)
      .then((result) => setTaken(result.takenTableIds))
      .catch(() => setMessage(TEXT.en.failed));
  }, [slug, date, time]);

  useEffect(() => {
    api<Cafe>(`/c/${slug}`).then(setCafe).catch(() => setMessage(TEXT.en.failed));
    loadPlan();
  }, [slug, loadPlan]);
  useEffect(loadAvailability, [loadAvailability]);

  // Someone else booking, or the owner moving a table, updates this map as you look at it.
  const refresh = useRef(() => {});
  useEffect(() => {
    refresh.current = () => {
      loadPlan();
      loadAvailability();
    };
  });
  useLiveEvents<unknown>(`/c/${slug}/menu-stream`, 'availability', () => refresh.current(), () => refresh.current());

  // If the table you were looking at just went, say so rather than failing later.
  useEffect(() => {
    if (chosen?.id !== undefined && taken?.includes(chosen.id)) {
      setChosen(null);
      setMessage(t.gone);
    }
  }, [taken, chosen, t.gone]);

  const dates = Array.from({ length: DAYS }, (_, index) => tbilisiDate(now, index)).filter((day) => firstFreeSlot(day, now));
  const slots = SLOTS.filter((slot) => new Date(slotToIso(date, slot)!) > now);
  const fits = (table: FloorTable) => table.seats >= party;
  const isFree = (table: FloorTable) => table.id !== undefined && !taken?.includes(table.id);
  const state = (table: FloorTable) => (chosen?.id === table.id ? 'selected' : !isFree(table) ? 'taken' : !fits(table) ? 'small' : 'free');
  const anyFree = plan?.tables.some((table) => isFree(table) && fits(table));

  const pick = (table: FloorTable) => {
    setChosen(table);
    setMessage(null);
  };
  const changeDate = (next: string) => {
    setDate(next);
    setChosen(null);
    const first = firstFreeSlot(next, now);
    if (first && new Date(slotToIso(next, time)!) <= now) setTime(first);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!chosen) return;
    setSending(true);
    setMessage(null);
    try {
      const booking = await api<Reservation>(`/c/${slug}/reservations`, {
        method: 'POST',
        body: { tableId: chosen.id, partySize: party, date, time, name, phone, clientKey: key.current },
      });
      navigate(`/c/${slug}/booking/${booking.publicId}`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setChosen(null);
        key.current = crypto.randomUUID();
        setMessage(t.gone);
        loadAvailability();
      } else {
        setMessage(error instanceof ApiError ? error.message : t.failed);
      }
    } finally {
      setSending(false);
    }
  };

  if (!plan || !cafe) return <p className="centered">{message ?? '…'}</p>;
  const dateLabel = (day: string) =>
    new Date(`${day}T12:00:00+04:00`).toLocaleDateString(lang === 'ka' ? 'ka-GE' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Tbilisi' });

  return (
    <div className="menu" lang={lang} data-testid="reserve">
      <header className="menu__head">
        <div>
          <h1>{cafe.name}</h1>
          <p>{t.book}</p>
        </div>
        <button type="button" className="lang" onClick={() => setLang(lang === 'en' ? 'ka' : 'en')} aria-label="Change language">
          {lang === 'en' ? 'ქარ' : 'ENG'}
        </button>
      </header>

      <div className="reserve__controls">
        <label>
          {t.date}
          <select value={date} onChange={(event) => changeDate(event.target.value)} data-testid="booking-date">
            {dates.map((day) => <option key={day} value={day}>{dateLabel(day)}</option>)}
          </select>
        </label>
        <label>
          {t.time}
          <select
            value={time}
            onChange={(event) => {
              setTime(event.target.value);
              setChosen(null);
            }}
            data-testid="booking-time"
          >
            {slots.map((slot) => <option key={slot} value={slot}>{slot}</option>)}
          </select>
        </label>
      </div>
      <div className="reserve__party">
        <span>{t.party}</span>
        <span className="stepper">
          <button type="button" onClick={() => { setParty(Math.max(party - 1, 1)); setChosen(null); }} aria-label="Fewer people">−</button>
          <span data-testid="party" aria-live="polite">{party}</span>
          <button type="button" onClick={() => { setParty(Math.min(party + 1, 12)); setChosen(null); }} aria-label="More people">+</button>
        </span>
      </div>

      <div className="reserve__plan">
        <FloorPlanView
          plan={plan}
          stateOf={state}
          canPress={(table) => isFree(table) && fits(table)}
          onPress={pick}
          describe={(table) => `${t.tableFor} ${table.number}, ${table.seats} ${t.seats}, ${!isFree(table) ? t.taken : !fits(table) ? t.small : t.free}`}
        />
        <ul className="plan-key" aria-hidden="true">
          <li><i style={{ background: '#e6f1e8', borderColor: 'var(--green)' }} /> {t.free}</li>
          <li><i style={{ background: '#ddd5c5', borderColor: '#a79c88', borderStyle: 'dashed' }} /> {t.taken}</li>
          <li><i style={{ background: '#f3eee3', borderColor: '#c4b9a4' }} /> {t.small}</li>
        </ul>
      </div>

      {message && <p className="reserve__hint" role="alert">{message}</p>}

      {chosen ? (
        <form className="reserve__form" onSubmit={submit}>
          <h2>{t.tableFor} {chosen.number} · {chosen.seats} {t.seats}</h2>
          <label>
            {t.name}
            <input value={name} maxLength={60} autoComplete="name" required onChange={(event) => setName(event.target.value)} data-testid="booking-name" />
          </label>
          <label>
            {t.phone}
            <input value={phone} type="tel" autoComplete="tel" required placeholder="+995 5XX XX XX XX" onChange={(event) => setPhone(event.target.value)} data-testid="booking-phone" />
          </label>
          <button type="submit" className="big" disabled={sending} data-testid="booking-confirm"><span>{sending ? t.sending : t.confirm}</span></button>
        </form>
      ) : (
        !message && <p className="reserve__hint">{taken && !anyFree ? t.none : t.pick}</p>
      )}
    </div>
  );
}
