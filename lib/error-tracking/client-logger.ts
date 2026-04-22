"use client"

export interface ClientErrorPayload {
  errorType: string
  message: string
  stack?: string
  url?: string
  userAgent?: string
  timestamp: string
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
      additionalInfo,
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
