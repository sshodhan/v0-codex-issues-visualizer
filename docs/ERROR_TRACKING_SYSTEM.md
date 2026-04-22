# Error Tracking System (App-Specific)

This app now has a simple error tracking framework designed for Vercel Runtime Logs.

## What is captured

- **Client-side errors** from browser/runtime issues via `logClientError()`
- **Global uncaught errors** and **unhandled promise rejections** via `GlobalErrorHandler`
- **Server/API errors** via `logServer()` and `logServerError()`

## Key files

- `lib/error-tracking/client-logger.ts`
- `lib/error-tracking/server-logger.ts`
- `app/api/log-client-error/route.ts`
- `components/global-error-handler.tsx`
- `app/layout.tsx` (mounts the global handler)

## Concepts captured from the source document

1. **Client vs server split**
   - Browser code sends payloads to `/api/log-client-error`
   - API/server code logs directly via console (shows in Vercel logs)

2. **Never crash while logging**
   - Client logger swallows failures so tracking can’t break user flows
   - API endpoint hardens unknown payloads into a safe object before logging

3. **Structured context**
   - Every log includes timestamp + context fields
   - Additional metadata can be passed as `additionalInfo`

4. **Android/WebView safety**
   - `window` access is guarded
   - Dedicated helper for Android WebView detection

## Quick usage

### Client component

```tsx
import { logClientError, logLocalStorageError } from "@/lib/error-tracking/client-logger"

try {
  localStorage.getItem("key")
} catch (error) {
  logLocalStorageError(error, "getItem")
}

logClientError(new Error("Example"), "Custom Error", { feature: "dashboard" })
```

### Server route

```ts
import { logServerError } from "@/lib/error-tracking/server-logger"

try {
  // work
} catch (error) {
  logServerError("api/issues", "query_failed", error)
}
```

## Verification checklist

- Trigger a browser error and confirm `CLIENT-SIDE ERROR CAPTURED` in Vercel logs
- Trigger an API catch block and confirm structured JSON/console output
- Confirm app behavior is unchanged when logging endpoint is unavailable
