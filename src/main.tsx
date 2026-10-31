import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import '@fontsource-variable/fraunces';
import '@fontsource-variable/dm-sans';
import '@fontsource/noto-sans-georgian/400.css';
import '@fontsource/noto-sans-georgian/600.css';
import { Home } from './pages/Home.tsx';
import { Floor } from './pages/Floor.tsx';
import { Kitchen } from './pages/Kitchen.tsx';
import { Menu } from './pages/Menu.tsx';
import { Owner } from './pages/Owner.tsx';
import { Reserve } from './pages/Reserve.tsx';
import { ReservationView } from './pages/ReservationView.tsx';
import { Tables } from './pages/Tables.tsx';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/c/:slug/t/:table" element={<Menu />} />
        <Route path="/c/:slug/reserve" element={<Reserve />} />
        <Route path="/c/:slug/booking/:publicId" element={<ReservationView />} />
        <Route path="/c/:slug/floor" element={<Floor />} />
        <Route path="/c/:slug/kitchen" element={<Kitchen />} />
        <Route path="/c/:slug/owner" element={<Owner />} />
        <Route path="/c/:slug/tables" element={<Tables />} />
        <Route path="*" element={<p className="centered">Page not found.</p>} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
