import type { ReactNode } from "react"

/**
 * One section of drawer content. Title is uppercase eyebrow text; the body sits below
 * with a thin top border for editorial rhythm. Empty `children` renders nothing.
 */
export function DrawerSection({
  title,
  children,
  caption,
}: {
  title: string
  children: ReactNode
  caption?: string
}) {
  return (
    <section className="border-t border-border/50 pt-4 first:border-t-0 first:pt-0">
      <header className="mb-2 flex items-baseline justify-between gap-2">
        <h4 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          {title}
        </h4>
        {caption && (
          <span className="text-[10px] text-muted-foreground tabular-nums">{caption}</span>
        )}
      </header>
      {children}
    </section>
  )
}
