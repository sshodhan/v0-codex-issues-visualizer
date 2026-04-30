// Bounded-concurrency worker pool used by the Family Classification
// admin "Drain backlog" action. Extracted from the panel component so
// the scheduling logic can be unit-tested without a React harness.
//
// The pool processes a fixed `queue` with at most `concurrency` workers
// in flight at any moment. Each worker call returns a boolean — true =
// counted as success, anything else (including a thrown/rejected
// promise) = counted as failure. A circuit breaker stops scheduling
// new work after `maxConsecutiveFailures` consecutive failures *as
// observed in completion order across all in-flight workers*; with
// concurrency > 1, a slow success completing after a fast failure can
// reset the counter mid-flight. That's the desired behavior: any sign
// of life from the upstream resets the breaker.

export interface WorkerPoolProgress {
  /** Active workers right now (0..concurrency). */
  inFlight: number
  /** Items completed with `true`. */
  succeeded: number
  /** Items completed with `false` or a thrown/rejected promise. */
  failed: number
  /** Items still waiting in the queue (not yet picked up). */
  remaining: number
}

export interface WorkerPoolResult {
  succeeded: number
  failed: number
  /** True if `signal.aborted` flipped before the queue drained. */
  aborted: boolean
  /** True if the consecutive-failure circuit breaker tripped. */
  consecutiveFailureLimitReached: boolean
}

export interface WorkerPoolOptions<T> {
  queue: T[]
  /** Resolve true for success, false (or throw/reject) for failure. */
  worker: (item: T) => Promise<boolean> | boolean
  /** Maximum simultaneous workers. Must be >= 1. */
  concurrency: number
  /** Stop scheduling new work after this many consecutive failures.
   *  "Consecutive" means uninterrupted in completion order — a
   *  success between two failures resets the counter. Default
   *  Infinity (no breaker). */
  maxConsecutiveFailures?: number
  /** Optional cancellation. When `signal.aborted` becomes true, the
   *  pool stops scheduling new work and resolves once in-flight
   *  workers settle. */
  signal?: AbortSignal
  /** Called on every state transition (worker started or finished).
   *  Fires synchronously inside the pool's loop; keep it cheap. */
  onProgress?: (progress: WorkerPoolProgress) => void
}

export async function runWorkerPool<T>(
  options: WorkerPoolOptions<T>,
): Promise<WorkerPoolResult> {
  const {
    queue: initialQueue,
    worker,
    concurrency,
    maxConsecutiveFailures = Number.POSITIVE_INFINITY,
    signal,
    onProgress,
  } = options

  if (concurrency < 1) {
    throw new Error(`runWorkerPool: concurrency must be >= 1 (got ${concurrency})`)
  }

  // Copy so we never mutate the caller's array.
  const queue = [...initialQueue]

  let succeeded = 0
  let failed = 0
  let consecutiveFailures = 0
  let inFlight = 0
  let aborted = signal?.aborted === true
  let limitReached = false

  return new Promise<WorkerPoolResult>((resolve) => {
    let settled = false

    const settle = () => {
      if (settled) return
      settled = true
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener)
      }
      resolve({
        succeeded,
        failed,
        aborted,
        consecutiveFailureLimitReached: limitReached,
      })
    }

    const reportProgress = () => {
      if (!onProgress) return
      onProgress({ inFlight, succeeded, failed, remaining: queue.length })
    }

    const tryStart = () => {
      if (settled) return

      // No new work allowed if aborted or breaker tripped — but let
      // existing in-flight workers settle naturally before resolving.
      if (aborted || limitReached) {
        if (inFlight === 0) settle()
        return
      }

      if (queue.length === 0 && inFlight === 0) {
        settle()
        return
      }

      while (
        inFlight < concurrency &&
        queue.length > 0 &&
        !aborted &&
        !limitReached
      ) {
        const item = queue.shift() as T
        inFlight++
        reportProgress()

        // Wrapping in Promise.resolve() means a synchronous throw in
        // `worker` becomes a rejected promise that the .catch picks up.
        Promise.resolve()
          .then(() => worker(item))
          .then((ok) => {
            if (ok === true) {
              succeeded++
              consecutiveFailures = 0
            } else {
              failed++
              consecutiveFailures++
            }
          })
          .catch(() => {
            failed++
            consecutiveFailures++
          })
          .finally(() => {
            inFlight--
            if (consecutiveFailures >= maxConsecutiveFailures) {
              limitReached = true
            }
            reportProgress()
            tryStart()
          })
      }
    }

    const abortListener = signal
      ? () => {
          aborted = true
          if (inFlight === 0) settle()
        }
      : null

    if (signal && abortListener) {
      signal.addEventListener("abort", abortListener)
    }

    // Kick off the first batch (or settle immediately if nothing to do).
    tryStart()
  })
}
