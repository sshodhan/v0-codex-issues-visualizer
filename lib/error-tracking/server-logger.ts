export type ServerLogLevel = "debug" | "info" | "warn" | "error"

interface BaseServerEvent {
  level?: ServerLogLevel
  component: string
  event: string
  data?: Record<string, unknown>
}

interface MathCoachEvent {
  level?: ServerLogLevel
  event:
    | "grade_computed"
    | "openai_request"
    | "openai_response"
    | "mismatch_detected"
    | "policy_override"
  questionId?: string
  questionText?: string
  studentAnswer?: string
  attempt?: number
  serverGrade?: Record<string, unknown>
  openAIResponse?: Record<string, unknown>
  mismatch?: Record<string, unknown>
}

function emit(level: ServerLogLevel, payload: Record<string, unknown>) {
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log

  if (process.env.NODE_ENV === "production") {
    fn(JSON.stringify(payload))
    return
  }

  fn("═".repeat(54))
  fn(`[${String(payload.component).toUpperCase()}] ${String(payload.event).toUpperCase()}`)
  fn("═".repeat(54))
  fn(payload)
}

export function logServer(event: BaseServerEvent) {
  const payload = {
    component: event.component,
    event: event.event,
    level: event.level ?? "info",
    runtime: "nodejs",
    timestamp: new Date().toISOString(),
    ...event.data,
  }

  emit(payload.level as ServerLogLevel, payload)
}

export function logMathCoach(event: MathCoachEvent) {
  logServer({
    component: "math-coach",
    event: event.event,
    level: event.level ?? "info",
    data: {
      questionId: event.questionId,
      questionText: event.questionText,
      studentAnswer: event.studentAnswer,
      attempt: event.attempt,
      serverGrade: event.serverGrade,
      openAIResponse: event.openAIResponse,
      mismatch: event.mismatch,
    },
  })
}

export function logServerError(
  component: string,
  event: string,
  error: unknown,
  additionalData?: Record<string, unknown>,
) {
  const normalized = normalizeError(error)

  logServer({
    component,
    event,
    level: "error",
    data: {
      ...normalized,
      ...additionalData,
    },
  })
}

/**
 * Coerce an arbitrary error value into a log-safe payload.
 *
 * The previous implementation used `new Error(String(error))`, which
 * silently degraded Supabase's PostgrestError shape
 * ({ message, details, hint, code }) to the literal string
 * "[object Object]" — production traces were unreadable. This version
 * preserves those fields when present and falls back to
 * JSON-serialization for unknown object shapes so the operator always
 * has a breadcrumb to the actual failure.
 *
 * Exported for unit tests.
 */
export function normalizeError(error: unknown): {
  errorName: string
  message: string
  stack?: string
  code?: string
  details?: string
  hint?: string
} {
  if (error instanceof Error) {
    // Some libraries (Supabase, fetch) attach `code`/`details`/`hint`
    // to Error subclasses — forward those fields if they happen to be
    // primitive strings so the log carries their value.
    const extras: Record<string, string | undefined> = {}
    for (const key of ["code", "details", "hint"] as const) {
      const value = (error as unknown as Record<string, unknown>)[key]
      if (typeof value === "string" && value.length > 0) extras[key] = value
    }
    return {
      errorName: error.name,
      message: error.message || "(no message)",
      stack: error.stack,
      ...extras,
    }
  }
  if (typeof error === "object" && error !== null) {
    const obj = error as Record<string, unknown>
    const messageField = typeof obj.message === "string" ? obj.message : null
    let message = messageField
    if (!message) {
      try {
        message = JSON.stringify(obj).slice(0, 500)
      } catch {
        message = "(unserializable error object)"
      }
    }
    const extras: Record<string, string | undefined> = {}
    for (const key of ["code", "details", "hint"] as const) {
      const value = obj[key]
      if (typeof value === "string" && value.length > 0) extras[key] = value
    }
    return {
      errorName: typeof obj.name === "string" ? obj.name : "NonError",
      message,
      ...extras,
    }
  }
  return {
    errorName: "NonError",
    message: String(error),
  }
}
