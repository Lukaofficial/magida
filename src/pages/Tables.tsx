import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import QRCode from 'qrcode';
import type { Cafe } from '../../shared/types.ts';
import { api } from '../lib/api.ts';

/** One QR code per table, ready to print. Each one opens the menu with that table already set. */
export function Tables() {
  const { slug } = useParams();
  const [cafe, setCafe] = useState<Cafe | null>(null);
  const [codes, setCodes] = useState<string[]>([]);

  useEffect(() => {
    api<Cafe>(`/c/${slug}`).then(async (loaded) => {
      setCafe(loaded);
      setCodes(await Promise.all(loaded.tableNumbers.map((table) => QRCode.toString(`${location.origin}/c/${slug}/t/${table}`, { type: 'svg', margin: 1 }))));
    });
  }, [slug]);

  if (!cafe) return <p className="centered">…</p>;
  return (
    <div className="tables">
      <header className="tables__head">
        <h1>{cafe.name}: table QR codes</h1>
        <button type="button" className="quiet" onClick={() => window.print()}>Print</button>
      </header>
      <ul>
        {codes.map((svg, index) => (
          <li key={index} data-testid="qr">
            <div dangerouslySetInnerHTML={{ __html: svg }} />
            <strong>Table {cafe.tableNumbers[index]}</strong>
            <span>Scan to order</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
