import { useEffect } from 'react';

export class ApiError extends Error {
  status: number;
  data: Record<string, unknown>;

  constructor(status: number, message: string, data: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, data.error ?? 'Something went wrong.', data);
  return data as T;
}

/**
 * Listens to a live stream from the server. The browser reconnects by itself if the connection drops,
 * and `onReconnect` then lets the page catch up on anything it missed.
 */
export function useLiveEvents<T>(path: string | null, event: string | string[], onEvent: (data: T) => void, onReconnect?: () => void) {
  const events = [event].flat().join(',');
  useEffect(() => {
    if (!path) return;
    const source = new EventSource(`/api${path}`);
    let opened = false;
    source.onopen = () => {
      if (opened) onReconnect?.();
      opened = true;
    };
    const listener = (message: MessageEvent) => onEvent(JSON.parse(message.data) as T);
    for (const name of events.split(',')) source.addEventListener(name, listener);
    return () => source.close();
    // The handlers only ever set state, so reconnecting when they change would just drop the stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, events]);
}
