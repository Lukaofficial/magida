import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { formatTbilisiTime } from '../../shared/floor.ts';
import type { Reservation } from '../../shared/floor.ts';
import { api } from '../lib/api.ts';

const TITLES: Record<Reservation['status'], string> = {
  confirmed: 'Your table is booked',
  arrived: 'Welcome',
  cancelled: 'Booking cancelled',
  'no-show': 'We missed you',
};

/** A guest's own booking, at a private link that they can come back to. */
export function ReservationView() {
  const { slug, publicId } = useParams();
  const [booking, setBooking] = useState<Reservation | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    api<Reservation>(`/reservations/${publicId}`).then(setBooking).catch((error) => setFailed(error.message));
  }, [publicId]);

  const cancel = async () => {
    try {
      setBooking(await api<Reservation>(`/reservations/${publicId}/cancel`, { method: 'POST' }));
    } catch (error) {
      setFailed(error instanceof Error ? error.message : 'That didn’t work.');
    }
  };

  if (!booking) return <p className="centered">{failed ?? '…'}</p>;
  const day = new Date(booking.startsAt).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Tbilisi' });

  return (
    <main className="booking menu" data-testid="booking" data-status={booking.status}>
      <h1>{TITLES[booking.status]}</h1>
      <dl>
        <div><dt>Table</dt><dd>{booking.tableNumber}</dd></div>
        <div><dt>When</dt><dd>{day}, {formatTbilisiTime(booking.startsAt)}</dd></div>
        <div><dt>For</dt><dd>{booking.partySize} {booking.partySize === 1 ? 'person' : 'people'}</dd></div>
        <div><dt>Name</dt><dd>{booking.guestName}</dd></div>
      </dl>
      {failed && <p role="alert">{failed}</p>}
      {booking.status === 'confirmed' && <p>The table is yours for 90 minutes. Keep this page to change your plans.</p>}
      {booking.status === 'confirmed' ? (
        <button type="button" className="quiet" onClick={cancel} data-testid="booking-cancel">Cancel this booking</button>
      ) : (
        <Link to={`/c/${slug}/reserve`}>Book another table</Link>
      )}
    </main>
  );
}
