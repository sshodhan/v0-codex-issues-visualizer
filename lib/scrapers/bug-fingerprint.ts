import { createHash } from "node:crypto"
import { buildTitleClusterKey, normalizeTitleForCluster } from "../storage/cluster-key.ts"
import { calculateKeywordPresence } from "./shared.ts"

// Bug-fingerprint extractor (algorithm v3). Pulls concrete differentiators
// out of title + body so that identical-title reports with different root
// causes split into distinct clusters instead of over-aggregating on title
// alone. See docs/BUGS.md P0-5 / P1-12 lineage and the plan at
// ~/.claude/plans/how-can-i-improve-swift-metcalfe.md.
//
// Every field is optional: regex extraction fails softly to null. The
// compound cluster-key builder degrades to a title-only key when no
// differentiator is found, preserving today's clustering behavior for
// reports that genuinely share a root cause.

export type BugFingerprintOs = "macos" | "linux" | "windows" | "wsl" | null
export type BugFingerprintShell = "zsh" | "bash" | "fish" | "powershell" | "cmd" | null
export type BugFingerprintEditor =
  | "vscode"
  | "cursor"
  | "jetbrains"
  | "neovim"
  | "vim"
  | "emacs"
  | "sublime"
  | null

export interface BugFingerprint {
  error_code: string | null
  top_stack_frame: string | null
  top_stack_frame_hash: string | null
  cli_version: string | null
  os: BugFingerprintOs
  shell: BugFingerprintShell
  editor: BugFingerprintEditor
  model_id: string | null
  repro_markers: number
  keyword_presence: number
}

export const EMPTY_FINGERPRINT: BugFingerprint = {
  error_code: null,
  top_stack_frame: null,
  top_stack_frame_hash: null,
  cli_version: null,
  os: null,
  shell: null,
  editor: null,
  model_id: null,
  repro_markers: 0,
  keyword_presence: 0,
}

// ---------------------------------------------------------------------------
// Error-code extraction
// ---------------------------------------------------------------------------
// Priority order: named exceptions > POSIX errno > HTTP status > exit code.
// The first successful match wins. All codes are normalized to SHOUTY_SNAKE
// so the cluster key stays stable across casing variants ("enoent" and
// "ENOENT" cluster together).

// Python exception classes are only trusted when they appear in a
// traceback-shaped context (the word `Traceback` or a `File "..."` frame
// within 200 chars). Bare "ConnectionError" in prose would otherwise
// shadow the more-specific HTTP code in the same body — see the P0-style
// data-analyst finding on precedence.
const PY_EXCEPTION_RE = /\b([A-Z][A-Za-z0-9]{1,30}(?:Error|Exception|Warning))\b/
const PY_TRACEBACK_CONTEXT_RE = /Traceback\s*\(most recent call last\)|File\s+"[^"]+",\s+line\s+\d+/
const JS_ERROR_WITH_MSG_RE = /\b(TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError)\b/
const POSIX_ERRNO_RE = /\b(E[A-Z]{2,10})\b/
// HTTP status requires an explicit prefix (`http`, `HTTP/1.1`, `status`,
// `status_code`, `:status` header form). Bare three-digit numbers in
// prose (e.g. "waited 500ms", "got 503 responses") no longer leak.
const HTTP_STATUS_RE = /\b(?:http(?:\/\d(?:\.\d)?)?|:?status(?:[\s:_-]*code)?|response)[\s:_-]+([45]\d{2})\b/i
// Exit codes require either `exit code N`, `exited with N`, or
// `exit status N`. Prose like "exited 12 minutes ago" is rejected
// because the follow-up token must be a small integer in (0, 255].
const EXIT_CODE_RE = /\bexit(?:ed)?\s+(?:code|status|with(?:\s+code|\s+status)?)\s+(\d{1,3})\b/i
const CODE_STRING_RE = /\bcode\s*[:=]\s*['"]([A-Z][A-Z0-9_]{2,20})['"]/

// Known POSIX errnos — filters false positives like "EMAIL" that happen to
// match the /\bE[A-Z]{2,10}\b/ pattern.
const POSIX_ERRNO_WHITELIST = new Set([
  "EACCES", "EADDRINUSE", "EADDRNOTAVAIL", "EAGAIN", "EBADF", "EBUSY",
  "ECANCELED", "ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "EDEADLK",
  "EDQUOT", "EEXIST", "EFAULT", "EFBIG", "EHOSTDOWN", "EHOSTUNREACH",
  "EINTR", "EINVAL", "EIO", "EISCONN", "EISDIR", "ELOOP", "EMFILE",
  "EMLINK", "EMSGSIZE", "ENAMETOOLONG", "ENETDOWN", "ENETRESET",
  "ENETUNREACH", "ENFILE", "ENOBUFS", "ENODATA", "ENODEV", "ENOENT",
  "ENOEXEC", "ENOLCK", "ENOMEM", "ENOSPC", "ENOSYS", "ENOTCONN",
  "ENOTDIR", "ENOTEMPTY", "ENOTSOCK", "ENOTTY", "ENXIO", "EOPNOTSUPP",
  "EOVERFLOW", "EPERM", "EPIPE", "EPROTO", "EPROTONOSUPPORT", "ERANGE",
  "EROFS", "ESHUTDOWN", "ESPIPE", "ESRCH", "ETIME", "ETIMEDOUT", "ETXTBSY",
  "EWOULDBLOCK", "EXDEV",
])

function extractErrorCode(text: string): string | null {
  // POSIX errnos are high-specificity — check them first.
  const posixMatch = text.match(POSIX_ERRNO_RE)
  if (posixMatch && POSIX_ERRNO_WHITELIST.has(posixMatch[1])) return posixMatch[1]

  // Python exceptions only count when a traceback context is nearby.
  // Without this gate, "ConnectionError" in prose shadows the more
  // distinguishing HTTP status on the same report.
  const pyMatch = text.match(PY_EXCEPTION_RE)
  if (pyMatch) {
    const start = Math.max(0, (pyMatch.index ?? 0) - 200)
    const window = text.slice(start, (pyMatch.index ?? 0) + pyMatch[0].length + 40)
    if (PY_TRACEBACK_CONTEXT_RE.test(window)) return pyMatch[1]
  }

  const jsMatch = text.match(JS_ERROR_WITH_MSG_RE)
  if (jsMatch) return jsMatch[1]

  const codeStringMatch = text.match(CODE_STRING_RE)
  if (codeStringMatch) return codeStringMatch[1]

  const httpMatch = text.match(HTTP_STATUS_RE)
  if (httpMatch) return `HTTP_${httpMatch[1]}`

  const exitMatch = text.match(EXIT_CODE_RE)
  if (exitMatch) return `EXIT_${exitMatch[1]}`

  return null
}

// ---------------------------------------------------------------------------
// Stack-frame extraction
// ---------------------------------------------------------------------------
// Identify the first source-location-looking line. Normalize to the last two
// path segments + line number so volatile absolute paths
// (/Users/alice/..., /home/bob/...) don't fragment clusters for the same
// underlying frame.

const PY_FRAME_RE = /File\s+"([^"]+)",\s+line\s+(\d+)/
// JS frames come in two flavors:
//   at fnName (/abs/path/file.js:12:9)
//   at /abs/path/file.js:12:9
// Paths may include a `node:` scheme (e.g. `node:internal/process/task_queues`).
// We capture everything up to the final `:line:col` (or `:line`) suffix.
const JS_AT_FRAME_RE = /\bat\s+(?:[\w$.<>\[\] ]+\s+\()?([^\s()]+?):(\d+)(?::\d+)?\)?/
const PLAIN_FRAME_RE = /(?:^|\s)((?:[.\/\\]?[\w.\-]+[\/\\])+[\w.\-]+\.[A-Za-z]{1,5}):(\d+)\b/

function normalizePathForFrame(rawPath: string): string {
  // Keep only the last two path segments so /home/x/y/z/a/b/c.ts and
  // /users/q/r/s/a/b/c.ts collapse to `b/c.ts`.
  const segments = rawPath.replace(/\\/g, "/").split("/").filter(Boolean)
  if (segments.length <= 2) return segments.join("/") || rawPath
  return segments.slice(-2).join("/")
}

function extractTopStackFrame(text: string): string | null {
  const py = text.match(PY_FRAME_RE)
  if (py) return `${normalizePathForFrame(py[1])}:${py[2]}`

  const js = text.match(JS_AT_FRAME_RE)
  if (js && !/^https?$/i.test(js[1])) {
    return `${normalizePathForFrame(js[1])}:${js[2]}`
  }

  const plain = text.match(PLAIN_FRAME_RE)
  if (plain) return `${normalizePathForFrame(plain[1])}:${plain[2]}`

  return null
}

/**
 * Cluster-stable hash of a stack frame. We deliberately hash only the
 * path portion — dropping the `:line` suffix — so a one-line shift
 * between Codex releases doesn't fragment an otherwise-identical
 * signal. The line number is still retained in the human-readable
 * `top_stack_frame` string for UI display.
 */
function hashFrame(frame: string): string {
  const pathOnly = frame.replace(/:\d+$/, "")
  return createHash("md5").update(pathOnly).digest("hex").slice(0, 12)
}

// ---------------------------------------------------------------------------
// Environment extraction
// ---------------------------------------------------------------------------

const CLI_VERSION_RE = /\b(?:codex|cli|version)[^\n]{0,30}?v?(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/i
const BARE_SEMVER_RE = /\bv(\d+\.\d+\.\d+(?:[-+][\w.]+)?)\b/

function extractCliVersion(text: string): string | null {
  const scoped = text.match(CLI_VERSION_RE)
  if (scoped) return scoped[1]
  const bare = text.match(BARE_SEMVER_RE)
  if (bare) return bare[1]
  return null
}

function extractOs(text: string): BugFingerprintOs {
  const lower = text.toLowerCase()
  if (/\b(wsl|wsl2)\b/.test(lower)) return "wsl"
  if (/\b(macos|mac os|osx|os x|darwin|mac\s+(?:sonoma|ventura|monterey|sequoia))\b/.test(lower)) return "macos"
  if (/\b(windows|win10|win11|windows\s+1[01])\b/.test(lower)) return "windows"
  if (/\b(linux|ubuntu|debian|fedora|arch|centos|rhel|nixos|pop\!_os|alpine)\b/.test(lower)) return "linux"
  return null
}

function extractShell(text: string): BugFingerprintShell {
  const lower = text.toLowerCase()
  if (/\bpowershell\b|\bpwsh\b/.test(lower)) return "powershell"
  if (/\bzsh\b/.test(lower)) return "zsh"
  if (/\bbash\b/.test(lower)) return "bash"
  if (/\bfish\s+shell\b|\bfish\b(?=.{0,30}(?:shell|terminal|prompt))/.test(lower)) return "fish"
  if (/\bcmd\.exe\b|\bcommand\s+prompt\b/.test(lower)) return "cmd"
  return null
}

function extractEditor(text: string): BugFingerprintEditor {
  const lower = text.toLowerCase()
  if (/\bcursor\b(?=[^.]{0,30}(?:ide|editor|app))|cursor\.so|cursor\.sh/.test(lower)) return "cursor"
  if (/\bvscode\b|visual\s+studio\s+code|vs\s+code\b/.test(lower)) return "vscode"
  if (/\bjetbrains\b|webstorm|pycharm|intellij|goland|rubymine|phpstorm/.test(lower)) return "jetbrains"
  if (/\bneovim\b|\bnvim\b/.test(lower)) return "neovim"
  if (/\bvim\b/.test(lower)) return "vim"
  if (/\bemacs\b/.test(lower)) return "emacs"
  if (/\bsublime(?:\s+text)?\b/.test(lower)) return "sublime"
  return null
}

const MODEL_ID_RE = /\b(gpt-5(?:-mini|-nano)?|gpt-4(?:\.1|\.5|o)?(?:-mini|-turbo)?|o[134](?:-mini|-preview)?|claude-[a-z0-9.-]+?(?=\s|[.,]|$))\b/i

function extractModelId(text: string): string | null {
  const match = text.match(MODEL_ID_RE)
  if (!match) return null
  return match[1].toLowerCase()
}

// ---------------------------------------------------------------------------
// Repro-marker count
// ---------------------------------------------------------------------------

const REPRO_PATTERNS = [
  /\bsteps?\s+to\s+repr[oe]/gi,
  /\brepro(?:duction)?\s*[:—-]/gi,
  /\bto\s+reproduce\b/gi,
  /\breproducible\b/gi,
  /\bhow\s+to\s+reproduce\b/gi,
]

function countReproMarkers(text: string): number {
  return REPRO_PATTERNS.reduce((acc, re) => acc + (text.match(re) ?? []).length, 0)
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface ExtractFingerprintInput {
  title: string
  content: string | null
}

export function extractBugFingerprint(input: ExtractFingerprintInput): BugFingerprint {
  const combined = `${input.title}\n${input.content ?? ""}`
  const topFrame = extractTopStackFrame(combined)
  return {
    error_code: extractErrorCode(combined),
    top_stack_frame: topFrame,
    top_stack_frame_hash: topFrame ? hashFrame(topFrame) : null,
    cli_version: extractCliVersion(combined),
    os: extractOs(combined),
    shell: extractShell(combined),
    editor: extractEditor(combined),
    model_id: extractModelId(combined),
    repro_markers: countReproMarkers(combined),
    keyword_presence: calculateKeywordPresence(combined),
  }
}

/**
 * Compound cluster-key label. Pure function of title + regex fingerprint
 * (no LLM input — the classifier's output lives in `classifications` as
 * its own source of truth). Components drop out when absent so the label
 * degrades gracefully to today's title-only behavior for reports with no
 * extractable signal.
 *
 * Examples:
 *   - title + error + frame → "title:<h>|err:ENOENT|frame:<fh>"
 *   - title + error only    → "title:<h>|err:ENOENT"
 *   - no signal             → "title:<h>"                (= existing key)
 *   - empty title, no signal → "title:empty"             (= existing key)
 */
export function buildCompoundClusterKey(title: string, fp: BugFingerprint | null): string {
  const base = buildTitleClusterKey(title)
  if (!fp) return base

  const parts: string[] = []
  if (fp.error_code) parts.push(`err:${fp.error_code}`)
  if (fp.top_stack_frame_hash) parts.push(`frame:${fp.top_stack_frame_hash}`)

  if (parts.length === 0) return base
  return `${base}|${parts.join("|")}`
}

type CompoundKeyReader = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        maybeSingle: () => Promise<{ data: any; error: { message: string } | null }>
      }
    }
  }
}

/**
 * Single read-time source of truth for compound-key derivation.
 *
 * Reads the observation title from `mv_observation_current` and the latest
 * fingerprint from `bug_fingerprints`, then derives the label using the same
 * pure builder used at ingest.
 */
export async function computeCompoundKey(
  supabase: CompoundKeyReader,
  observationId: string,
): Promise<string | null> {
  const { data: row, error } = await supabase
    .from("mv_observation_current")
    .select(
      "title, error_code, top_stack_frame, top_stack_frame_hash, cli_version, fp_os, fp_shell, fp_editor, model_id, repro_markers, fp_keyword_presence",
    )
    .eq("observation_id", observationId)
    .maybeSingle()

  if (error || !row?.title) return null
  return buildCompoundClusterKey(row.title, {
    error_code: row.error_code ?? null,
    top_stack_frame: row.top_stack_frame ?? null,
    top_stack_frame_hash: row.top_stack_frame_hash ?? null,
    cli_version: row.cli_version ?? null,
    os: row.fp_os ?? null,
    shell: row.fp_shell ?? null,
    editor: row.fp_editor ?? null,
    model_id: row.model_id ?? null,
    repro_markers: row.repro_markers ?? 0,
    keyword_presence: row.fp_keyword_presence ?? 0,
  })
}

// Re-exported for callers that want the normalized title without the
// hashing step (e.g. the backfill script's diagnostic output).
export { normalizeTitleForCluster }
