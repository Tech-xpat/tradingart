'use client';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { IND_DEFS, IND_ORDER, indLabel, type IndInst, type IndKind } from './indicators';
import { TOOLS, PALETTE, type Drawing, type ToolId, type DashStyle } from './drawings';
import { CHART_TYPES, COLOR_PRESETS, type Prefs, type ChartType, type ScaleMode } from './prefs';

const Icon = ({ html, size = 18 }: { html: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden dangerouslySetInnerHTML={{ __html: html }} />
);
const CURSOR = '<path d="m5 3 14 8-6 2-2 6z"/>';
const MAGNET = '<path d="M6 3v8a6 6 0 0 0 12 0V3h-4v8a2 2 0 0 1-4 0V3z"/><path d="M6 7h4M14 7h4"/>';
const EYE = '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>';
const EYE_OFF = '<path d="M3 3l18 18M10.6 6.1A9 9 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 4M6.5 6.8A17 17 0 0 0 2 12s4 7 10 7a9 9 0 0 0 4-1"/>';
const TRASH = '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>';
const PIN = '<path d="M12 3v10M8 13h8M12 13v8"/>';
const UNDO = '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>';
const COPY = '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>';
const LOCK = '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>';
const GEAR = '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>';
const X = '<path d="M6 6l12 12M18 6 6 18"/>';
export { Icon, EYE, EYE_OFF, GEAR, X };

/** Vertical drawing toolbar. Each group is one button showing the last tool used; the small arrow opens the full list. */
export function Toolbar(p: {
  tool: ToolId; setTool: (t: ToolId) => void; sticky: boolean; setSticky: (b: boolean) => void; magnet: boolean; setMagnet: (b: boolean) => void;
  hidden: boolean; setHidden: (b: boolean) => void; count: number; onClear: () => void; onUndo: () => void; canUndo: boolean;
}) {
  const groups = ['Lines', 'Shapes', 'Measure'] as const;
  const [open, setOpen] = useState<string | null>(null);
  const [last, setLast] = useState<Record<string, ToolId>>({ Lines: 'trend', Shapes: 'rect', Measure: 'fib' });
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(null); };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [open]);
  const pick = (g: string, id: ToolId) => { setLast((l) => ({ ...l, [g]: id })); p.setTool(id); setOpen(null); };
  return (
    <div className="tvtools" role="toolbar" aria-label="Drawing tools" ref={root}>
      <button className={p.tool === 'cursor' ? 'on' : ''} title="Cursor (Esc)" aria-label="Cursor" aria-pressed={p.tool === 'cursor'} onClick={() => p.setTool('cursor')}><Icon html={CURSOR} /></button>
      {groups.map((g) => {
        const list = TOOLS.filter((t) => t.group === g), active = list.some((t) => t.id === p.tool), cur = list.find((t) => t.id === (active ? p.tool : last[g])) || list[0];
        return (
          <div className="tgroup" key={g}>
            <div className="tsplit">
              <button className={active ? 'on' : ''} title={`${cur.label}: ${cur.tip}`} aria-label={cur.label} aria-pressed={active} onClick={() => (active ? p.setTool('cursor') : pick(g, cur.id))}><Icon html={cur.icon} /></button>
              <button className="caret" title={`More ${g.toLowerCase()} tools`} aria-label={`More ${g.toLowerCase()} tools`} aria-expanded={open === g} onClick={() => setOpen(open === g ? null : g)}><svg width="8" height="8" viewBox="0 0 8 8" aria-hidden><path d="m2 1 4 3-4 3z" fill="currentColor" /></svg></button>
            </div>
            {open === g && (
              <div className="tfly" role="menu" aria-label={`${g} tools`}>
                <div className="tflyhead">{g}</div>
                {list.map((t) => (
                  <button key={t.id} role="menuitem" className={p.tool === t.id ? 'on' : ''} onClick={() => pick(g, t.id)}><Icon html={t.icon} size={16} /><span>{t.label}</span></button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <div className="tgroup">
        <button className={p.magnet ? 'on' : ''} title="Magnet: snap points to candle highs, lows, opens and closes" aria-label="Magnet" aria-pressed={p.magnet} onClick={() => p.setMagnet(!p.magnet)}><Icon html={MAGNET} /></button>
        <button className={p.sticky ? 'on' : ''} title="Keep the tool selected after each drawing" aria-label="Keep drawing" aria-pressed={p.sticky} onClick={() => p.setSticky(!p.sticky)}><Icon html={PIN} /></button>
        <button className={p.hidden ? 'on' : ''} title={p.hidden ? 'Show drawings' : 'Hide drawings'} aria-label="Hide drawings" aria-pressed={p.hidden} onClick={() => p.setHidden(!p.hidden)}><Icon html={p.hidden ? EYE_OFF : EYE} /></button>
        <button disabled={!p.canUndo} title="Undo (Ctrl+Z)" aria-label="Undo" onClick={p.onUndo}><Icon html={UNDO} /></button>
        <button disabled={!p.count} title="Remove all drawings" aria-label="Remove all drawings" onClick={p.onClear}><Icon html={TRASH} /></button>
      </div>
    </div>
  );
}

function Swatches({ value, onChange, label }: { value: string; onChange: (c: string) => void; label: string }) {
  return (
    <span className="swatches" role="group" aria-label={label}>
      {PALETTE.map((c) => <button key={c} className={`sw ${c.toLowerCase() === value.toLowerCase() ? 'on' : ''}`} style={{ background: c }} aria-label={`${label} ${c}`} onClick={() => onChange(c)} />)}
      <label className="sw custom" title="Pick any colour"><input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#f5b83d'} onChange={(e) => onChange(e.target.value)} aria-label={`${label} custom`} /></label>
    </span>
  );
}

/** Floating style bar for the selected drawing. */
export function DrawStyleBar({ d, onChange, onDelete, onClone }: { d: Drawing; onChange: (patch: Partial<Drawing>) => void; onDelete: () => void; onClone: () => void }) {
  const fills = d.kind === 'rect' || d.kind === 'channel' || d.kind === 'fib' || d.kind === 'measure' || d.kind === 'long' || d.kind === 'short';
  const noColor = d.kind === 'long' || d.kind === 'short' || d.kind === 'measure';
  const lineKinds = d.kind !== 'text' && d.kind !== 'measure' && d.kind !== 'long' && d.kind !== 'short';
  return (
    <div className="tvstyle" role="group" aria-label="Drawing style" onPointerDown={(e) => e.stopPropagation()}>
      {!noColor && <Swatches value={d.color} onChange={(color) => onChange({ color })} label="Colour" />}
      {lineKinds && (
        <>
          <select aria-label="Line width" value={d.width} onChange={(e) => onChange({ width: Number(e.target.value) })}>{[1, 2, 3, 4, 5].map((w) => <option key={w} value={w}>{w}px</option>)}</select>
          <select aria-label="Line style" value={d.style} onChange={(e) => onChange({ style: e.target.value as DashStyle })}><option value="solid">Solid</option><option value="dashed">Dashed</option><option value="dotted">Dotted</option></select>
        </>
      )}
      {fills && <label className="fillrow" title="Fill opacity">Fill <input type="range" min={0} max={0.6} step={0.02} value={d.fill} onChange={(e) => onChange({ fill: Number(e.target.value) })} aria-label="Fill opacity" /></label>}
      {(d.kind === 'trend' || d.kind === 'channel') && (
        <>
          <button className={d.extL ? 'on' : ''} title="Extend to the left" aria-pressed={!!d.extL} onClick={() => onChange({ extL: !d.extL })}>⇠</button>
          <button className={d.extR ? 'on' : ''} title="Extend to the right" aria-pressed={!!d.extR} onClick={() => onChange({ extR: !d.extR })}>⇢</button>
        </>
      )}
      {d.kind === 'fib' && <button className={d.extR ? 'on' : ''} title="Extend levels to the right" aria-pressed={!!d.extR} onClick={() => onChange({ extR: !d.extR })}>⇢</button>}
      {d.kind === 'trend' && <button className={d.info ? 'on' : ''} title="Show % change and bars" aria-pressed={!!d.info} onClick={() => onChange({ info: !d.info })}>%</button>}
      {d.kind === 'text' && <input className="notein" aria-label="Note text" maxLength={120} value={d.text ?? ''} onChange={(e) => onChange({ text: e.target.value })} placeholder="Note" />}
      <button className={d.locked ? 'on' : ''} title={d.locked ? 'Unlock' : 'Lock in place'} aria-label="Lock" aria-pressed={!!d.locked} onClick={() => onChange({ locked: !d.locked })}><Icon html={LOCK} size={15} /></button>
      <button title="Duplicate" aria-label="Duplicate" onClick={onClone}><Icon html={COPY} size={15} /></button>
      <button className="del" title="Delete (Del)" aria-label="Delete drawing" onClick={onDelete}><Icon html={TRASH} size={15} /></button>
    </div>
  );
}

function Panel({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`tvpanel ${wide ? 'wide' : ''}`} role="dialog" aria-label={title} onPointerDown={(e) => e.stopPropagation()}>
      <div className="phead"><b>{title}</b><button aria-label="Close" onClick={onClose}><Icon html={X} size={14} /></button></div>
      <div className="pbody">{children}</div>
    </div>
  );
}

/** Add an indicator: search plus grouped list. */
export function IndicatorPicker({ onAdd, onClose, count }: { onAdd: (k: IndKind) => void; onClose: () => void; count: number }) {
  const [q, setQ] = useState('');
  const rows = useMemo(() => IND_ORDER.map((k) => IND_DEFS[k]).filter((d) => !q.trim() || `${d.name} ${d.kind} ${d.group}`.toLowerCase().includes(q.trim().toLowerCase())), [q]);
  const groups = ['Trend', 'Momentum', 'Volatility', 'Volume'] as const;
  return (
    <Panel title="Indicators" onClose={onClose} wide>
      <input autoFocus className="psearch" type="search" placeholder="Search RSI, EMA, MACD…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search indicators" />
      {count >= 10 && <p className="hint warn">You have 10 indicators. Remove one to add another.</p>}
      {groups.map((g) => {
        const list = rows.filter((d) => d.group === g);
        if (!list.length) return null;
        return (
          <div key={g}>
            <div className="pgroup">{g}</div>
            {list.map((d) => (
              <button key={d.kind} className="prow" disabled={count >= 10} onClick={() => onAdd(d.kind)}>
                <span><b>{d.name}</b><small>{d.desc}</small></span>
                <em>{d.pane ? 'own pane' : 'on chart'}</em>
              </button>
            ))}
          </div>
        );
      })}
      {!rows.length && <p className="hint">Nothing matches “{q}”.</p>}
    </Panel>
  );
}

/** Edit one indicator's numbers and colours. */
export function IndicatorSettings({ ind, onChange, onRemove, onClose }: { ind: IndInst; onChange: (patch: Partial<IndInst>) => void; onRemove: () => void; onClose: () => void }) {
  const def = IND_DEFS[ind.kind];
  return (
    <Panel title={`${def.name} settings`} onClose={onClose}>
      {def.params.map((s) => (
        <label className="prow2" key={s.key}>{s.label}
          <input type="number" min={s.min} max={s.max} step={s.step ?? 1} value={ind.params[s.key] ?? s.def} onChange={(e) => onChange({ params: { ...ind.params, [s.key]: Number(e.target.value) } })} aria-label={s.label} />
        </label>
      ))}
      {def.outs.map((o, i) => (
        <label className="prow2" key={o.key}>{o.label} colour
          <input type="color" value={ind.colors[i] ?? o.color} onChange={(e) => { const colors = [...ind.colors]; colors[i] = e.target.value; onChange({ colors }); }} aria-label={`${o.label} colour`} />
        </label>
      ))}
      {def.outs.some((o) => !o.hist) && (
        <label className="prow2">Line width
          <select value={ind.width} onChange={(e) => onChange({ width: Number(e.target.value) })} aria-label="Line width">{[1, 2, 3, 4].map((w) => <option key={w} value={w}>{w}px</option>)}</select>
        </label>
      )}
      <div className="prow3">
        <button className="btn btn-ghost sm" onClick={() => onChange({ visible: !ind.visible })}>{ind.visible ? 'Hide' : 'Show'}</button>
        <button className="btn btn-danger sm" onClick={onRemove}>Remove {indLabel(ind)}</button>
      </div>
    </Panel>
  );
}

/** Look and feel of the chart. */
export function ChartSettings({ prefs, set, onClose, onReset }: { prefs: Prefs; set: (patch: Partial<Prefs>) => void; onClose: () => void; onReset: () => void }) {
  const Check = ({ k, label }: { k: 'grid' | 'volume' | 'lastLine' | 'markers' | 'magnet'; label: string }) => (
    <label className="prow2 chk">{label}<input type="checkbox" checked={prefs[k]} onChange={(e) => set({ [k]: e.target.checked } as Partial<Prefs>)} aria-label={label} /></label>
  );
  return (
    <Panel title="Chart settings" onClose={onClose}>
      <label className="prow2">Chart type
        <select value={prefs.type} onChange={(e) => set({ type: e.target.value as ChartType })} aria-label="Chart type">{CHART_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
      </label>
      <label className="prow2">Price scale
        <select value={prefs.scale} onChange={(e) => set({ scale: e.target.value as ScaleMode })} aria-label="Price scale">
          <option value="normal">Normal</option><option value="log">Logarithmic</option><option value="pct">Percentage</option>
        </select>
      </label>
      <Check k="volume" label="Volume bars" />
      <Check k="grid" label="Grid lines" />
      <Check k="lastLine" label="Last price line" />
      <Check k="magnet" label="Magnet for drawings" />
      <Check k="markers" label="Mark big buys and sells" />
      {prefs.markers && (
        <label className="prow2">Smallest trade marked (SOL)
          <input type="number" min={0} max={1000} step={0.5} value={prefs.markerMin} onChange={(e) => set({ markerMin: Math.max(0, Number(e.target.value) || 0) })} aria-label="Smallest trade marked in SOL" />
        </label>
      )}
      <div className="pgroup">Candle colours</div>
      <div className="presets">
        {COLOR_PRESETS.map((c) => (
          <button key={c.name} className={prefs.up === c.up && prefs.down === c.down ? 'on' : ''} onClick={() => set({ up: c.up, down: c.down })} aria-label={`${c.name} colours`}>
            <i style={{ background: c.up }} /><i style={{ background: c.down }} />{c.name}
          </button>
        ))}
      </div>
      <label className="prow2">Up colour<input type="color" value={prefs.up} onChange={(e) => set({ up: e.target.value })} aria-label="Up colour" /></label>
      <label className="prow2">Down colour<input type="color" value={prefs.down} onChange={(e) => set({ down: e.target.value })} aria-label="Down colour" /></label>
      <div className="prow3"><button className="btn btn-ghost sm" onClick={onReset}>Reset chart settings</button></div>
    </Panel>
  );
}
