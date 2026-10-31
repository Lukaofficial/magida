import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:3210' } },
  test: { include: ['server/**/*.test.ts', 'src/**/*.test.{ts,tsx}'], testTimeout: 15_000 },
});
