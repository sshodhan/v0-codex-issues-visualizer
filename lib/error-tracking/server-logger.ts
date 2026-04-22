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
  const err = error instanceof Error ? error : new Error(String(error))

  logServer({
    component,
    event,
    level: "error",
    data: {
      errorName: err.name,
      message: err.message,
      stack: err.stack,
      ...additionalData,
    },
  })
}
