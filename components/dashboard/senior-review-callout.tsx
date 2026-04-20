"use client"

import { useState } from "react"
import { ClipboardCheck, ShieldAlert } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

const REVIEW_CHECKLIST = [
  "Verify global sliders update issues and triage scope consistently.",
  "Validate cluster chips route reviewers into dense/high-risk lanes quickly.",
  "Confirm source links from triage rows open original feedback reliably.",
  "Check reviewer overrides persist and refresh correctly in the queue.",
  "Exercise scrape → classify → triage flow for an end-to-end sanity pass.",
]

export function SeniorReviewCallout() {
  const [copied, setCopied] = useState(false)

  const copyChecklist = async () => {
    const text = `Senior E2E review checklist:\n${REVIEW_CHECKLIST.map((item, index) => `${index + 1}. ${item}`).join("\n")}`
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <Card className="border-amber-500/40 bg-amber-500/5">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert className="h-4 w-4 text-amber-500" />
          Senior engineer end-to-end review requested
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {REVIEW_CHECKLIST.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <Button size="sm" variant="outline" onClick={copyChecklist} className="gap-2">
          <ClipboardCheck className="h-4 w-4" />
          {copied ? "Checklist copied" : "Copy review checklist"}
        </Button>
      </CardContent>
    </Card>
  )
}
