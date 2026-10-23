'use client';

export default function ErrorPage({ retry }) {
  return (
    <main>
      <h1>Something went wrong</h1>
      <button type="button" onClick={() => retry()}>
        Retry
      </button>
    </main>
  );
}
