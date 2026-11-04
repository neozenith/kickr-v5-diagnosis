import { useMemo, useState } from "react"
import { ActivityIcon, PauseIcon, PlayIcon, TriangleAlertIcon } from "lucide-react"
import type { Data, Layout } from "plotly.js-dist-min"

import { Plot, plotlyTheme, useResolvedMode } from "@/components/plot"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  type Metric,
  type Packet,
  type Source,
  SOURCE_LABEL,
  SOURCES,
  type StreamState,
  WINDOW_S,
  requestCalibration,
  useStream,
} from "@/lib/stream"

const SOURCE_VAR: Record<Source, string> = {
  cps: "var(--categorical-01)",
  ftms: "var(--categorical-02)",
  ant_fe: "var(--categorical-03)",
  pm_crank: "var(--categorical-04)",
}

const NO_STALLS: string[] = []
const NO_AGES: Record<string, number> = {}

const fmt = (v: unknown, digits = 0) =>
  typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "-"

function Swatch({ src }: { src: Source }) {
  return <span className="inline-block size-2.5 rounded-full" style={{ background: SOURCE_VAR[src] }} />
}

// ------------------------------------------------------------------ status

function StatusBar() {
  const status = useStream((s) => s.status)
  const sse = useStream((s) => s.sse)
  const stalled = status?.stalled ?? []
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="status-bar">
      <Badge variant={stalled.length ? "destructive" : "default"} data-testid="state">
        {status?.state ?? "connecting"}
      </Badge>
      {stalled.map((s) => (
        <Badge key={s} variant="destructive" data-testid="stalled">
          {s}
        </Badge>
      ))}
      <Badge variant="outline">uptime {fmt(status?.uptime_s)}s</Badge>
      <Badge variant="outline">connects {status?.connects ?? "-"}</Badge>
      <Badge variant="outline">disconnects {status?.disconnects ?? "-"}</Badge>
      <Badge variant="outline">stalls {status?.stalls ?? "-"}</Badge>
      <Badge variant="outline">rssi {status?.rssi ?? "-"}</Badge>
      <Badge variant="outline">ANT+ {status?.ant_state ?? "-"}</Badge>
      <Badge variant={sse === "live" ? "secondary" : "destructive"} data-testid="sse">
        SSE {sse}
      </Badge>
    </div>
  )
}

// ------------------------------------------------------------------ diagnosis

/** Live verdict: trainer channels against the crank reference. */
function Diagnosis() {
  const latest = useStream((s) => s.latest)
  const stalled = useStream((s) => s.status?.stalled ?? NO_STALLS)
  const ref = latest.power?.pm_crank
  const trainer = [latest.power?.cps, latest.power?.ftms, latest.power?.ant_fe].filter(
    (v): v is number => typeof v === "number"
  )
  const frozen = stalled.filter((s) => s.endsWith(".counter"))
  const mismatch = typeof ref === "number" && ref > 50 && trainer.length > 0 && Math.max(...trainer) < ref * 0.25
  if (!mismatch && !frozen.length) {
    return (
      <Alert data-testid="diagnosis" data-verdict="ok">
        <ActivityIcon />
        <AlertTitle>Trainer agrees with the reference</AlertTitle>
        <AlertDescription>No frozen counters, and trainer power tracks the crank meter.</AlertDescription>
      </Alert>
    )
  }
  return (
    <Alert variant="destructive" data-testid="diagnosis" data-verdict="fault">
      <TriangleAlertIcon />
      <AlertTitle>Trainer sensor fault</AlertTitle>
      <AlertDescription>
        {mismatch && (
          <p>
            Reference reads {fmt(ref)} W while the trainer reports {fmt(Math.max(...trainer))} W.
          </p>
        )}
        {frozen.length > 0 && <p>Frozen counters: {frozen.join(", ")}.</p>}
      </AlertDescription>
    </Alert>
  )
}

// ------------------------------------------------------------------ metrics

const METRICS: { metric: Metric; label: string; unit: string; digits: number; sources: Source[] }[] = [
  { metric: "power", label: "Power", unit: "W", digits: 0, sources: [...SOURCES] },
  { metric: "cadence", label: "Cadence", unit: "rpm", digits: 0, sources: [...SOURCES] },
  { metric: "speed", label: "Speed", unit: "km/h", digits: 1, sources: ["cps", "ftms", "ant_fe"] },
]

function MetricCards() {
  const latest = useStream((s) => s.latest)
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {METRICS.map(({ metric, label, unit, digits, sources }) => (
        <Card key={metric} size="sm" data-testid={`metric-${metric}`}>
          <CardHeader>
            <CardDescription>
              {label} ({unit})
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-x-4 gap-y-1">
            {sources.map((src) => (
              <div key={src} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 truncate text-muted-foreground">
                  <Swatch src={src} />
                  {SOURCE_LABEL[src]}
                </span>
                <span className="font-mono text-lg tabular-nums" data-testid={`value-${metric}-${src}`}>
                  {fmt(latest[metric]?.[src], digits)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ charts

const CHARTS: { metric: Metric; title: string; sources: Source[] }[] = [
  { metric: "power", title: "Power (W)", sources: [...SOURCES] },
  { metric: "cadence", title: "Cadence (rpm)", sources: [...SOURCES] },
  { metric: "speed", title: "Speed (km/h)", sources: ["cps", "ftms", "ant_fe"] },
  { metric: "gap", title: "Packet interval (ms)", sources: ["cps", "ftms", "ant_fe"] },
]

function Chart({ metric, title, sources }: (typeof CHARTS)[number]) {
  // Re-render at 4 Hz, not per packet.
  const tick = useStream((s) => Math.floor(s.latestT * 4))
  const series = useStream((s) => s.series)
  const latestT = useStream((s) => s.latestT)
  const colorway = plotlyTheme(useResolvedMode()).colorway
  const data = useMemo<Data[]>(
    () =>
      sources.map((src) => {
        const s = series[`${metric}.${src}`] ?? { t: [], v: [] }
        return {
          type: "scatter",
          mode: "lines",
          name: SOURCE_LABEL[src],
          x: [...s.t],
          y: [...s.v],
          line: { width: 2, color: colorway[SOURCES.indexOf(src)] },
          connectgaps: false,
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tick, metric, sources, colorway]
  )
  const layout = useMemo<Partial<Layout>>(
    () => ({
      xaxis: { range: [latestT - WINDOW_S, latestT], title: { text: "t (s)" } },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tick]
  )
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardAction className="flex gap-3">
          {sources.map((src) => (
            <span key={src} className="flex items-center gap-1 text-xs text-muted-foreground">
              <Swatch src={src} />
              {src}
            </span>
          ))}
        </CardAction>
      </CardHeader>
      <CardContent>
        <Plot
          data={data}
          layout={layout}
          className="h-56 w-full"
          testId={`chart-${metric}`}
        />
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------------ tables

function KV({ rows, testId }: { rows: [string, React.ReactNode][]; testId?: string }) {
  return (
    <Table data-testid={testId}>
      <TableBody>
        {rows.map(([k, v]) => (
          <TableRow key={k}>
            <TableHead className="text-muted-foreground">{k}</TableHead>
            <TableCell className="font-mono">{v}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function Flag({ v }: { v: unknown }) {
  if (v === undefined) return <>-</>
  return v ? <Badge variant="destructive">YES</Badge> : <Badge variant="secondary">no</Badge>
}

function Counters() {
  const counters = useStream((s) => s.counters)
  const ages = useStream((s) => s.status?.counter_age_s ?? NO_AGES)
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>CPS counters</CardTitle>
        <CardDescription>Cumulative revolutions and event time from the trainer</CardDescription>
      </CardHeader>
      <CardContent>
        <Table data-testid="counters">
          <TableHeader>
            <TableRow>
              <TableHead />
              <TableHead>revs</TableHead>
              <TableHead>event time</TableHead>
              <TableHead>unchanged for</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(["crank", "wheel"] as const).map((k) => {
              const age = ages[`cps.${k}`]
              return (
                <TableRow key={k}>
                  <TableCell>{k}</TableCell>
                  <TableCell className="font-mono">{counters[k]?.[0] ?? "-"}</TableCell>
                  <TableCell className="font-mono">{counters[k]?.[1] ?? "-"}</TableCell>
                  <TableCell>
                    <Badge variant={age > 3 ? "destructive" : "secondary"} data-testid={`counter-age-${k}`}>
                      {fmt(age, 1)}s
                    </Badge>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function AntStatus() {
  const tr = useStream((s) => s.antTrainer) ?? ({} as Packet)
  const g = useStream((s) => s.antGeneral) ?? ({} as Packet)
  const antState = useStream((s) => s.status?.ant_state ?? "-")
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>ANT+ trainer status</CardTitle>
        <CardDescription>FE-C pages 16 and 25</CardDescription>
      </CardHeader>
      <CardContent>
        <KV
          testId="ant-status"
          rows={[
            ["channel", antState],
            ["FE state", String(tr.fe_state ?? g.fe_state ?? "-")],
            ["FE type", String(g.fe_type ?? "-")],
            ["power calibration required", <Flag v={tr.power_cal_required} />],
            ["resistance calibration required", <Flag v={tr.resistance_cal_required} />],
            ["user config required", <Flag v={tr.user_config_required} />],
            ["target power limit", String(tr.target_power_limit ?? "-")],
            ["event counter", String(tr.event ?? "-")],
          ]}
        />
      </CardContent>
    </Card>
  )
}

function Calibration() {
  const cal = useStream((s) => s.calibration)
  const req = useStream((s) => s.calibrationRequest)
  const speed = useStream((s) => s.latest.speed?.ant_fe)
  const rows: [string, React.ReactNode][] = []
  if (cal) {
    const { t: _t, src: _s, raw: _r, kind: _k, page, ...fields } = cal
    rows.push(["page", page === 1 ? "RESULT" : "in progress"])
    for (const [k, v] of Object.entries(fields)) {
      const bad = v === "too_low" || v === false
      rows.push([k, bad ? <Badge variant="destructive">{String(v)}</Badge> : String(v)])
    }
    rows.push(["live speed (FE-C)", `${fmt(speed, 1)} km/h`])
  }
  return (
    <Card size="sm" data-testid="calibration">
      <CardHeader>
        <CardTitle>Calibration (ANT+ FE-C)</CardTitle>
        <CardDescription>Spindown: pedal to target speed, then stop pedalling</CardDescription>
        <CardAction className="flex gap-2">
          <Button size="sm" onClick={() => requestCalibration("spindown")}>
            Spindown
          </Button>
          <Button size="sm" variant="outline" onClick={() => requestCalibration("zero_offset")}>
            Zero offset
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {req && (
          <Alert variant={req.ok ? "default" : "destructive"} data-testid="calibration-request">
            <AlertDescription>{req.text}</AlertDescription>
          </Alert>
        )}
        {rows.length ? (
          <KV rows={rows} testId="calibration-pages" />
        ) : (
          <p className="text-muted-foreground">No calibration running.</p>
        )}
      </CardContent>
    </Card>
  )
}

function Events() {
  const events = useStream((s) => s.events)
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Events</CardTitle>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-72">
          <Table data-testid="events">
            <TableBody>
              {events.map((e, i) => (
                <TableRow key={`${e.t}-${i}`}>
                  <TableCell className="font-mono text-muted-foreground">{e.wall?.slice(11)}</TableCell>
                  <TableCell className="whitespace-normal">
                    {/STALL|FROZEN|error|disconnect/i.test(e.msg) ? (
                      <Badge variant="destructive">{e.msg}</Badge>
                    ) : (
                      e.msg
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}

function decoded(p: Packet) {
  const { t: _t, src: _s, raw: _r, kind: _k, ...rest } = p
  return Object.entries(rest)
    .map(([k, v]) => `${k}=${typeof v === "number" && !Number.isInteger(v) ? v.toFixed(1) : v}`)
    .join(" ")
}

function RawFeed() {
  const [filter, setFilter] = useState("all")
  const [frozen, setFrozen] = useState<Packet[] | null>(null)
  const live = useStream((s) => s.raw)
  const sources = useStream((s) => s.sources)
  const rows = (frozen ?? live).filter((p) => filter === "all" || p.src === filter).slice(0, 150)
  return (
    <Card size="sm" className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Raw packet feed</CardTitle>
        <CardDescription>Bytes as received, with the decoded fields</CardDescription>
        <CardAction className="flex gap-2">
          <Select value={filter} onValueChange={(v) => setFilter(v ?? "all")}>
            <SelectTrigger size="sm" data-testid="raw-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">all sources</SelectItem>
                {sources.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            data-testid="raw-pause"
            onClick={() => setFrozen(frozen ? null : live)}
          >
            {frozen ? <PlayIcon data-icon="inline-start" /> : <PauseIcon data-icon="inline-start" />}
            {frozen ? "Resume" : "Pause"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-80">
          <Table data-testid="raw-feed">
            <TableHeader>
              <TableRow>
                <TableHead>t (s)</TableHead>
                <TableHead>src</TableHead>
                <TableHead>hex</TableHead>
                <TableHead>decoded</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p, i) => (
                <TableRow key={`${p.src}-${p.t}-${i}`} data-src={p.src}>
                  <TableCell className="font-mono">{p.t.toFixed(2)}</TableCell>
                  <TableCell>{p.src}</TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {p.raw.match(/../g)?.join(" ")}
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal">{decoded(p)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}

function show(v: unknown): string {
  if (Array.isArray(v)) return v.join(", ")
  if (v && typeof v === "object")
    return Object.entries(v)
      .map(([k, x]) => `${k}: ${show(x)}`)
      .join("; ")
  return String(v)
}

type Gatt = { service: string; desc: string; chars: { uuid: string; props: string[]; desc: string }[] }[]

function DeviceConfig() {
  const config = useStream((s: StreamState) => s.config)
  const { gatt, ...rest } = config as { gatt?: Gatt } & Record<string, unknown>
  const entries = Object.entries(rest)
  return (
    <Card size="sm" className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Device config</CardTitle>
        <CardDescription>Read from GATT on connect</CardDescription>
        {rest.simulated === true && (
          <CardAction>
            <Badge variant="secondary" data-testid="simulated">
              simulated: {String(rest.scenario)}
            </Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {entries.length ? (
          <KV testId="device-config" rows={entries.map(([k, v]) => [k, show(v)])} />
        ) : (
          <p className="text-muted-foreground">Waiting for connection.</p>
        )}
        {gatt && gatt.length > 0 && (
          <Collapsible>
            <CollapsibleTrigger render={<Button variant="outline" size="sm" />}>
              GATT table
            </CollapsibleTrigger>
            <CollapsibleContent>
              <Table>
                <TableBody>
                  {gatt.flatMap((s) => [
                    <TableRow key={s.service}>
                      <TableHead colSpan={3}>
                        {s.service} {s.desc}
                      </TableHead>
                    </TableRow>,
                    ...s.chars.map((ch) => (
                      <TableRow key={`${s.service}-${ch.uuid}`}>
                        <TableCell className="font-mono">{ch.uuid}</TableCell>
                        <TableCell>{ch.props.join(", ")}</TableCell>
                        <TableCell>{ch.desc}</TableCell>
                      </TableRow>
                    )),
                  ])}
                </TableBody>
              </Table>
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  )
}

export function DashboardPage() {
  return (
    <div className="flex flex-col gap-4">
      <StatusBar />
      <Diagnosis />
      <MetricCards />
      <div className="grid gap-4 lg:grid-cols-2">
        {CHARTS.map((c) => (
          <Chart key={c.metric} {...c} />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Counters />
        <AntStatus />
        <Calibration />
        <Events />
        <RawFeed />
        <DeviceConfig />
      </div>
    </div>
  )
}
