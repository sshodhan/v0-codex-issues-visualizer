"use client"

export interface ClientErrorPayload {
  errorType: string
  message: string
  stack?: string
  url?: string
  userAgent?: string
  timestamp: string
  /** "error" = something broke; "info" = structured event (lifecycle
   *  success/start). The server routes these to different log streams. */
  level?: "error" | "info"
  additionalInfo?: Record<string, unknown>
}

function canUseWindow() {
  return typeof window !== "undefined"
}

function postClientError(payload: ClientErrorPayload) {
  if (!canUseWindow()) return

  fetch("/api/log-client-error", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => {
    // Must never crash app flow.
  })
}

export function logClientError(
  error: unknown,
  errorType = "Client Error",
  additionalInfo?: Record<string, unknown>,
) {
  try {
    const err = error instanceof Error ? error : new Error(String(error))

    postClientError({
      errorType,
      message: err.message,
      stack: err.stack,
      url: canUseWindow() ? window.location.href : undefined,
      userAgent: canUseWindow() ? window.navigator.userAgent : undefined,
      timestamp: new Date().toISOString(),
      level: "error",
      additionalInfo,
    })
  } catch {
    // Intentionally silent.
  }
}

/**
 * Structured event log for client-side operations that we want visible
 * in Vercel logs — e.g. each classify-backfill batch that starts,
 * succeeds, or fails. Distinct from `logClientError` in that it doesn't
 * imply something broke; it's a breadcrumb for operators reconstructing
 * what an admin did and what happened.
 *
 * Flows through the same `/api/log-client-error` endpoint but with
 * `level: "info"` so the server can route it to a non-alert stream.
 */
export function logClientEvent(
  eventName: string,
  context?: Record<string, unknown>,
) {
  try {
    postClientError({
      errorType: eventName,
      message: eventName,
      url: canUseWindow() ? window.location.href : undefined,
      userAgent: canUseWindow() ? window.navigator.userAgent : undefined,
      timestamp: new Date().toISOString(),
      level: "info",
      additionalInfo: context,
    })
  } catch {
    // Intentionally silent.
  }
}

export function logReactError(error: Error, errorInfo: { componentStack?: string }) {
  logClientError(error, "React Error", {
    componentStack: errorInfo.componentStack,
  })
}

export function logLocalStorageError(error: unknown, operation: string) {
  logClientError(error, "localStorage Error", {
    operation,
    hasWindow: canUseWindow(),
    hasLocalStorage: canUseWindow() && "localStorage" in window,
  })
}

export function logAndroidWebViewError(error: unknown, context: Record<string, unknown> = {}) {
  const userAgent = canUseWindow() ? window.navigator.userAgent : ""
  const isAndroid = /Android/i.test(userAgent)
  const isWebView = /; wv\)|WebView/i.test(userAgent)

  logClientError(error, "Android WebView Error", {
    isAndroid,
    isWebView,
    ...context,
  })
}
