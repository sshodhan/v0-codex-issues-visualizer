"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Sparkles, Cpu, Terminal, FileCode2, RefreshCcw } from "lucide-react"

// Layered "how did we reach this signal" panel. Shows three stacked
// layers for a single observation so users can see how each pass
// contributes:
//
//   1. Raw context — title + (truncated) body of the report.
//   2. Regex pass — the deterministic fingerprint (error_code, top
//      stack frame, env tokens, repro markers, keyword_presence).
//   3. LLM pass — the classifier's structured output, either surfaced
//      from a previously-persisted fingerprint row or fetched on demand
//      via POST /api/observations/:id/classify.
//
// The stacking is deliberate: the same regex signals that power the
// compound cluster key are the baseline, and the LLM layer is drawn on
// top so a user can see "we already knew X from regex; the LLM added Y".

export interface SignalLayersFingerprint {
  error_code: string | null
  top_stack_frame: string | null
  top_stack_frame_hash: string | null
  cli_version: string | null
  os: string | null
  shell: string | null
  editor: string | null
  model_id: string | null
  repro_markers: number
  keyword_presence: number
  llm_subcategory: string | null
  llm_primary_tag: string | null
  algorithm_version?: string | null
}

export interface SignalLayersProps {
  observationId: string
  title: string
  content?: string | null
  fingerprint: SignalLayersFingerprint | null
  /**
   * When false (default), the component renders inline. Set to true to
   * wrap in a Card — useful when dropped directly under an expandable
   * issues-table row.
   */
  framed?: boolean
}

interface LlmResponse {
  subcategory: string
  category: string
  severity: string
  reproducibility: string
  impact: string
  confidence: number
  summary: string
  root_cause_hypothesis: string
  suggested_fix: string
  tags: string[]
  evidence_quotes: string[]
  model_used: string
  retried_with_large_model: boolean
  classification_id?: string | null
  classified_at?: string | null
}

export function SignalLayers(props: SignalLayersProps) {
  const { observationId, title, content, fingerprint, framed = false } = props
  const [llm, setLlm] = useState<LlmResponse | null>(null)
  const [compoundKey, setCompoundKey] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [fetching, setFetching] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Look up the most recent LLM classification for this observation on
  // mount. The scraper's post-batch pipeline already runs the classifier
  // for every new observation, so this GET is typically a warm read — no
  // OpenAI cost, no waiting. The CTA below re-runs only on user action.
  useEffect(() => {
    let cancelled = false
    setFetching(true)
    fetch(`/api/observations/${observationId}/classify`)
      .then(async (res) => {
        if (!res.ok) return
        const body = await res.json()
        if (cancelled) return
        if (body.llm) setLlm(body.llm)
        if (body.compound_key) setCompoundKey(body.compound_key)
      })
      .catch(() => {
        // Non-fatal: the UI still works without an existing classification.
      })
      .finally(() => {
        if (!cancelled) setFetching(false)
      })
    return () => {
      cancelled = true
    }
  }, [observationId])

  const regex = fingerprint
  const hasRegexSignal =
    regex !== null &&
    (regex.error_code ||
      regex.top_stack_frame ||
      regex.cli_version ||
      regex.os ||
      regex.shell ||
      regex.editor ||
      regex.model_id ||
      regex.repro_markers > 0 ||
      regex.keyword_presence > 0)

  const existingLlmSubcategory = regex?.llm_subcategory ?? null
  const existingLlmTag = regex?.llm_primary_tag ?? null

  async function runClassifier() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/observations/${observationId}/classify`, { method: "POST" })
      const body = await res.json()
      if (!res.ok) {
        setError(body.message ?? body.error ?? "Classifier request failed")
        return
      }
      setLlm(body.llm)
      if (body.compound_key) setCompoundKey(body.compound_key)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error")
    } finally {
      setLoading(false)
    }
  }

  const body = (
    <div className="space-y-4">
      {/* Layer 1 — raw context */}
      <section>
        <h4 className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <FileCode2 className="size-3.5" />
          Report
        </h4>
        <p className="text-sm font-medium leading-snug">{title}</p>
        {content ? (
          <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{content}</p>
        ) : null}
      </section>

      {/* Layer 2 — regex fingerprint */}
      <section>
        <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Terminal className="size-3.5" />
          Regex signals
          {regex?.algorithm_version ? (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
              {regex.algorithm_version}
            </span>
          ) : null}
        </h4>
        {hasRegexSignal ? (
          <div className="flex flex-wrap gap-1.5">
            {regex?.error_code ? (
              <Badge variant="destructive" className="font-mono">{regex.error_code}</Badge>
            ) : null}
            {regex?.top_stack_frame ? (
              <Badge variant="outline" className="font-mono text-[11px]">
                {regex.top_stack_frame}
              </Badge>
            ) : null}
            {regex?.cli_version ? (
              <Badge variant="secondary">CLI v{regex.cli_version}</Badge>
            ) : null}
            {regex?.os ? <Badge variant="secondary">{regex.os}</Badge> : null}
            {regex?.shell ? <Badge variant="secondary">{regex.shell}</Badge> : null}
            {regex?.editor ? <Badge variant="secondary">{regex.editor}</Badge> : null}
            {regex?.model_id ? (
              <Badge variant="secondary" className="font-mono text-[11px]">
                {regex.model_id}
              </Badge>
            ) : null}
            {regex && regex.repro_markers > 0 ? (
              <Badge variant="outline">{regex.repro_markers} repro marker{regex.repro_markers === 1 ? "" : "s"}</Badge>
            ) : null}
            {regex && regex.keyword_presence > 0 ? (
              <Badge variant="outline">{regex.keyword_presence} bug keyword{regex.keyword_presence === 1 ? "" : "s"}</Badge>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            No deterministic signal extracted. Run the LLM pass to recover a subcategory.
          </p>
        )}
      </section>

      {/* Layer 3 — LLM classification, stacked on top of the regex layer */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Sparkles className="size-3.5" />
            LLM insights
          </h4>
          <Button
            size="sm"
            variant="outline"
            onClick={runClassifier}
            disabled={loading}
            title={
              llm
                ? "Rerun gpt-5-mini on this report; escalates to gpt-5 when confidence < 0.7"
                : "Call gpt-5-mini to add subcategory, severity, root-cause hypothesis, and evidence quotes on top of the regex layer (~2s)"
            }
            className="h-7 gap-1 text-xs"
          >
            {loading ? <RefreshCcw className="size-3 animate-spin" /> : <Cpu className="size-3" />}
            {llm
              ? "Re-run LLM pass"
              : existingLlmSubcategory
                ? "Refresh LLM pass"
                : "Add LLM pass"}
          </Button>
        </div>

        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        {llm ? (
          <LlmDetail llm={llm} />
        ) : fetching ? (
          <p className="text-xs text-muted-foreground">Looking up existing classification…</p>
        ) : existingLlmSubcategory || existingLlmTag ? (
          <div className="flex flex-wrap gap-1.5">
            {existingLlmSubcategory ? (
              <Badge variant="default">subcategory · {existingLlmSubcategory}</Badge>
            ) : null}
            {existingLlmTag ? (
              <Badge variant="secondary">tag · {existingLlmTag}</Badge>
            ) : null}
            <span className="text-[11px] text-muted-foreground">
              Persisted on the fingerprint row. Re-run to fetch the full structured output.
            </span>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            No LLM classification on this observation yet. Add one to surface subcategory, severity,
            root-cause hypothesis, and evidence quotes on top of the regex layer (~2 s via gpt-5-mini).
          </p>
        )}
      </section>

      {/*
        Cluster-key label surfaced so the analyst can trace the
        aggregation — "this row lives in bucket title:abc|err:ENOENT".
        The label is regex-only by contract (see
        lib/scrapers/bug-fingerprint.ts): LLM output is informative but
        never splits the cluster bucket.
      */}
      {compoundKey ? (
        <p className="text-[10px] font-mono text-muted-foreground/70 leading-tight">
          Cluster key: {compoundKey}
        </p>
      ) : null}
    </div>
  )

  if (!framed) return body
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Signal layers</CardTitle>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  )
}

function LlmDetail({ llm }: { llm: LlmResponse }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="default">subcategory · {llm.subcategory}</Badge>
        <Badge variant="outline">category · {llm.category}</Badge>
        <Badge variant="outline">severity · {llm.severity}</Badge>
        <Badge variant="outline">repro · {llm.reproducibility}</Badge>
        <Badge variant="outline">impact · {llm.impact}</Badge>
        <Badge variant="secondary" className="font-mono text-[11px]">
          {llm.model_used}
          {llm.retried_with_large_model ? " ↑" : ""}
        </Badge>
        <span className="text-[11px] text-muted-foreground">
          confidence {(llm.confidence * 100).toFixed(0)}%
        </span>
      </div>
      {llm.summary ? (
        <p className="text-xs leading-snug">
          <span className="font-semibold">Summary · </span>
          {llm.summary}
        </p>
      ) : null}
      {llm.root_cause_hypothesis ? (
        <p className="text-xs leading-snug">
          <span className="font-semibold">Hypothesis · </span>
          {llm.root_cause_hypothesis}
        </p>
      ) : null}
      {llm.suggested_fix ? (
        <p className="text-xs leading-snug">
          <span className="font-semibold">Suggested fix · </span>
          {llm.suggested_fix}
        </p>
      ) : null}
      {llm.tags?.length ? (
        <div className="flex flex-wrap gap-1">
          {llm.tags.map((t) => (
            <Badge key={t} variant="secondary" className="text-[10px]">
              #{t}
            </Badge>
          ))}
        </div>
      ) : null}
      {llm.evidence_quotes?.length ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-[11px] text-muted-foreground">
            Evidence ({llm.evidence_quotes.length})
          </summary>
          <ul className="mt-1 space-y-1 pl-3 text-[11px] text-muted-foreground">
            {llm.evidence_quotes.map((quote, i) => (
              <li key={i} className="border-l-2 border-muted pl-2 italic">
                “{quote}”
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  )
}
