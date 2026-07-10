// csv.js — CSV parsing (RFC-4180-ish) plus transaction import/export helpers.

export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  // Drop trailing empty line
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

export function csvToObjects(text) {
  const rows = parseCSV(text);
  if (rows.length < 1) return { headers: [], rows: [] };
  const headers = rows[0].map((h) => h.trim());
  const objects = rows.slice(1).map((r) => {
    const o = {};
    headers.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
    return o;
  });
  return { headers, rows: objects };
}

// Heuristic: guess which columns map to date / description / amount / (debit/credit).
export function guessMapping(headers) {
  const find = (...names) => headers.find((h) => names.some((n) => h.toLowerCase().replace(/[^a-z]/g, '').includes(n)));
  return {
    date: find('date', 'valuedate', 'txndate', 'transactiondate') || '',
    description: find('description', 'narration', 'particulars', 'details', 'remarks', 'note', 'payee', 'merchant') || '',
    amount: find('amount', 'value', 'transactionamount') || '',
    debit: find('debit', 'withdrawal', 'paidout', 'dr') || '',
    credit: find('credit', 'deposit', 'paidin', 'cr') || '',
  };
}

export function normalizeDate(s) {
  s = String(s).trim();
  // Already ISO
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // DD/MM/YYYY or DD-MM-YYYY (assume day-first, common outside US)
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) {
    let [_, d, mo, y] = m;
    if (y.length === 2) y = '20' + y;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // Fallback to Date parsing
  const d = new Date(s);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return '';
}

function num(s) {
  const n = parseFloat(String(s).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

// Convert mapped CSV objects into draft transactions.
// Returns [{date, note, type, amount}], skipping unparseable rows.
export function rowsToTransactions(rows, map) {
  const out = [];
  for (const r of rows) {
    const date = normalizeDate(r[map.date]);
    if (!date) continue;
    const note = (r[map.description] || '').trim();
    let type, amount;
    if (map.debit && map.credit && (r[map.debit] || r[map.credit])) {
      const dr = num(r[map.debit]), cr = num(r[map.credit]);
      if (cr > 0) { type = 'income'; amount = cr; }
      else { type = 'expense'; amount = dr; }
    } else if (map.amount) {
      const a = num(r[map.amount]);
      type = a < 0 ? 'expense' : 'income';
      amount = Math.abs(a);
    } else continue;
    if (!amount) continue;
    out.push({ date, note, type, amount });
  }
  return out;
}

// --- Export -----------------------------------------------------------------

function csvField(v) {
  v = v == null ? '' : String(v);
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

export function transactionsToCSV(transactions, { categories, accounts }) {
  const catName = (id) => (categories.find((c) => c.id === id) || {}).name || '';
  const acctName = (id) => (accounts.find((a) => a.id === id) || {}).name || '';
  const header = ['Date', 'Type', 'Amount', 'Category', 'Account', 'To Account', 'Note', 'Tags'];
  const lines = [header.join(',')];
  for (const t of [...transactions].sort((a, b) => a.date.localeCompare(b.date))) {
    lines.push([
      t.date, t.type, t.amount, catName(t.categoryId),
      acctName(t.accountId), t.toAccountId ? acctName(t.toAccountId) : '',
      t.note || '', (t.tags || []).join(' '),
    ].map(csvField).join(','));
  }
  return lines.join('\n');
}
