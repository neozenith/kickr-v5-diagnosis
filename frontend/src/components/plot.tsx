// Plotly.js wrapper themed from the design profile's baked surface.plotly.
import { useEffect, useRef } from "react"
import Plotly from "plotly.js-dist-min"

import { type Mode, useResolvedMode } from "@/lib/mode"
import theme from "@/theme/plotly.json"


export function plotlyTheme(mode: Mode) {
  return theme[mode]
}

export function baseLayout(mode: Mode): Partial<Plotly.Layout> {
  const p = theme[mode]
  return {
    paper_bgcolor: p.paper_bgcolor,
    plot_bgcolor: p.plot_bgcolor,
    colorway: p.colorway,
    font: { family: theme.font.body, color: p.font_color, size: 12 },
    margin: { l: 44, r: 12, t: 8, b: 32 },
    xaxis: { gridcolor: p.gridcolor, zerolinecolor: p.gridcolor },
    yaxis: { gridcolor: p.gridcolor, zerolinecolor: p.gridcolor, rangemode: "tozero" },
    legend: { orientation: "h", y: -0.2 },
    showlegend: false,
    hovermode: "x unified",
  }
}

type Props = {
  data: Plotly.Data[]
  layout?: Partial<Plotly.Layout>
  className?: string
  testId?: string
}

export function Plot({ data, layout, className, testId }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const mode = useResolvedMode()

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const base = baseLayout(mode)
    Plotly.react(
      el,
      data,
      {
        ...base,
        ...layout,
        font: { ...base.font, ...layout?.font },
        xaxis: { ...base.xaxis, ...layout?.xaxis },
        yaxis: { ...base.yaxis, ...layout?.yaxis },
      },
      { displayModeBar: false, responsive: true }
    )
  }, [data, layout, mode])

  useEffect(() => {
    const el = ref.current
    return () => {
      if (el) Plotly.purge(el)
    }
  }, [])

  return <div ref={ref} className={className} data-testid={testId} />
}
export { useResolvedMode }
