import { IND_DEFS, cleanParams, makeInd, type IndInst, type IndKind } from './indicators';

export type ChartType = 'candles' | 'hollow' | 'bars' | 'line' | 'area' | 'ha';
export type ScaleMode = 'normal' | 'log' | 'pct';
export type Prefs = {
  type: ChartType; tf: number; scale: ScaleMode; grid: boolean; volume: boolean; lastLine: boolean;
  markers: boolean; markerMin: number; up: string; down: string; magnet: boolean; hideDrawings: boolean; inds: IndInst[];
};

export const TF = [
  { s: 1, l: '1s' }, { s: 5, l: '5s' }, { s: 15, l: '15s' }, { s: 30, l: '30s' },
  { s: 60, l: '1m' }, { s: 300, l: '5m' }, { s: 900, l: '15m' }, { s: 3600, l: '1h' },
];
export const CHART_TYPES: { id: ChartType; label: string }[] = [
  { id: 'candles', label: 'Candles' }, { id: 'hollow', label: 'Hollow candles' }, { id: 'ha', label: 'Heikin Ashi' },
  { id: 'bars', label: 'Bars (OHLC)' }, { id: 'line', label: 'Line' }, { id: 'area', label: 'Area' },
];
export const COLOR_PRESETS = [
  { name: 'Classic', up: '#22c55e', down: '#ef4444' },
  { name: 'Blue / Orange', up: '#38bdf8', down: '#fb923c' },
  { name: 'Mono', up: '#e6e9ee', down: '#6b7280' },
  { name: 'Teal / Pink', up: '#2dd4bf', down: '#f472b6' },
];

export const DEFAULT_PREFS: Prefs = {
  type: 'candles', tf: 5, scale: 'normal', grid: true, volume: true, lastLine: true,
  markers: false, markerMin: 1, up: '#22c55e', down: '#ef4444', magnet: true, hideDrawings: false, inds: [],
};

const KEY = 'art.chart.prefs.v1';
const hex = (s: unknown, d: string) => (typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s) ? s : d);
const bool = (b: unknown, d: boolean) => (typeof b === 'boolean' ? b : d);

/** Read saved settings, repairing anything odd. Never throws. */
export function sanitizePrefs(raw: unknown): Prefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_PREFS;
  const inds: IndInst[] = [];
  if (Array.isArray(o.inds)) {
    for (const r of o.inds.slice(0, 10)) {
      if (!r || typeof r !== 'object') continue;
      const x = r as Record<string, unknown>, kind = x.kind as IndKind;
      if (!(kind in IND_DEFS)) continue;
      const base = makeInd(kind), def = IND_DEFS[kind];
      inds.push({
        id: typeof x.id === 'string' && x.id.length < 40 ? x.id : base.id, kind,
        params: cleanParams(kind, (x.params && typeof x.params === 'object' ? x.params : {}) as Record<string, number>),
        colors: def.outs.map((out, i) => hex(Array.isArray(x.colors) ? x.colors[i] : undefined, out.color)),
        width: typeof x.width === 'number' && x.width >= 1 && x.width <= 4 ? Math.round(x.width) : 2,
        visible: bool(x.visible, true),
      });
    }
  }
  return {
    type: CHART_TYPES.some((t) => t.id === o.type) ? (o.type as ChartType) : d.type,
    tf: TF.some((t) => t.s === o.tf) ? (o.tf as number) : d.tf,
    scale: o.scale === 'log' || o.scale === 'pct' ? o.scale : 'normal',
    grid: bool(o.grid, d.grid), volume: bool(o.volume, d.volume), lastLine: bool(o.lastLine, d.lastLine),
    markers: bool(o.markers, d.markers), markerMin: typeof o.markerMin === 'number' && o.markerMin >= 0 && o.markerMin <= 1000 ? o.markerMin : d.markerMin,
    up: hex(o.up, d.up), down: hex(o.down, d.down), magnet: bool(o.magnet, d.magnet), hideDrawings: bool(o.hideDrawings, d.hideDrawings), inds,
  };
}
export function loadPrefs(): Prefs {
  try { const s = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null; return sanitizePrefs(s ? JSON.parse(s) : null); } catch { return sanitizePrefs(null); }
}
export function savePrefs(p: Prefs) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ } }
