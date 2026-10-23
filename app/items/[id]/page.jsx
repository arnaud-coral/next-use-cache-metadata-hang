import { getItem } from '../../../lib/data';

// The item is read before any <Suspense>, so the route must allow a blocking render.
export const instant = false;

export async function generateMetadata({ params }) {
  const { id } = await params;
  const item = await getItem(id);
  return { title: item.name };
}

export default async function ItemPage({ params }) {
  const { id } = await params;
  const item = await getItem(id);
  return <h1>{item.name}</h1>;
}
