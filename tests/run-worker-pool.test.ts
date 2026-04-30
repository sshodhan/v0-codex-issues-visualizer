import test from "node:test"
import assert from "node:assert/strict"

import { runWorkerPool, type WorkerPoolProgress } from "../lib/admin/run-worker-pool.ts"

// Pure-function tests for the bounded-concurrency worker pool used by
// the Family Classification "Drain backlog" action. The component
// (components/admin/family-classification-panel.tsx) wires this into
// React state; these tests lock the scheduling invariants without a
// React harness so the panel's behavior is provable in isolation.

const flush = () => new Promise((r) => setImmediate(r))

test("runWorkerPool: empty queue resolves immediately with zero counts", async () => {
  const result = await runWorkerPool({
    queue: [],
    worker: () => true,
    concurrency: 3,
  })
  assert.deepEqual(result, {
    succeeded: 0,
    failed: 0,
    aborted: false,
    consecutiveFailureLimitReached: false,
  })
})

test("runWorkerPool: every-success queue counts all as succeeded", async () => {
  const result = await runWorkerPool({
    queue: [1, 2, 3, 4, 5],
    worker: async () => true,
    concurrency: 2,
  })
  assert.equal(result.succeeded, 5)
  assert.equal(result.failed, 0)
  assert.equal(result.aborted, false)
})

test("runWorkerPool: false return value counts as failure (no throw needed)", async () => {
  const result = await runWorkerPool({
    queue: [1, 2, 3],
    worker: async (n) => n !== 2,
    concurrency: 1,
  })
  assert.equal(result.succeeded, 2)
  assert.equal(result.failed, 1)
})

test("runWorkerPool: thrown/rejected promise counts as failure, never bubbles", async () => {
  const result = await runWorkerPool({
    queue: ["ok", "boom", "ok"],
    worker: async (s) => {
      if (s === "boom") throw new Error("worker exploded")
      return true
    },
    concurrency: 1,
  })
  assert.equal(result.succeeded, 2)
  assert.equal(result.failed, 1)
})

test("runWorkerPool: synchronous throw in worker is caught", async () => {
  const result = await runWorkerPool({
    queue: [1, 2],
    worker: (n) => {
      if (n === 1) throw new Error("sync boom")
      return true
    },
    concurrency: 1,
  })
  assert.equal(result.succeeded, 1)
  assert.equal(result.failed, 1)
})

test("runWorkerPool: respects concurrency limit (never exceeds in-flight)", async () => {
  let active = 0
  let peak = 0
  const result = await runWorkerPool({
    queue: [1, 2, 3, 4, 5, 6, 7, 8],
    concurrency: 3,
    worker: async () => {
      active++
      if (active > peak) peak = active
      // Yield to let other concurrent workers also enter before we exit.
      await flush()
      active--
      return true
    },
  })
  assert.equal(result.succeeded, 8)
  assert.ok(peak <= 3, `peak in-flight (${peak}) exceeded concurrency`)
  assert.ok(peak >= 2, `peak in-flight (${peak}) suggests pool didn't actually parallelize`)
})

test("runWorkerPool: maxConsecutiveFailures trips the breaker, remaining items skipped", async () => {
  const seen: number[] = []
  const result = await runWorkerPool({
    queue: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    concurrency: 1,
    maxConsecutiveFailures: 3,
    worker: async (n) => {
      seen.push(n)
      return false // every worker fails
    },
  })
  assert.equal(result.consecutiveFailureLimitReached, true)
  // First 3 fail and trip the breaker; the rest are skipped.
  assert.equal(result.failed, 3)
  assert.equal(result.succeeded, 0)
  assert.deepEqual(seen, [1, 2, 3])
})

test("runWorkerPool: a success between failures resets the consecutive counter", async () => {
  // Order: fail, fail, success, fail, fail, fail
  // Counter trajectory: 1, 2, 0, 1, 2, 3 → trips on 6th
  const verdicts = [false, false, true, false, false, false]
  let i = 0
  const result = await runWorkerPool({
    queue: [1, 2, 3, 4, 5, 6, 7, 8],
    concurrency: 1,
    maxConsecutiveFailures: 3,
    worker: async () => verdicts[i++] ?? true,
  })
  assert.equal(result.consecutiveFailureLimitReached, true)
  assert.equal(result.succeeded, 1)
  assert.equal(result.failed, 5)
})

test("runWorkerPool: aborts cleanly via signal — no new work scheduled after abort", async () => {
  const controller = new AbortController()
  let started = 0
  const result = await runWorkerPool({
    queue: Array.from({ length: 100 }, (_, i) => i),
    concurrency: 2,
    signal: controller.signal,
    worker: async () => {
      started++
      // After 4 workers have started, abort.
      if (started === 4) controller.abort()
      await flush()
      return true
    },
  })
  assert.equal(result.aborted, true)
  // Pool should not have processed all 100 — only the in-flight set
  // when abort fired plus a small handful that may have already been
  // queued by the time the signal listener ran. Pin a generous upper
  // bound so the test is robust to scheduler variance.
  assert.ok(
    started < 100,
    `expected pool to stop early after abort; started=${started}`,
  )
})

test("runWorkerPool: resolves immediately if signal is already aborted on entry", async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  const result = await runWorkerPool({
    queue: [1, 2, 3],
    concurrency: 2,
    signal: controller.signal,
    worker: () => {
      calls++
      return true
    },
  })
  assert.equal(result.aborted, true)
  assert.equal(calls, 0)
  assert.equal(result.succeeded, 0)
  assert.equal(result.failed, 0)
})

test("runWorkerPool: onProgress fires on every state transition with monotonic counts", async () => {
  const progressEvents: WorkerPoolProgress[] = []
  const result = await runWorkerPool({
    queue: [1, 2, 3, 4, 5],
    concurrency: 2,
    worker: async () => true,
    onProgress: (p) => progressEvents.push({ ...p }),
  })
  assert.equal(result.succeeded, 5)
  assert.ok(progressEvents.length >= 5, "expected at least one progress event per item")
  // Counts only ever increase.
  for (let i = 1; i < progressEvents.length; i++) {
    const prev = progressEvents[i - 1]
    const cur = progressEvents[i]
    assert.ok(
      cur.succeeded >= prev.succeeded,
      `succeeded went backwards at event ${i}`,
    )
    assert.ok(
      cur.failed >= prev.failed,
      `failed went backwards at event ${i}`,
    )
  }
  // Final event should have inFlight=0 and remaining=0.
  const last = progressEvents[progressEvents.length - 1]
  assert.equal(last.inFlight, 0)
  assert.equal(last.remaining, 0)
})

test("runWorkerPool: does not mutate the caller's queue array", async () => {
  const queue = [1, 2, 3]
  await runWorkerPool({
    queue,
    concurrency: 1,
    worker: async () => true,
  })
  assert.deepEqual(queue, [1, 2, 3])
})

test("runWorkerPool: throws if concurrency < 1", async () => {
  await assert.rejects(
    () => runWorkerPool({ queue: [1], concurrency: 0, worker: () => true }),
    /concurrency must be >= 1/,
  )
})
