"use client"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  FINGERPRINT_VS_LLM_BULLETS,
  INTERPRETATION_BULLETS,
  URGENCY_FORMULA_MARKDOWN,
} from "@/lib/dashboard/methodology-copy"

function BulletList({ items }: { items: readonly string[] }) {
  return (
    <ul className="list-disc pl-4 text-sm text-foreground/90 space-y-2 text-left">
      {items.map((t) => (
        <li key={t}>{t}</li>
      ))}
    </ul>
  )
}

export function InterpretationContractDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>How to read this dashboard</DialogTitle>
          <DialogDescription>
            The same contract as in internal scoring docs: prioritize with context, not
            volume alone.
          </DialogDescription>
        </DialogHeader>
        <BulletList items={INTERPRETATION_BULLETS} />
      </DialogContent>
    </Dialog>
  )
}

export function UrgencyModelDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>How &quot;urgency&quot; is ranked</DialogTitle>
          <DialogDescription>72-hour window; per-category score.</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-foreground/90 whitespace-pre-line">{URGENCY_FORMULA_MARKDOWN}</p>
      </DialogContent>
    </Dialog>
  )
}

export function FingerprintModelDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Why fingerprints?</DialogTitle>
          <DialogDescription>
            Regex-based signals vs. the LLM layer (both stay traceable to source links).
          </DialogDescription>
        </DialogHeader>
        <BulletList items={FINGERPRINT_VS_LLM_BULLETS} />
      </DialogContent>
    </Dialog>
  )
}

type TriggerButtonProps = {
  label: string
  onClick: () => void
  className?: string
  variant?: "link" | "ghost" | "outline"
}

export function MethodologyTriggerButton({
  label,
  onClick,
  className,
  variant = "link",
}: TriggerButtonProps) {
  return (
    <Button
      type="button"
      variant={variant}
      className={className}
      onClick={onClick}
    >
      {label}
    </Button>
  )
}
