import { cn } from "@/lib/utils"

/**
 * A small line of recent values (oldest first) with the normal range shaded and the latest value dotted, as Bevel puts
 * in every tile. Plain SVG stretched to its box; the dot is HTML so it stays round. Gaps (null) break the line.
 */
export function Sparkline({ values, band, color = "var(--foreground-secondary)", caption, className }: { values: (number | null)[]; band?: { low: number; high: number } | null; color?: string; caption?: string; className?: string }) {
  const xs = values.flatMap((v) => (v === null ? [] : [v]))
  if (xs.length < 2) return null
  const lo = Math.min(...xs, band?.low ?? Infinity)
  const hi = Math.max(...xs, band?.high ?? -Infinity)
  const pad = (hi - lo || 1) * 0.12
  const y = (v: number) => 100 - ((v - (lo - pad)) / (hi - lo + 2 * pad)) * 100
  const x = (i: number) => (values.length === 1 ? 50 : (i / (values.length - 1)) * 100)
  // One path, a new subpath after every gap.
  let d = ""
  values.forEach((v, i) => {
    if (v === null) return
    d += `${i === 0 || values[i - 1] === null ? "M" : "L"}${x(i).toFixed(2)},${y(v).toFixed(2)}`
  })
  const lastI = values.findLastIndex((v) => v !== null)
  return (
    <div aria-hidden className={cn("flex flex-col gap-1", className)}>
      <div className="relative min-h-0 flex-1">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="size-full overflow-visible">
          {band && (
            <>
              <rect x={0} y={y(band.high)} width={100} height={Math.max(0, y(band.low) - y(band.high))} fill="color-mix(in srgb, var(--foreground) 5%, transparent)" />
              {[band.high, band.low].map((v) => (
                <line key={v} x1={0} x2={100} y1={y(v)} y2={y(v)} stroke="var(--chart-grid)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
              ))}
            </>
          )}
          <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>
        <span
          className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card"
          style={{ left: `${x(lastI)}%`, top: `${y(values[lastI]!)}%`, background: color }}
        />
      </div>
      {caption && <span className="text-right text-[10px] leading-3 font-semibold tracking-[0.06em] text-muted-foreground uppercase">{caption}</span>}
    </div>
  )
}
