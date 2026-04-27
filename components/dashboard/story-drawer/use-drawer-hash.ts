"use client"

import { useEffect, useRef } from "react"
import type { StoryDrawerTarget } from "./types"

const HASH_PREFIX = "#story-drawer="

/**
 * Encodes a drawer target as a URL hash and decodes it back. Used to deep-link a drawer
 * (so reload restores it) and to keep the back button as a "close" affordance.
 */
function encode(t: StoryDrawerTarget): string {
  if (!t) return ""
  if (t.kind === "heuristic") return `heuristic:${t.slug}|${encodeURIComponent(t.label)}|${t.color ?? ""}`
  if (t.kind === "llm") return `llm:${t.slug}|${encodeURIComponent(t.label)}|${t.color ?? ""}`
  if (t.kind === "cluster") return `cluster:${t.clusterId}`
  if (t.kind === "issue") return `issue:${t.issueId}`
  return ""
}

function decode(raw: string): StoryDrawerTarget {
  if (!raw) return null
  const [kind, rest] = raw.split(":", 2)
  if (!kind || !rest) return null
  if (kind === "heuristic" || kind === "llm") {
    const [slug, encLabel = "", color = ""] = rest.split("|")
    if (!slug) return null
    return {
      kind,
      slug,
      label: decodeURIComponent(encLabel || slug),
      color: color || undefined,
    }
  }
  if (kind === "cluster") {
    return { kind: "cluster", clusterId: rest }
  }
  if (kind === "issue") {
    return { kind: "issue", issueId: rest }
  }
  return null
}

/**
 * Two-way bind between drawer target and URL hash.
 * - Initial mount: read hash, call `onRestore` if a target is encoded.
 * - On `target` change: write the hash (replacing, not pushing, so back closes the drawer).
 * - On hashchange (back button or external nav): notify the owner via `onRestore`.
 */
export function useDrawerHash(
  target: StoryDrawerTarget,
  onRestore: (t: StoryDrawerTarget) => void,
) {
  // Stash the latest callback to avoid resubscribing the hashchange listener every render.
  const restoreRef = useRef(onRestore)
  useEffect(() => {
    restoreRef.current = onRestore
  }, [onRestore])

  // On mount, read the hash and restore.
  useEffect(() => {
    if (typeof window === "undefined") return
    const hash = window.location.hash
    if (!hash.startsWith(HASH_PREFIX)) return
    const decoded = decode(hash.slice(HASH_PREFIX.length))
    if (decoded) restoreRef.current(decoded)
    // Run only once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Mirror target → hash. Use replaceState to keep history single-step.
  useEffect(() => {
    if (typeof window === "undefined") return
    const encoded = encode(target)
    const desired = encoded ? `${HASH_PREFIX}${encoded}` : ""
    const current = window.location.hash
    const cleanCurrent = current.startsWith(HASH_PREFIX) ? current : ""
    if (desired === cleanCurrent) return
    const url = new URL(window.location.href)
    url.hash = desired
    window.history.replaceState(window.history.state, "", url.toString())
  }, [target])

  // Listen for back/forward (hashchange) — close or restore as the URL says.
  useEffect(() => {
    if (typeof window === "undefined") return
    const handler = () => {
      const hash = window.location.hash
      if (!hash.startsWith(HASH_PREFIX)) {
        restoreRef.current(null)
        return
      }
      const decoded = decode(hash.slice(HASH_PREFIX.length))
      restoreRef.current(decoded)
    }
    window.addEventListener("hashchange", handler)
    return () => window.removeEventListener("hashchange", handler)
  }, [])
}
