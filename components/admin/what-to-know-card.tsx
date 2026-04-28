"use client"

import type { ReactNode } from "react"
import { ChevronDown, Info } from "lucide-react"

import { Card, CardContent } from "@/components/ui/card"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"

interface WhatToKnowCardProps {
  title: string
  summary: string
  defaultOpen?: boolean
  purpose: ReactNode
  pipelineFit: ReactNode
  whenToRun: ReactNode
  impact: ReactNode
  howToRun: ReactNode
}

export function WhatToKnowCard({
  title,
  summary,
  defaultOpen = false,
  purpose,
  pipelineFit,
  whenToRun,
  impact,
  howToRun,
}: WhatToKnowCardProps) {
  return (
    <Card className="border-muted-foreground/20 bg-muted/30">
      <Collapsible defaultOpen={defaultOpen}>
        <CollapsibleTrigger className="group flex w-full items-start justify-between gap-3 px-6 py-4 text-left">
          <div className="flex items-start gap-2">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="space-y-0.5">
              <div className="text-sm font-semibold">
                What to know — {title}
              </div>
              <div className="text-xs text-muted-foreground">{summary}</div>
            </div>
          </div>
          <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="space-y-4 border-t bg-background/40 pt-4 text-sm">
            <Section heading="Purpose">{purpose}</Section>
            <Section heading="Where it fits in the pipeline">
              {pipelineFit}
            </Section>
            <Section heading="When to run">{whenToRun}</Section>
            <Section heading="Impact of running">{impact}</Section>
            <Section heading="How to run">{howToRun}</Section>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  )
}

function Section({
  heading,
  children,
}: {
  heading: string
  children: ReactNode
}) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {heading}
      </div>
      <div className="mt-1 leading-relaxed">{children}</div>
    </div>
  )
}
