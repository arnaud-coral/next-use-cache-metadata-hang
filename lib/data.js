import { cacheLife } from 'next/cache';

// Stands in for a backend that is down: every read fails.
export async function getItem(id) {
  'use cache';
  cacheLife('hours');
  throw new Error(`Backend unavailable while reading item ${id}`);
}
