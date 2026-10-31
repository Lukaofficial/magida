import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';

/** The demo: a phone and a kitchen screen side by side. One order explains the whole product. */
export function Home() {
  const [slug, setSlug] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<'kitchen' | 'floor' | 'owner'>('kitchen');
  const [guest, setGuest] = useState<'order' | 'book'>('order');

  useEffect(() => {
    const start = async () => {
      // Keep the same private cafe through a page refresh, as long as it still exists.
      const saved = sessionStorage.getItem('magida-demo');
      if (saved && (await fetch(`/api/c/${saved}`)).ok) {
        setSlug(saved);
        return;
      }
      const created = await api<{ slug: string }>('/demo', { method: 'POST' });
      sessionStorage.setItem('magida-demo', created.slug);
      setSlug(created.slug);
    };
    start().catch(() => setFailed(true));
  }, []);

  return (
    <div className="home">
      <header className="home__head">
        <p className="home__brand">Magida <span lang="ka">მაგიდა</span></p>
        <h1>Scan the table. Order from your phone. The kitchen sees it instantly.</h1>
        <p className="home__lede">Try it: <strong>send an order from the phone</strong>, then press the kitchen&rsquo;s buttons. Or switch to <strong>Booking a table</strong> and pick one on the map.</p>
      </header>

      {failed && <p className="centered" role="alert">The demo couldn&rsquo;t start. Please refresh the page.</p>}

      <main className="demo">
        <figure className="demo__phone">
          <figcaption>
            <span className="tabs" role="group" aria-label="What the customer is doing">
              <button type="button" aria-pressed={guest === 'order'} onClick={() => setGuest('order')} data-testid="tab-order">At table 4</button>
              <button type="button" aria-pressed={guest === 'book'} onClick={() => setGuest('book')} data-testid="tab-book">Booking a table</button>
            </span>
          </figcaption>
          <div className="phone">
            {slug && guest === 'order' && <iframe title="The customer's phone, ordering" src={`/c/${slug}/t/4`} data-testid="phone-frame" />}
            {slug && guest === 'book' && <iframe title="The customer's phone, booking a table" src={`/c/${slug}/reserve`} data-testid="booking-frame" />}
          </div>
        </figure>
        <figure className="demo__staff">
          <figcaption>
            <span className="tabs" role="group" aria-label="Which screen to show">
              <button type="button" aria-pressed={view === 'kitchen'} onClick={() => setView('kitchen')} data-testid="tab-kitchen">The kitchen</button>
              <button type="button" aria-pressed={view === 'floor'} onClick={() => setView('floor')} data-testid="tab-floor">Floor plan</button>
              <button type="button" aria-pressed={view === 'owner'} onClick={() => setView('owner')} data-testid="tab-owner">The owner</button>
            </span>
          </figcaption>
          <div className="screen">
            {slug && (
              <>
                <iframe title="The kitchen screen" src={`/c/${slug}/kitchen`} hidden={view !== 'kitchen'} data-testid="kitchen-frame" />
                {view === 'floor' && <iframe title="The floor plan" src={`/c/${slug}/floor`} data-testid="floor-frame" />}
                {view === 'owner' && <iframe title="The owner's dashboard" src={`/c/${slug}/owner`} data-testid="owner-frame" />}
              </>
            )}
          </div>
        </figure>
      </main>

      <section className="why">
        <div>
          <h2>The problem</h2>
          <p>
            On a busy night in a cafe, customers wait a long time just to order, and paper tickets get lost. Magida fixes that
            with a QR code on each table: no app to download, and no new hardware beyond a tablet in the kitchen.
          </p>
        </div>
        <div>
          <h2>What&rsquo;s under the hood</h2>
          <ul>
            <li><strong>React and TypeScript</strong> for the menu, kitchen board and dashboard</li>
            <li><strong>Node and Express</strong> for the API</li>
            <li><strong>SQL</strong> (SQLite) for orders and the owner&rsquo;s reports</li>
            <li><strong>Server-Sent Events</strong> so that screens update live, without refreshing</li>
          </ul>
        </div>
        <div>
          <h2>The details that matter in a real cafe</h2>
          <ul>
            <li>Two people can&rsquo;t book one table, because the database itself refuses overlapping bookings</li>
            <li>Prices are set by the server, so nobody can edit a request and pay 1 tetri</li>
            <li>Tapping twice on bad wifi still sends only one order</li>
            <li>When something sells out, it updates on every phone</li>
            <li>English and Georgian menus, with prices in lari</li>
          </ul>
        </div>
      </section>

      <footer className="home__foot">
        <p>Built by <strong>Luka Lomadze</strong>. Café Kalaki is made up, and this demo is private to you: nobody else sees your orders.</p>
        <a href="https://github.com/Lukaofficial/magida">Source on GitHub</a>
      </footer>
    </div>
  );
}
