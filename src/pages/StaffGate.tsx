import { useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../lib/api.ts';

/** Asks for the staff PIN when a kitchen or owner page gets a "log in first" from the server. */
export function StaffGate({ slug, onDone }: { slug: string; onDone: () => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api(`/c/${slug}/login`, { method: 'POST', body: { pin } });
      onDone();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Couldn’t log in.');
    }
  };

  return (
    <form className="gate" onSubmit={submit}>
      <h1>Staff only</h1>
      <label htmlFor="pin">PIN</label>
      <input id="pin" type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(event) => setPin(event.target.value)} />
      {error && <p role="alert">{error}</p>}
      <button type="submit" className="big"><span>Log in</span></button>
    </form>
  );
}
