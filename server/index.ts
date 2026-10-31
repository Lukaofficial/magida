import { createApp } from './app.ts';
import { openDatabase } from './db.ts';
import { deleteOldDemoCafes } from './repo.ts';

const PORT = Number(process.env.PORT ?? 3210);
const production = process.env.NODE_ENV === 'production';
const db = openDatabase(process.env.DATABASE_PATH ?? 'magida.db');

const app = createApp({ db, secret: process.env.SESSION_SECRET, secure: production });
app.listen(PORT, () => console.log(`Magida is running on http://localhost:${PORT}`));

// Each demo visitor gets a private cafe, so clear out the old ones.
setInterval(() => deleteOldDemoCafes(db, new Date(Date.now() - 3 * 3600_000)), 15 * 60_000).unref();
