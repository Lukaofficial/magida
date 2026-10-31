/** The shapes the server sends and the client reads. Money is always whole tetri (100 tetri = 1 GEL). */

export type OrderStatus = 'new' | 'preparing' | 'ready' | 'served' | 'cancelled';

export type MenuItem = {
  id: number;
  name: string;
  nameKa: string;
  description: string;
  descriptionKa: string;
  priceTetri: number;
  soldOut: boolean;
};

export type MenuCategory = {
  id: number;
  name: string;
  nameKa: string;
  items: MenuItem[];
};

export type Cafe = {
  slug: string;
  name: string;
  tableNumbers: number[];
  categories: MenuCategory[];
};

export type OrderLine = {
  name: string;
  nameKa: string;
  priceTetri: number;
  quantity: number;
};

export type Order = {
  publicId: string;
  tableNumber: number;
  status: OrderStatus;
  note: string;
  totalTetri: number;
  createdAt: string;
  lines: OrderLine[];
};

export type Stats = {
  revenueToday: number;
  revenueYesterday: number;
  ordersToday: number;
  averageOrder: number;
  averagePrepMinutes: number | null;
  topItems: { name: string; quantity: number; revenue: number }[];
  byHour: { hour: number; orders: number }[];
};

export function formatGel(tetri: number): string {
  return `${(tetri / 100).toFixed(2).replace(/\.00$/, '')} ₾`;
}
