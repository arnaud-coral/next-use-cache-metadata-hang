# HTML response never finishes when a failing `'use cache'` function is also read by `generateMetadata` (Partial Prefetching)

## Versions

- `next` 16.4.2 and 16.4.3 (both reproduced with the app below). `createTrackedReadableStream` is unchanged in 16.5.0-canary.25 (code inspected, not run).
- `react` and `react-dom` 19.3.1, Node.js 24.15.0, Linux x64.
- Production server (`next build` then `next start`).

## Configuration

```js
// next.config.mjs
export default {
  cacheComponents: true,
  partialPrefetching: true,
};
```

## Minimal reproduction

```json
// package.json
{
  "private": true,
  "scripts": { "build": "next build", "start": "next start" },
  "dependencies": { "next": "16.4.3", "react": "19.3.1", "react-dom": "19.3.1" }
}
```

```js
// lib/data.js
import { cacheLife } from 'next/cache';

// Stands in for a backend that is down: every read fails.
export async function getItem(id) {
  'use cache';
  cacheLife('hours');
  throw new Error(`Backend unavailable while reading item ${id}`);
}
```

```jsx
// app/items/[id]/page.jsx
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
```

```jsx
// app/error.jsx
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
```

```jsx
// app/layout.jsx
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

Steps:

```sh
npm install
npx next build
npx next start --port 3390
curl -s -m 10 -o page.html -w 'code=%{http_code} first_byte=%{time_starttransfer}s total=%{time_total}s\n' http://127.0.0.1:3390/items/1
echo "curl exit code: $?"; grep -c '</html>' page.html
```

## Expected

The request fails fast: the error UI from `error.js` (or a 500 page), and a document that ends with `</html>`.

## Actual

```
code=200 first_byte=0.016154s total=10.002579s
curl exit code: 28
0
```

The headers and the shell are sent within 20 ms, then the response stays open until the client gives up. The body is the `<html id="__next_error__">` error document and stops in the middle of the inlined RSC payload, without `</html>`. A browser never fires `load` (in our application, Playwright's `page.goto` times out). Every such request keeps its socket open, which matters precisely when a backend is down and every page view fails. The server logs the error once (`⨯ Error: Backend unavailable while reading item 1`).

Controls, same app (time for the same `curl`):

| Change | Result |
|--------|--------|
| none | hangs, cut by curl at 10 s |
| `generateMetadata` does not call `getItem` | completes in 54 ms |
| `partialPrefetching: false` | completes in 53 ms |
| `app/error.jsx` removed | still hangs (the error boundary is not needed) |
| fix below applied to `node_modules/next` | completes in 53 ms (16.4.2 and 16.4.3) |

A client navigation (RSC request) to the same route completes normally (13 ms, stream closed), since it has no shell error recovery.

## Cause

1. The page throws outside any `<Suspense>`, so the render goes through the shell error recovery of `renderToStream` in `app-render`. `getErrorRSCPayload(tree, ctx, err, errorType, true)` builds the error payload with the metadata of the same tree, and renders it in a second Flight render, with the same request store.
2. That render calls `generateMetadata` again, which calls `getItem(id)` again. The failed entry is found in the request's resume data cache (filled by the first call). `collectResult` saved it with a stream that ends with the captured error.
3. Because the request store has a `cacheSignal` (Partial Prefetching), the entry is served through `createTrackedReadableStream`:

   ```ts
   async pull(controller) {
     const { done, value } = await reader.read() // rejects for the errored entry
     if (done) {
       controller.close()
       cacheSignal.endRead()
     } else {
       controller.enqueue(value)
     }
   },
   ```

   `reader.read()` rejects, `pull` rejects, and `cacheSignal.endRead()` is never called. The signal's count stays at 1.
4. `cacheSignal.cacheReady()` therefore never resolves. The deferred `startRuntimePrefetchRender` never reaches `spawnRuntimePrefetchWithFilledCaches`, and the writable side of `runtimePrefetchStream` (field `p` of the initial RSC payload) is never closed.
5. The main Flight stream, which the error document inlines, cannot complete while `p` is open, so `</body></html>` is never written.

Side effect: `trackPendingModules` unsubscribes the request's `CacheSignal` from the module-loading signal only when `cacheReady()` resolves, so every hanging request also stays subscribed.

Instrumenting `CacheSignal` (in memory) on the failing request shows the last `beginRead` (count 1), the tracked stream erroring, and no `cacheReady` resolution afterwards. On a successful entry, `cacheReady` resolves within milliseconds.

## Proposed fix

End the read when the tracked stream errors. Applied to the published files and tested on 16.4.2 and 16.4.3 (all our end-to-end tests pass with it, including the outage cases above):

```diff
diff --git a/dist/esm/server/use-cache/use-cache-wrapper.js b/dist/esm/server/use-cache/use-cache-wrapper.js
--- a/dist/esm/server/use-cache/use-cache-wrapper.js
+++ b/dist/esm/server/use-cache/use-cache-wrapper.js
@@ -1103,7 +1103,14 @@ function createTrackedReadableStream(stream, cacheSignal) {
     const reader = stream.getReader();
     return new ReadableStream({
         async pull (controller) {
-            const { done, value } = await reader.read();
+            let result;
+            try {
+                result = await reader.read();
+            } catch (error) {
+                cacheSignal.endRead();
+                throw error;
+            }
+            const { done, value } = result;
             if (done) {
                 controller.close();
                 cacheSignal.endRead();
diff --git a/dist/server/use-cache/use-cache-wrapper.js b/dist/server/use-cache/use-cache-wrapper.js
--- a/dist/server/use-cache/use-cache-wrapper.js
+++ b/dist/server/use-cache/use-cache-wrapper.js
@@ -1159,7 +1159,14 @@ function createTrackedReadableStream(stream, cacheSignal) {
     const reader = stream.getReader();
     return new ReadableStream({
         async pull (controller) {
-            const { done, value } = await reader.read();
+            let result;
+            try {
+                result = await reader.read();
+            } catch (error) {
+                cacheSignal.endRead();
+                throw error;
+            }
+            const { done, value } = result;
             if (done) {
                 controller.close();
                 cacheSignal.endRead();
```

The same change in the source, `packages/next/src/server/use-cache/use-cache-wrapper.ts` (not built from source on our side):

```diff
   const reader = stream.getReader()
   return new ReadableStream({
     async pull(controller) {
-      const { done, value } = await reader.read()
+      let result
+      try {
+        result = await reader.read()
+      } catch (error) {
+        // An errored entry must still end its read, or cacheReady() never resolves.
+        cacheSignal.endRead()
+        throw error
+      }
+      const { done, value } = result
       if (done) {
         controller.close()
         cacheSignal.endRead()
```

Open question: if the consumer cancels the tracked stream, `pull` is not called again and `endRead()` is skipped as well. We did not observe it, but a `cancel()` handler that ends the read (once) may be worth adding.
