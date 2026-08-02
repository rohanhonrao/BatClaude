// charts.js — dependency-free SVG charts. Each returns an SVG string.
import { fmtMoney, escapeHtml } from './util.js';

// Donut chart. segments: [{label, value, color}]
export function donut(segments, { size = 180, thickness = 26, centerLabel = '', centerSub = '' } = {}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const r = (size - thickness) / 2;
  const cx = size / 2, cy = size / 2;
  const circ = 2 * Math.PI * r;
  if (total <= 0) {
    return `<svg viewBox="0 0 ${size} ${size}" class="donut" role="img" aria-label="No data">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--line)" stroke-width="${thickness}"/>
      <text x="${cx}" y="${cy}" class="donut-center" text-anchor="middle" dominant-baseline="central">—</text>
    </svg>`;
  }
  let offset = 0;
  const arcs = segments.map((s) => {
    const frac = s.value / total;
    const dash = frac * circ;
    const el = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${thickness}"
      stroke-dasharray="${dash} ${circ - dash}" stroke-dashoffset="${-offset}"
      transform="rotate(-90 ${cx} ${cy})" stroke-linecap="butt"><title>${escapeHtml(s.label)}: ${fmtMoney(s.value)}</title></circle>`;
    offset += dash;
    return el;
  }).join('');
  return `<svg viewBox="0 0 ${size} ${size}" class="donut" role="img">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--line)" stroke-width="${thickness}"/>
    ${arcs}
    <text x="${cx}" y="${cy - 6}" class="donut-center" text-anchor="middle">${escapeHtml(centerLabel)}</text>
    <text x="${cx}" y="${cy + 14}" class="donut-sub" text-anchor="middle">${escapeHtml(centerSub)}</text>
  </svg>`;
}

// Grouped bar chart: income vs expense per month.
// data: [{mk, income, expense}]
export function barsIncomeExpense(data, { width = 320, height = 160 } = {}) {
  const pad = { l: 6, r: 6, t: 10, b: 20 };
  const w = width - pad.l - pad.r, h = height - pad.t - pad.b;
  const max = Math.max(1, ...data.flatMap((d) => [d.income, d.expense]));
  const groupW = w / data.length;
  const barW = Math.min(14, groupW / 3);
  let bars = '';
  data.forEach((d, i) => {
    const gx = pad.l + i * groupW + groupW / 2;
    const ih = (d.income / max) * h;
    const eh = (d.expense / max) * h;
    bars += `<rect x="${gx - barW - 1}" y="${pad.t + h - ih}" width="${barW}" height="${ih}" rx="2" fill="var(--green)"><title>Income ${fmtMoney(d.income)}</title></rect>`;
    bars += `<rect x="${gx + 1}" y="${pad.t + h - eh}" width="${barW}" height="${eh}" rx="2" fill="var(--red)"><title>Expense ${fmtMoney(d.expense)}</title></rect>`;
    const label = new Date(d.mk + '-01T00:00:00').toLocaleDateString(undefined, { month: 'short' });
    bars += `<text x="${gx}" y="${height - 6}" class="axis-label" text-anchor="middle">${label}</text>`;
  });
  return `<svg viewBox="0 0 ${width} ${height}" class="chart" role="img">${bars}</svg>`;
}

// Projected-balance chart. points: [{date, balance}] starting at today.
// Balances hold flat between events, so this draws a step line (accurate),
// with a dashed buffer line and the low point marked.
export function projectionChart(points, { width = 320, height = 168, buffer = 0, lowest = null } = {}) {
  if (!points || points.length < 2) return `<svg viewBox="0 0 ${width} ${height}" class="chart"></svg>`;
  const pad = { l: 6, r: 6, t: 14, b: 22 };
  const w = width - pad.l - pad.r, h = height - pad.t - pad.b;
  const dayOf = (iso) => {
    const p = String(iso).split('-');
    return Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000;
  };
  const d0 = dayOf(points[0].date);
  const dN = dayOf(points[points.length - 1].date);
  const span = Math.max(1, dN - d0);
  const vals = points.map((p) => p.balance);
  let min = Math.min(...vals, buffer, 0);
  let max = Math.max(...vals, buffer);
  if (max - min < 1) max = min + 1;
  const pace = (max - min) * 0.12;
  min -= pace; max += pace;
  const x = (iso) => pad.l + ((dayOf(iso) - d0) / span) * w;
  const y = (v) => pad.t + h - ((v - min) / (max - min)) * h;

  // Step path
  let d = `M${x(points[0].date)},${y(points[0].balance)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L${x(points[i].date)},${y(points[i - 1].balance)} L${x(points[i].date)},${y(points[i].balance)}`;
  }
  const area = `${d} L${x(points[points.length - 1].date)},${pad.t + h} L${x(points[0].date)},${pad.t + h} Z`;

  const bufY = y(buffer);
  const bufLine = buffer > 0
    ? `<line x1="${pad.l}" y1="${bufY}" x2="${width - pad.r}" y2="${bufY}" stroke="var(--red)" stroke-width="1" stroke-dasharray="3 3" opacity="0.6"/>
       <text x="${pad.l + 2}" y="${bufY - 3}" class="axis-label" fill="var(--red)" opacity="0.85">buffer</text>` : '';
  const zeroY = y(0);
  const zeroLine = min < 0
    ? `<line x1="${pad.l}" y1="${zeroY}" x2="${width - pad.r}" y2="${zeroY}" stroke="var(--line)" stroke-width="1"/>` : '';

  let lowDot = '';
  if (lowest && lowest.date) {
    const lx = x(lowest.date), ly = y(lowest.balance);
    const danger = lowest.balance < buffer;
    lowDot = `<circle cx="${lx}" cy="${ly}" r="3.5" fill="${danger ? 'var(--red)' : 'var(--gold)'}"/>`;
  }

  const startLbl = fmtDateShortISO(points[0].date);
  const endLbl = fmtDateShortISO(points[points.length - 1].date);
  return `<svg viewBox="0 0 ${width} ${height}" class="chart" role="img">
    <defs><linearGradient id="projGrad" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="var(--gold)" stop-opacity="0.26"/>
      <stop offset="100%" stop-color="var(--gold)" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#projGrad)"/>
    ${zeroLine}${bufLine}
    <path d="${d}" fill="none" stroke="var(--gold)" stroke-width="2.4" stroke-dasharray="5 4" stroke-linejoin="round"/>
    ${lowDot}
    <text x="${pad.l}" y="${height - 6}" class="axis-label">${startLbl}</text>
    <text x="${width - pad.r}" y="${height - 6}" class="axis-label" text-anchor="end">${endLbl}</text>
  </svg>`;
}
function fmtDateShortISO(iso) {
  const p = String(iso).split('-');
  const d = new Date(+p[0], +p[1] - 1, +p[2]);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// Line/area chart for a single series. data: [{mk, value}]
export function lineChart(data, { width = 320, height = 150, color = 'var(--gold)' } = {}) {
  const pad = { l: 6, r: 6, t: 12, b: 20 };
  const w = width - pad.l - pad.r, h = height - pad.t - pad.b;
  const vals = data.map((d) => d.value);
  const min = Math.min(...vals, 0), max = Math.max(...vals, 1);
  const range = max - min || 1;
  const x = (i) => pad.l + (data.length === 1 ? w / 2 : (i / (data.length - 1)) * w);
  const y = (v) => pad.t + h - ((v - min) / range) * h;
  const pts = data.map((d, i) => `${x(i)},${y(d.value)}`);
  const path = 'M' + pts.join(' L');
  const area = `${path} L${x(data.length - 1)},${pad.t + h} L${x(0)},${pad.t + h} Z`;
  let dots = '', labels = '';
  data.forEach((d, i) => {
    dots += `<circle cx="${x(i)}" cy="${y(d.value)}" r="2.5" fill="${color}"><title>${fmtMoney(d.value)}</title></circle>`;
    if (i === 0 || i === data.length - 1 || data.length <= 6) {
      const label = new Date(d.mk + '-01T00:00:00').toLocaleDateString(undefined, { month: 'short' });
      labels += `<text x="${x(i)}" y="${height - 6}" class="axis-label" text-anchor="middle">${label}</text>`;
    }
  });
  return `<svg viewBox="0 0 ${width} ${height}" class="chart" role="img">
    <defs><linearGradient id="areaGrad" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#areaGrad)"/>
    <path d="${path}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}${labels}
  </svg>`;
}
