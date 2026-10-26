// Reg-Gate status page. Served as a file so the CSP can forbid inline scripts.
(() => {
  'use strict';
  const SEPOLIA_HEX = '0xaa36a7';
  const DEFAULT_RPCS = ['https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.drpc.org'];
  const CATS = [
    ['STABLECOINS', 'Stablecoins', 'Issuance and reserves'],
    ['TOKENIZED_SECURITIES', 'Tokenized securities', 'SEC securities rules'],
    ['DIGITAL_ASSET_MARKETS', 'Digital asset markets', 'Trading, custody, listings'],
    ['AML_SANCTIONS', 'AML and sanctions', 'Where digital assets are involved'],
  ];
  const STATUS = ['OK', 'REVIEW', 'BLOCK'];
  const ADDR = /^0x[0-9a-fA-F]{40}$/;
  const DOCNUM = /^\d{4}-\d{4,6}$/;
  const FR_API = 'https://www.federalregister.gov/api/v1/documents/';
  const AGENCY_SHORT = {
    'securities-and-exchange-commission': 'SEC', 'commodity-futures-trading-commission': 'CFTC',
    'financial-crimes-enforcement-network': 'FinCEN', 'treasury-department': 'Treasury',
    'comptroller-of-the-currency': 'OCC', 'federal-deposit-insurance-corporation': 'FDIC',
    'federal-reserve-system': 'Federal Reserve', 'foreign-assets-control-office': 'OFAC',
    'consumer-financial-protection-bureau': 'CFPB', 'internal-revenue-service': 'IRS',
    'executive-office-of-the-president': 'White House', 'national-credit-union-administration': 'NCUA',
  };
  const T_STATUS = '0x7bb7e136e435ccb26bf677f3fce3572a4c8b33fad6b75908d576edff5ac77af8';
  const T_LATCHED = '0x45ca50b55474b3b1c5577ef29d3ec7bcb578f4353ccb6d3f10e3d0715a649963';
  const T_CLEARED = '0x1dd0de6cc67078b1932e1c8f833fd76ba4ce87e9b5619f33180bef3397f0f0f0';
  // KeystoneForwarder ReportProcessed(address indexed receiver, bytes32 indexed executionId, bytes2 indexed reportId, bool result)
  const T_PROCESSED = '0x3617b009e9785c42daebadb6d3fb553243a4bf586d07ea72d65d80013ce116b5';
  const LOG_CHUNK = 9000;     // stays under free-tier RPC range limits
  const LOG_MAX_CHUNKS = 12;  // about two weeks of Sepolia blocks
  const LOG_RETRIES = 8;      // per chunk; see getLogsChunked
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const ext = (href, text, cls) => { const a = el('a', cls || null, text); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; };
  const shortAddr = (a) => a.slice(0, 6) + '…' + a.slice(-4);
  // deployment.json is config, not trusted shape: anything malformed is dropped, never thrown on.
  const depTokens = (dep) => (Array.isArray(dep && dep.tokens) ? dep.tokens : []).filter((t) => t && typeof t === 'object' && typeof t.address === 'string' && ADDR.test(t.address) && typeof t.category === 'string');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const SVGNS = 'http://www.w3.org/2000/svg';
  function svg(view, parts) {
    const s = document.createElementNS(SVGNS, 'svg'); s.setAttribute('viewBox', view); s.setAttribute('aria-hidden', 'true');
    for (const [tag, attrs] of parts) { const p = document.createElementNS(SVGNS, tag); for (const k in attrs) p.setAttribute(k, attrs[k]); s.append(p); }
    return s;
  }

  // Optional ?rpc= override for local testing. Localhost only.
  const override = new URLSearchParams(location.search).get('rpc');
  // Local testing only: an override to any public host could show a fake status on the real
  // domain. The CSP blocks localhost in production too, so this only works on a local copy.
  const LOCAL_RPC = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/;
  const RPCS = override && LOCAL_RPC.test(override) ? [override] : DEFAULT_RPCS;
  const TEST_RPC = RPCS !== DEFAULT_RPCS;

  async function rpc(method, params, urls) {
    let lastErr;
    for (const url of urls || RPCS) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ctrl.signal });
        const j = await r.json();
        if (j.error) throw new Error(j.error.message || 'rpc error');
        if (j.result == null) throw new Error('empty rpc result');
        if (method === 'eth_call' && (typeof j.result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(j.result))) throw new Error('bad call result');
        return j.result;
      } catch (e) { lastErr = e; } finally { clearTimeout(t); }
    }
    throw lastErr || new Error('no rpc');
  }
  const BASE_SEPOLIA_HEX = '0x14a34';
  const baseOverride = new URLSearchParams(location.search).get('baserpc');
  const BASE_RPCS = baseOverride && LOCAL_RPC.test(baseOverride) ? [baseOverride] : ['https://base-sepolia-rpc.publicnode.com', 'https://sepolia.base.org'];

  /** First RPC that answers with the expected chain. Every read in one cycle then uses it. */
  async function pickRpc(urls, chainHex) {
    let lastErr = new Error('no rpc');
    for (const url of urls) {
      try {
        const id = await rpc('eth_chainId', [], [url]);
        if (String(id).toLowerCase() === chainHex) return url;
        lastErr = new Error('wrong chain ' + id);
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  // The classifier itself, built from reg-gate-workflow/rules.ts. Used only to explain
  // statuses; every status shown on this page comes from the contract.
  let rules = null;
  const rulesReady = import('./rules.js').then((m) => { rules = m; }, () => { rules = null; });
  const arg8 = (n) => n.toString(16).padStart(64, '0');
  const word = (hex, i) => { const w = hex.slice(2 + 64 * i, 2 + 64 * (i + 1)); if (w.length !== 64) throw new Error('short return data'); return w; };
  const uint = (w) => BigInt('0x' + w);
  const b32str = (w) => { let s = ''; for (let i = 0; i < 64; i += 2) { const c = parseInt(w.slice(i, i + 2), 16); if (c === 0) break; s += String.fromCharCode(c); } return s; };
  const SEL = { lastAsOf: '0xa89210cb', maxAge: '0x687043c5', statusOf: '0x6392d5aa', reportedStatus: '0x86106ee6',
    latchInfo: '0xa31cbc7b', transfersAllowed: '0xb0660c3d' };

  let chainNow = Math.floor(Date.now() / 1000);
  const fmt = (sec) => new Date(sec * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' });
  // The report's as-of day is a UTC date (the workflow's clock), so show it in UTC.
  const fmtDay = (sec) => new Date(sec * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

  // ---------- Federal Register titles: display only, never a status source
  const titles = new Map();
  async function loadTitles(docs) {
    let loaded = 0;
    // Skip documents already loaded or loading; a failed lookup is retried on the next cycle.
    const want = [...new Set(docs)].filter((d) => DOCNUM.test(d) && (!titles.has(d) || titles.get(d) === 'failed'));
    if (!want.length) return false;
    want.forEach((d) => titles.set(d, 'pending'));
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(FR_API + want.join(',') + '.json?fields%5B%5D=document_number&fields%5B%5D=title&fields%5B%5D=type&fields%5B%5D=agencies', { signal: ctrl.signal });
      if (!r.ok) throw new Error('status ' + r.status);
      const j = await r.json();
      for (const d of (Array.isArray(j.results) ? j.results : [j])) {
        if (!d || !want.includes(d.document_number) || typeof d.title !== 'string' || typeof d.type !== 'string') continue;
        // Prefer the most specific watched agency (FR lists parents first, e.g. Treasury before FinCEN).
        const ag = Array.isArray(d.agencies) ? d.agencies.slice().reverse().find((a) => a && AGENCY_SHORT[a.slug]) || d.agencies[0] : null;
        const agency = ag ? (AGENCY_SHORT[ag.slug] || (typeof ag.name === 'string' ? ag.name : '')) : '';
        titles.set(d.document_number, { title: d.title.slice(0, 400), type: d.type.slice(0, 40), agency: agency.slice(0, 60) });
        loaded++;
      }
    } catch { /* fall back to document numbers */ } finally { clearTimeout(t); }
    want.forEach((d) => { if (titles.get(d) === 'pending') titles.set(d, 'failed'); });
    return loaded > 0; // redraw only when something new can be shown
  }

  // ---------- The contract read panel
  /** Whether a demo token can move right now: the real transfer() call when there is one, else transfersAllowed(). */
  // The transfer() call decides only when it succeeded or the gate itself refused it. Any other
  // outcome (the demo holder short of balance, an odd return value) says nothing about the gate,
  // so fall back to transfersAllowed(), the value the board shows.
  function gateCall(t) { const v = t.sim ? describeCall(t.sim) : null; return v && (v.ok || v.gate) ? v : null; }
  function tokenOpen(t) {
    const v = gateCall(t);
    if (v) return v.ok;
    return t.allowed === true ? true : t.allowed === false ? false : null;
  }
  function renderCalls(state, animate) {
    const root = $('calls'); root.replaceChildren();
    CATS.forEach(([key, label], i) => {
      const r = state && state.rows ? state.rows[i] : null;
      const status = r ? r.status : 'UNKNOWN';
      const row = el('div', 'call r' + i + ' s-' + status);
      // Signal head: one lamp per aspect, top to bottom BLOCK, REVIEW, OK. A dark head means UNKNOWN.
      const head = el('span', 'head'); head.setAttribute('aria-hidden', 'true');
      for (const s of ['BLOCK', 'REVIEW', 'OK']) head.append(el('i', 'l-' + s + (s === status ? ' on' : '')));
      const nm = el('span', 'nm'); nm.append(el('b', null, label));
      const fn = el('span', 'fn'); fn.append('statusOf(', el('em', null, key), ')'); nm.append(fn);
      const val = el('span', 'val t-' + status + (animate ? ' pending' : ''), status);
      val.dataset.final = status;
      const doc = el('span', 'doc', r ? (r.doc ? (DOCNUM.test(r.doc) ? 'FR Doc. ' + r.doc : r.doc) : r.fresh ? 'no document' : 'stale') : '');
      const tok = state && state.tokens ? state.tokens.find((t) => t.category === key) : null;
      const open = tok ? tokenOpen(tok) : null;
      const rail = el('span', 'rail' + (tok ? (open === true ? ' lit' : ' cut') : ''));
      rail.setAttribute('aria-hidden', 'true');
      row.append(head, nm, val, doc, rail);
      root.append(row);
    });
  }
  function renderTxs(state) {
    const root = $('txs'); root.replaceChildren();
    if (!state || !state.tokens) return;
    for (const t of state.tokens) {
      const ci = CATS.findIndex(([k]) => k === t.category);
      const st = state.rows && ci >= 0 ? state.rows[ci].status : 'UNKNOWN';
      const at = ci >= 0 ? ' r' + ci : '';
      let line;
      const v = gateCall(t); // an actual eth_call of transfer(), when it speaks for the gate
      if (v && v.ok) { line = el('div', 'tx okay' + at); line.append(el('b', null, t.symbol + '.transfer(…)'), ' ', el('span', null, 'returns'), ' true'); }
      else if (v) { line = el('div', 'tx rev' + at); line.append(el('b', null, t.symbol + '.transfer(…)'), ' ', el('span', null, 'reverts'), ' ' + v.text); }
      else if (t.allowed === true) { line = el('div', 'tx okay' + at); line.append(el('b', null, t.symbol + '.transfersAllowed()'), ' ', el('span', null, 'returns'), ' true'); }
      else if (t.allowed === false) { line = el('div', 'tx rev' + at); line.append(el('b', null, t.symbol + '.transfersAllowed()'), ' ', el('span', null, 'returns'), ' false, ' + (st || 'BLOCK')); }
      else { line = el('div', 'tx' + at); line.append(el('b', null, t.symbol + '.transfer(…)'), ' ', el('span', null, 'unknown, treat as blocked')); }
      // Plain result first; the actual call it came from underneath, smaller.
      const okay = line.classList.contains('okay'), rev = line.classList.contains('rev');
      const call = el('span', 'callt'); call.append(...line.childNodes);
      const msg = el('span', 'msg');
      msg.append(el('b', null, t.symbol + ' '), el('span', 'plain', okay ? 'transfers go through' : rev ? 'transfers are blocked' : 'unknown, treated as blocked'), call);
      const gate = gateSvg(); gate.classList.add('gate', line.classList.contains('okay') ? 'up' : 'down');
      line.append(gate, msg);
      root.append(line);
    }
  }
  /** Decode a transfer() eth_call result for the read panel. */
  function describeCall(res) {
    if (!res.reverted) return { ok: res.data.length >= 66 && BigInt(res.data.slice(0, 66)) === 1n, text: 'returns ' + res.data.slice(0, 18) };
    const sel = res.data.slice(0, 10).toLowerCase();
    if (sel === '0xf87edc4d' && res.data.length >= 138) {
      const c = Number(uint(res.data.slice(10, 74))), st = STATUS[Number(uint(res.data.slice(74, 138)))] || 'unknown';
      return { ok: false, gate: true, text: 'TransferBlockedByRegGate(' + (c < CATS.length ? c : '?') + ', ' + st + ')' };
    }
    return { ok: false, text: SIM_ERR[sel] ? SIM_ERR[sel] + '()' : '(no reason returned)' };
  }
  async function runRead(animate) {
    const read = $('read');
    const vals = [...document.querySelectorAll('#calls .val')];
    const txs = [...document.querySelectorAll('#txs .tx')];
    if (!animate || REDUCED) {
      vals.forEach((v) => v.classList.remove('pending'));
      txs.forEach((t) => t.classList.add('show'));
      return;
    }
    read.classList.add('scanning');
    await wait(450);
    for (const v of vals) {
      v.classList.remove('pending'); v.classList.add('arrive');
      requestAnimationFrame(() => requestAnimationFrame(() => v.classList.remove('arrive')));
      await wait(260);
    }
    await wait(220);
    for (const t of txs) { t.classList.add('show'); await wait(320); }
    await wait(500);
    read.classList.remove('scanning');
  }

  // ---------- Metrics
  function countUp(node, to) {
    if (REDUCED || !Number.isFinite(to)) { node.textContent = Number.isFinite(to) ? String(to) : '?'; return; }
    const from = 0, dur = 900, t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 4);
      node.textContent = String(Math.round(from + (to - from) * e));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  let metricsShown = false, pendingMetrics = null, metricsVisible = false;
  function tryShowMetrics() {
    if (metricsShown || !metricsVisible || !pendingMetrics) return;
    metricsShown = true;
    countUp($('m1'), pendingMetrics.notClear); countUp($('m2'), pendingMetrics.blocked); countUp($('m3'), pendingMetrics.age); countUp($('m4'), 171);
  }
  function setMetrics(m) {
    pendingMetrics = m;
    $('m1s').textContent = ' of ' + CATS.length;
    $('m2s').textContent = ' of ' + (m.tokens || 0);
    $('m3s').textContent = ' ' + m.unit;
    const show = (v) => (Number.isFinite(v) ? String(v) : '?');
    if (metricsShown) { $('m1').textContent = show(m.notClear); $('m2').textContent = show(m.blocked); $('m3').textContent = show(m.age); }
    else tryShowMetrics();
  }
  const metricsObs = new IntersectionObserver((entries) => {
    metricsVisible = entries.some((e) => e.isIntersecting);
    tryShowMetrics();
  }, { threshold: .2 });

  // ---------- Why this status (rules.js recomputes; the contract decides)
  const openWhy = new Set();
  let trailSeq = 0;
  const CAT_NAME = Object.fromEntries(CATS.map(([k, n]) => [k, n]));
  const FIELD = { title: 'in the title', abstract: 'in the abstract', agency: '' };
  const agencyLabel = (slug) => AGENCY_SHORT[slug] || slug || 'an unnamed agency';
  // The report's own UTC date: the workflow judges effective dates against it, and its
  // publication window ends the day before.
  const reportDay = (sec, offset = 0) => new Date((Math.floor(sec / 86400) + offset) * 86400000).toISOString().slice(0, 10);
  const fmtIso = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || '') ? new Date(d + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'unknown');
  const stSpan = (name) => el('span', 'st-' + name, name);
  const arrow = () => el('span', 'arrow', '→');
  const fullDocs = new Map();
  function loadFullDoc(num) {
    if (fullDocs.has(num)) return fullDocs.get(num);
    const p = (async () => {
      const f = ['document_number', 'title', 'type', 'publication_date', 'effective_on', 'abstract', 'agencies'].map((x) => 'fields%5B%5D=' + x).join('&');
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
      try {
        let obj;
        try {
          const resp = await fetch(FR_API + num + '.json?' + f, { signal: ctrl.signal });
          if (!resp.ok) throw new Error('status ' + resp.status);
          obj = await resp.json();
        } catch { fullDocs.delete(num); return { error: 'network' }; }
        try {
          // The same strict parser the workflow uses: a surprise here means no explanation, not a wrong one.
          const doc = rules.parseFederalRegisterResponse(JSON.stringify({ count: 1, results: [obj] })).documents[0];
          if (doc.documentNumber !== num) throw new Error('wrong document');
          return { doc };
        } catch { fullDocs.delete(num); return { error: 'parse' }; }
      } finally { clearTimeout(t); }
    })();
    fullDocs.set(num, p);
    return p;
  }
  async function fillTrail(box, key, i, r, state) {
    const seq = String(++trailSeq); box.dataset.seq = seq;
    box.replaceChildren(el('div', 'tfoot', 'Recomputing.'));
    await rulesReady;
    const got = rules && r.doc && DOCNUM.test(r.doc) ? await loadFullDoc(r.doc) : null;
    const doc = got && got.doc ? got.doc : null;
    if (box.dataset.seq !== seq) return;
    const dl = el('dl');
    const row = (label, ...nodes) => { const w = el('div', 'trow'), dd = el('dd'); dd.append(...nodes); w.append(el('dt', null, label), dd); dl.append(w); };
    const asOf = reportDay(r.last);
    let warn = null;
    if (!r.doc) {
      row('Window', 'Federal Register publications through ' + fmtIso(reportDay(r.last, -1)) + ', plus final rules taking effect from the window start to a year ahead.');
      if (r.reported === 'OK') row('Match', 'Nothing in scope matched ' + CAT_NAME[key] + '.');
      else row('Match', el('span', 'm', 'No single document is recorded. The result set was larger than one page, so every category was floored at BLOCK rather than trusting a partial list.'));
    } else if (!DOCNUM.test(r.doc)) {
      row('Document', el('span', 'mono', r.doc));
      row('Explain', el('span', 'm', 'The stored value is not a Federal Register document number, so there is nothing to look up. The status comes straight from the contract.'));
    } else if (!doc) {
      row('Document', ext('https://www.federalregister.gov/d/' + r.doc, r.doc));
      const why = !rules ? 'The rules could not load.' : got && got.error === 'parse' ? 'The Federal Register answered with a shape the parser does not accept, so no explanation is shown.' : 'The Federal Register did not answer just now.';
      row('Explain', el('span', 'm', why + ' The status comes straight from the contract either way.'));
    } else {
      let e;
      try { e = rules.explain(doc, asOf); } catch { e = null; }
      if (!e) { row('Document', ext('https://www.federalregister.gov/d/' + doc.documentNumber, doc.documentNumber)); row('Explain', el('span', 'm', 'The rules could not explain this document. The status comes straight from the contract either way.')); }
      else {
      row('Document', ext('https://www.federalregister.gov/d/' + doc.documentNumber, doc.documentNumber), el('span', 'm', ', ' + doc.type.toLowerCase() + ', published ' + fmtIso(doc.publicationDate)));
      row('Agency', e.agencies.length ? e.agencies.map((a) => agencyLabel(a.slug) + (a.watched ? ', watched' : ', not watched')).join('; ') : 'None listed, so it stays in scope.');
      const mine = e.evidence.filter((x) => x.category === key);
      if (!mine.length) { row('Match', el('span', 'm', 'Under the current rules this document does not match ' + CAT_NAME[key] + '.')); warn = true; }
      for (const ev of mine) {
        const what = ev.field === 'agency' ? [agencyLabel(ev.term) + ' is an AML agency'] : [el('q', null, ev.term), ' ' + FIELD[ev.field]];
        row('Match', ...what, arrow(), CAT_NAME[key], ev.note && ev.field !== 'agency' ? el('span', 'm', ' (' + ev.note + ')') : '');
      }
      const others = e.categories.filter((c) => c !== key).map((c) => CAT_NAME[c]);
      if (others.length) row('Also', 'Counts for ' + others.join(', ') + ' too.');
      row('Exclusions', e.outcome === 'informational' ? el('span', 'm', 'Informational (' + (e.informational === 'sro-filing' ? 'an exchange rule filing' : 'a withdrawn proposal') + '), so it should not move a status.') : 'Not an exchange rule filing, not a withdrawn proposal.');
      if (e.outcome === 'matched') {
        const reason = e.severityReason.charAt(0).toUpperCase() + e.severityReason.slice(1);
        row('Severity', reason, arrow(), stSpan(STATUS[e.severity]));
        if (STATUS[e.severity] !== r.reported) warn = true;
      } else warn = true;
      }
    }
    const enforced = [' Enforced ', stSpan(r.status)];
    let why = '';
    if (!r.fresh) why = ', because the report is stale.';
    else if (r.latched) why = ', held for review of ' + (r.latchDoc || 'a blocking result with no document') + (r.unreviewed > 1 ? ' (' + r.unreviewed + ' blocking documents unreviewed)' : '') + '.';
    else if (r.reported === 'BLOCK' && r.status === 'REVIEW') why = ', a person reviewed every blocking document.';
    else why = '.';
    row('On-chain', 'Reported ', stSpan(r.reported), '.', ...enforced, why);
    for (const t of (state.tokens || []).filter((x) => x.category === key)) {
      const open = t.allowed === true;
      row('Token', t.symbol + (t.strict ? ' is strict, so it moves only on OK. ' : ' is lenient, so it stops only on BLOCK. '), t.allowed == null ? 'Unreadable, treat as blocked.' : 'Transfers are ' + (open ? 'open.' : 'blocked.'));
    }
    if (warn) row('Note', el('span', 'warnline', 'This recomputation differs from the stored report. The contract enforces the report. A difference means the rules changed after that report or the result set was truncated.'));
    const foot = el('div', 'tfoot');
    if (rules) foot.append('Recomputed in your browser by ', el('code', null, 'rules.js'), ', a build of the classifier the CRE workflow runs.');
    else foot.append('Recomputation unavailable. Every status above comes from the contract.');
    box.replaceChildren(dl, foot);
  }

  // ---------- Transfer simulator (eth_call only)
  let simTokens = [], simHolder = null, simSetup = false, simGen = 0;
  const SIM_ERR = { '0xf87edc4d': 'TransferBlockedByRegGate', '0xf4d678b8': 'InsufficientBalance', '0xd92e233d': 'ZeroAddress' };
  function parseAmount(v) {
    const m = /^(\d{1,12})(?:\.(\d{1,18}))?$/.exec(v);
    if (!m) return null;
    const wei = BigInt(m[1]) * 10n ** 18n + BigInt((m[2] || '').padEnd(18, '0'));
    return wei > 0n ? wei : null; // the error text promises a positive amount
  }
  async function callRaw(tx, block, urls) {
    let lastErr;
    for (const url of urls || RPCS) {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctrl.signal,
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [tx, block] }) });
        const j = await r.json();
        if (j.error) {
          const d = j.error.data, hex = typeof d === 'string' ? d : d && typeof d.data === 'string' ? d.data : null;
          if (hex && /^0x[0-9a-fA-F]*$/.test(hex)) return { reverted: true, data: hex };
          if (/revert/i.test(String(j.error.message || ''))) return { reverted: true, data: '0x' };
          throw new Error(j.error.message || 'rpc error');
        }
        if (typeof j.result === 'string' && /^0x[0-9a-fA-F]*$/.test(j.result)) return { reverted: false, data: j.result };
        throw new Error('bad result');
      } catch (e) { lastErr = e; } finally { clearTimeout(t); }
    }
    throw lastErr || new Error('no rpc');
  }
  function simBody(...nodes) { $('simbody').replaceChildren(...nodes); }
  /** Drop any shown or in-flight simulator result: it no longer matches what the page shows. */
  function invalidateSim(msg) {
    if (!simSetup) { simBody(el('div', 'oline', msg)); return; }
    if (!simTokens.length || !simHolder) return;
    ++simGen; $('simout').classList.remove('busy'); $('simout').removeAttribute('aria-busy');
    $('simblock').textContent = ''; simBody(el('div', 'oline', msg));
  }
  function setupSim(dep) {
    if (simSetup) return; simSetup = true;
    simTokens = depTokens(dep).filter((t) => /^[A-Za-z0-9]{1,11}$/.test(t.symbol || ''));
    simHolder = ADDR.test(dep.demoHolder || '') ? dep.demoHolder : null;
    const fs = $('simtokens');
    const preferred = simTokens.some((t) => t.symbol === 'gAST') ? 'gAST' : simTokens[0] && simTokens[0].symbol;
    for (const t of simTokens) {
      const lab = el('label'), inp = el('input'), sp = el('span');
      inp.type = 'radio'; inp.name = 'token'; inp.value = t.address; inp.checked = t.symbol === preferred;
      sp.append(el('b', null, t.symbol), el('small', null, (CAT_NAME[t.category] || t.category) + ', ' + (t.strict ? 'strict' : 'lenient')));
      lab.append(inp, sp); fs.append(lab);
    }
    $('simform').addEventListener('submit', (ev) => { ev.preventDefault(); runSim(); });
    fs.addEventListener('change', () => runSim()); // a new token gets its own result at once
    for (const id of ['simamt', 'simto']) $(id).addEventListener('input', () => { $(id).removeAttribute('aria-invalid'); $('simerr').textContent = ''; });
    if (!simTokens.length || !simHolder) { $('simbtn').disabled = true; simBody(el('div', 'oline', 'No demo token is recorded for this deployment.')); return; }
    runSim();
  }
  async function runSim() {
    if (!simTokens.length || !simHolder) return; // nothing to simulate against
    const err = $('simerr'), amtIn = $('simamt'), toIn = $('simto');
    err.textContent = ''; amtIn.removeAttribute('aria-invalid'); toIn.removeAttribute('aria-invalid');
    const amtText = amtIn.value.trim(), amt = parseAmount(amtText), to = toIn.value.trim();
    const gen = ++simGen, out = $('simout');
    out.classList.remove('busy'); out.removeAttribute('aria-busy'); // any older run in flight is now superseded
    const sel = document.querySelector('#simtokens input:checked');
    const t = simTokens.find((x) => sel && x.address === sel.value) || simTokens[0];
    const rejected = () => { $('simhead').textContent = t.symbol + '.transfer(address,uint256)'; $('simblock').textContent = ''; simBody(el('div', 'oline', 'Nothing was simulated. Correct the input and run it again.')); };
    if (amt === null) { amtIn.setAttribute('aria-invalid', 'true'); err.textContent = 'Amount must be a positive number of up to 12 digits, with at most 18 decimal places.'; rejected(); amtIn.focus(); return; }
    if (!ADDR.test(to)) { toIn.setAttribute('aria-invalid', 'true'); err.textContent = 'Recipient must be 0x followed by 40 hex characters.'; rejected(); toIn.focus(); return; }
    // Only simulate against the RPC this page just verified as Sepolia, and only while
    // the page itself could read the contract. Otherwise say so rather than guess.
    if (!lastState || !lastState.rows || !lastState.url) {
      $('simblock').textContent = '';
      simBody(el('div', 'oline', 'The page cannot read the contract right now, so nothing was simulated. It retries every minute.'));
      return;
    }
    const at = [lastState.url];
    out.classList.add('busy'); out.setAttribute('aria-busy', 'true'); // the button stays enabled so keyboard focus is kept
    try {
      const id = await rpc('eth_chainId', [], at);
      if (String(id).toLowerCase() !== SEPOLIA_HEX) throw new Error('wrong chain');
      const block = await rpc('eth_blockNumber', [], at);
      if (gen !== simGen) return; // a newer run replaced this one
      const data = '0xa9059cbb' + to.slice(2).toLowerCase().padStart(64, '0') + amt.toString(16).padStart(64, '0');
      const res = await callRaw({ from: simHolder, to: t.address, data }, block, at);
      if (gen !== simGen) return; // a newer run replaced this one
      $('simblock').textContent = 'block ' + Number(BigInt(block)).toLocaleString('en-US');
      $('simhead').textContent = t.symbol + '.transfer(address,uint256)';
      const lines = [];
      const l1 = el('div', 'oline'); l1.append('call  ', el('b', null, t.symbol + '.transfer'), '(' + shortAddr(to) + ', ' + amtText + ' ' + t.symbol + ')');
      const l2 = el('div', 'oline'); l2.append('from  ' + shortAddr(simHolder) + ', the demo deployer, holds the supply');
      const l3 = el('div', 'oline'); l3.append('token ', ext('https://sepolia.etherscan.io/address/' + t.address, shortAddr(t.address)));
      lines.push(l1, l2, l3);
      const v = el('div', 'verdict');
      const cat = CAT_NAME[t.category] || t.category;
      if (!res.reverted) {
        const ok = res.data.length >= 66 && BigInt(res.data.slice(0, 66)) === 1n;
        v.className = 'verdict ' + (ok ? 'okay' : 'rev');
        v.append(el('b', null, ok ? 'returns true' : 'returns ' + res.data.slice(0, 18)));
        v.append(el('span', 'plain', ok ? cat + ' allows it: ' + t.symbol + ' is ' + (t.strict ? 'strict and the status is OK.' : 'lenient and the status is not BLOCK.') : 'Unexpected return value. Treat as not transferred.'));
      } else {
        v.className = 'verdict rev';
        const name = SIM_ERR[res.data.slice(0, 10).toLowerCase()];
        if (name === 'TransferBlockedByRegGate' && res.data.length >= 138) {
          const c = Number(uint(res.data.slice(10, 74))), st = STATUS[Number(uint(res.data.slice(74, 138)))] || 'unknown';
          v.append(el('b', null, 'reverts TransferBlockedByRegGate(' + (c < CATS.length ? c : '?') + ', ' + st + ')'));
          v.append(el('span', 'plain', (CATS[c] ? CATS[c][1] : 'An unknown category') + ' is ' + st + '. ' + t.symbol + (t.strict ? ' is strict, so it moves only on OK.' : ' is lenient, so it stops only on BLOCK.')));
        } else if (name === 'InsufficientBalance') {
          v.append(el('b', null, 'reverts InsufficientBalance()'));
          v.append(el('span', 'plain', 'The gate let it through; the sender just holds less than that amount.'));
        } else if (name === 'ZeroAddress') {
          v.append(el('b', null, 'reverts ZeroAddress()'));
          v.append(el('span', 'plain', 'The recipient is the zero address.'));
        } else {
          v.append(el('b', null, 'reverts'));
          v.append(el('span', 'plain', 'No reason was returned. Treat as not transferred.'));
        }
      }
      lines.push(v);
      simBody(...lines);
    } catch {
      if (gen !== simGen) return;
      $('simblock').textContent = '';
      simBody(el('div', 'oline', 'Sepolia did not answer. Nothing was simulated; try again in a moment.'));
    } finally { if (gen === simGen) { out.classList.remove('busy'); out.removeAttribute('aria-busy'); } }
  }

  // ---------- Networks: the same status on each chain, read from each chain
  async function readChain(gate, urls, chainHex) {
    // One verified RPC and one block for every read, so results cannot mix nodes or heights.
    const at = [await pickRpc(urls, chainHex)];
    const blk = await rpc('eth_getBlockByNumber', ['latest', false], at);
    if (!blk || !blk.timestamp || !blk.number) throw new Error('no block');
    if (!LOCAL_RPC.test(at[0]) && Date.now() / 1000 - Number(BigInt(blk.timestamp)) > NODE_LAG_MAX) throw new Error('rpc node lagging');
    const tag = '0x' + BigInt(blk.number).toString(16);
    const callAt = (to, data) => rpc('eth_call', [{ to, data }, tag], at);
    const [lastHex, maxHex] = await Promise.all([callAt(gate, SEL.lastAsOf), callAt(gate, SEL.maxAge)]);
    const now = Number(BigInt(blk.timestamp)), lastBig = uint(word(lastHex, 0)), maxBig = uint(word(maxHex, 0));
    if (lastBig > BigInt(now) + 3600n || maxBig === 0n || maxBig > 400n * 86400n) throw new Error('implausible contract values');
    const last = Number(lastBig), maxAge = Number(maxBig);
    const rows = await Promise.all(CATS.map(async (_, i) => {
      const [s, rep] = await Promise.all([callAt(gate, SEL.statusOf + arg8(i)), callAt(gate, SEL.reportedStatus + arg8(i))]);
      const st = Number(uint(word(s, 0))), rs = Number(uint(word(rep, 0)));
      if (!(st in STATUS) || !(rs in STATUS)) throw new Error('bad status value');
      return { status: STATUS[st], reported: STATUS[rs], doc: last ? b32str(word(rep, 1)) : '' };
    }));
    return { last, maxAge, fresh: last > 0 && now <= last + maxAge, rows };
  }
  function netCard(n) {
    const card = el('div', 'net');
    const head = el('div', 'nethead'); head.append(el('b', null, n.name), el('span', null, 'chain ' + n.chainId));
    const rows = el('div', 'netrows');
    CATS.forEach(([, label], i) => {
      const r = n.data ? n.data.rows[i] : null, st = r ? r.status : 'UNKNOWN';
      const row = el('div', 'netrow'), left = el('span', null, label);
      if (r && r.doc) left.append(el('span', 'd', r.doc));
      row.append(left, el('span', 'chip t-' + st, st));
      rows.append(row);
    });
    const foot = el('div', 'netfoot');
    foot.append(el('span', null, n.data ? (n.data.last ? 'last report ' + fmt(n.data.last) + (n.data.fresh ? '' : ', stale') : 'no report yet') : 'unreachable, treat as BLOCK'),
      ext(n.explorer + '/address/' + n.gate, shortAddr(n.gate)));
    card.append(head, rows, foot);
    return card;
  }
  let netGen = 0;
  async function loadNetworks(dep, state) {
    const gen = ++netGen;
    const m = Array.isArray(dep.mirrors) ? dep.mirrors.find((x) => x && x.chainId === 84532 && ADDR.test(x.regGateStatus)) : null;
    if (!m) { $('networks').hidden = true; return; }
    $('networks').hidden = false;
    let mdata = null;
    try { mdata = await readChain(m.regGateStatus, BASE_RPCS, BASE_SEPOLIA_HEX); } catch { mdata = null; }
    if (gen !== netGen) return; // a newer cycle already rendered
    const primary = { name: 'Ethereum Sepolia', chainId: 11155111, gate: dep.regGateStatus, explorer: 'https://sepolia.etherscan.io', data: state.rows ? { last: state.last, fresh: state.fresh, rows: state.rows } : null };
    const mirror = { name: 'Base Sepolia', chainId: 84532, gate: m.regGateStatus, explorer: 'https://sepolia.basescan.org', data: mdata };
    $('nets').replaceChildren(netCard(primary), netCard(mirror));
    const sync = $('sync'); sync.replaceChildren();
    if (!primary.data || !mirror.data) { sync.append(el('b', null, 'One chain is unreachable right now. '), 'Its contract keeps enforcing its last report until that report goes stale.'); return; }
    const P = primary.data.rows, M = mirror.data.rows;
    const diff = CATS.filter((_, i) => P[i].status !== M[i].status || P[i].reported !== M[i].reported || P[i].doc !== M[i].doc).map(([, n]) => n);
    if (primary.data.fresh !== mirror.data.fresh) sync.append(el('b', null, 'Differs: one chain is stale. '), 'The stale chain enforces BLOCK until its next report.');
    else if (!diff.length) sync.append(el('b', null, 'In sync. '), 'Same enforced statuses and documents on both chains. Each chain is written only when its own copy is out of date, so report times can differ.');
    else sync.append(el('b', null, 'Differs on ' + diff.join(', ') + '. '), 'Each chain is checked on its own; the next run writes to the one that is behind.');
  }

  // ---------- Integrate
  function setGateAddrs(dep) {
    const box = $('gateaddrs'); box.replaceChildren();
    box.append('Ethereum Sepolia ', ext('https://sepolia.etherscan.io/address/' + dep.regGateStatus, shortAddr(dep.regGateStatus)));
    const m = Array.isArray(dep.mirrors) ? dep.mirrors.find((x) => x && x.chainId === 84532 && ADDR.test(x.regGateStatus)) : null;
    if (m) box.append(el('br'), 'Base Sepolia ', ext('https://sepolia.basescan.org/address/' + m.regGateStatus, shortAddr(m.regGateStatus)));
  }
  $('copy').addEventListener('click', async () => {
    const b = $('copy');
    try { await navigator.clipboard.writeText($('snippet').textContent); b.textContent = 'Copied'; }
    catch { b.textContent = 'Select to copy'; }
    setTimeout(() => { b.textContent = 'Copy'; }, 1600);
  });

  // ---------- Board
  function gateSvg() {
    return svg('0 0 48 34', [
      ['rect', { x: '2', y: '9', width: '5', height: '25', rx: '2.5', fill: 'currentColor' }],
      ['rect', { x: '41', y: '16', width: '5', height: '18', rx: '2.5', fill: 'currentColor', opacity: '.45' }],
      ['rect', { class: 'bar', x: '3', y: '9.5', width: '43', height: '5.5', rx: '2.75', fill: 'currentColor' }],
    ]);
  }
  let boardSeen = false, boardVisible = false;
  function tryAnimateGates() {
    if (boardSeen || !boardVisible) return;
    const pre = document.querySelectorAll('.tok.pre');
    if (!pre.length) return;
    boardSeen = true;
    pre.forEach((n, i) => setTimeout(() => n.classList.remove('pre'), 150 + i * 180));
  }
  function renderBoard(state) {
    const root = $('board');
    // Keep keyboard focus on the same Why button across re-renders.
    const focusId = document.activeElement && root.contains(document.activeElement) ? document.activeElement.getAttribute('aria-controls') : null;
    root.replaceChildren();
    CATS.forEach(([key, label, sub], i) => {
      const r = state && state.rows ? state.rows[i] : null;
      const status = r ? r.status : 'UNKNOWN';
      const lane = el('div', 'lane s-' + status);
      const c = el('div'); c.append(el('div', 'cat', label), el('div', 'cat-sub', sub));
      const d = el('div');
      if (!r) d.append(el('p', 'title quiet', 'Status unreadable. Treat as BLOCK.'));
      else if (!r.last) d.append(el('p', 'title quiet', 'No report yet. Treat as BLOCK.'));
      else if (!r.doc) d.append(el('p', 'title quiet', r.reported === 'OK' ? 'No matching publication in the window.' : 'No document recorded.'));
      else if (!DOCNUM.test(r.doc)) d.append(el('p', 'title mono', r.doc));
      else {
        const info = titles.get(r.doc), known = info && typeof info === 'object';
        d.append(el('p', 'title' + (known ? '' : ' quiet'), known ? info.title : info === 'pending' ? 'Loading the document title.' : 'Federal Register document'));
        const src = el('div', 'src');
        const what = known ? [info.agency, info.type.toLowerCase()].filter(Boolean).join(', ') : '';
        if (what) src.append(what + ', ');
        src.append(ext('https://www.federalregister.gov/d/' + r.doc, r.doc));
        if (!r.fresh) src.append(' (last report)');
        d.append(src);
      }
      if (r && r.latched) d.append(el('span', 'flag', 'Latched until a reviewer clears it'));
      else if (r && !r.fresh && r.last) d.append(el('span', 'flag', 'BLOCK because the report is stale'));
      let trail = null;
      if (r && r.last) {
        const btn = el('button', 'whybtn');
        btn.type = 'button';
        btn.setAttribute('aria-expanded', openWhy.has(key) ? 'true' : 'false');
        btn.setAttribute('aria-controls', 'why-' + key);
        btn.append('Why ' + status, svg('0 0 10 10', [['path', { d: 'M1.5 3.5L5 7l3.5-3.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]]));
        btn.addEventListener('click', () => {
          const open = btn.getAttribute('aria-expanded') !== 'true';
          btn.setAttribute('aria-expanded', open ? 'true' : 'false');
          if (open) { openWhy.add(key); trail.hidden = false; fillTrail(trail, key, i, r, state); }
          else { openWhy.delete(key); trail.hidden = true; }
        });
        d.append(el('br'), btn);
        trail = el('div', 'trail'); trail.id = 'why-' + key; trail.hidden = !openWhy.has(key);
      }
      const chip = el('span', 'chip t-' + status, status);
      const toks = state && state.tokens ? state.tokens.filter((t) => t.category === key) : [];
      let g;
      if (!toks.length) g = el('div', 'none-tok', 'No demo token');
      else {
        g = el('div');
        for (const t of toks) {
          const a = t.allowed, tone = a === true ? 'OK' : a === false ? 'BLOCK' : 'UNKNOWN';
          const box = el('div', 'tok t-' + tone + (a === true ? ' open' : ' shut') + (boardSeen || REDUCED ? '' : ' pre'));
          const txt = el('div');
          txt.append(el('b', null, t.symbol), el('span', 'st', a === true ? 'Transfers open' : a === false ? 'Transfers blocked' : 'Unknown'));
          const why = a === null || a === undefined ? 'Unreadable, treat as blocked' : t.strict ? 'Strict: moves only on OK' : 'Lenient: stops only on BLOCK';
          txt.append(el('span', 'why', why));
          box.append(gateSvg(), txt);
          g.append(box);
        }
      }
      lane.append(c, d, chip, g);
      if (trail) { lane.append(trail); if (!trail.hidden) fillTrail(trail, key, i, r, state); }
      root.append(lane);
    });
    if (focusId) { const b = root.querySelector('[aria-controls="' + focusId + '"]'); if (b) b.focus(); }
    requestAnimationFrame(tryAnimateGates);
  }
  const boardObs = new IntersectionObserver((entries) => {
    boardVisible = entries.some((e) => e.isIntersecting);
    tryAnimateGates();
  }, { threshold: .35 });

  // ---------- Events: contract events plus reports the contract rejected
  let feedKey = null;
  function decodeLog(l) {
    if (!l || !Array.isArray(l.topics) || typeof l.data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(l.data)) return null;
    const t0 = String(l.topics[0]).toLowerCase();
    try {
      const time = l.blockTimestamp ? Number(BigInt(l.blockTimestamp)) : null;
      const base = { tx: /^0x[0-9a-fA-F]{64}$/.test(l.transactionHash) ? l.transactionHash : null,
        block: Number(BigInt(l.blockNumber)), index: Number(BigInt(l.logIndex || '0x0')), time };
      if (t0 === T_STATUS && l.topics.length >= 2) {
        const sts = [0, 1, 2, 3].map((i) => STATUS[Number(uint(word(l.data, i)))] || 'unknown');
        const okCount = sts.filter((s) => s === 'OK').length;
        const detail = CATS.map(([, n], i) => n + ' ' + sts[i]).join(', ');
        return { ...base, time: time || Number(BigInt(l.topics[1])), what: 'Report accepted', tone: 'OK', detail: okCount + ' of 4 clear. ' + detail + '.' };
      }
      if ((t0 === T_LATCHED || t0 === T_CLEARED) && l.topics.length >= 2) {
        const cat = Number(BigInt(l.topics[1])), doc = b32str(word(l.data, 0)) || 'no document';
        const name = CATS[cat] ? CATS[cat][1] : 'Category ' + cat;
        if (t0 === T_LATCHED) return { ...base, what: 'BLOCK latched', tone: 'BLOCK', detail: name + ', document ' + doc + '.' };
        return { ...base, what: 'Reviewer cleared', tone: 'REVIEW', detail: name + ', document ' + doc + '. The workflow re-checks now.' };
      }
      if (t0 === T_PROCESSED && l.data.length >= 66 && BigInt(l.data.slice(0, 66)) === 0n) {
        return { ...base, what: 'Report rejected', tone: 'BLOCK', detail: 'The contract refused it and nothing changed. The forwarder logged result false.' };
      }
    } catch { return null; }
    return null;
  }
  async function getLogsChunked(filter, from, latest, at) {
    const out = [];
    for (let f = from; f <= latest; f += LOG_CHUNK) {
      const to = Math.min(f + LOG_CHUNK - 1, latest);
      // The public RPC is load-balanced and some of its nodes answer "pruned history
      // unavailable" for ranges others serve. Retry a chunk a few times before giving up.
      let part, lastErr;
      for (let attempt = 0; attempt < LOG_RETRIES; attempt++) {
        try { part = await rpc('eth_getLogs', [{ ...filter, fromBlock: '0x' + f.toString(16), toBlock: '0x' + to.toString(16) }], at); break; }
        catch (e) { lastErr = e; part = undefined; await wait(250 + attempt * 150); }
      }
      if (part === undefined) throw lastErr || new Error('logs unavailable');
      if (!Array.isArray(part)) throw new Error('bad logs');
      out.push(...part.filter((l) => !l.removed));
    }
    return out;
  }
  let feedGen = 0;
  async function loadFeed(dep, latest, at, lastReport) {
    const gen = ++feedGen;
    const list = $('events');
    try {
      const gate = dep.regGateStatus.toLowerCase();
      const fromBlock = Number(dep.fromBlock);
      const start = Math.max(Number.isInteger(fromBlock) && fromBlock > 0 ? fromBlock : latest - LOG_CHUNK, latest - LOG_CHUNK * LOG_MAX_CHUNKS);
      const own = (await getLogsChunked({ address: gate, topics: [[T_STATUS, T_LATCHED, T_CLEARED]] }, start, latest, at))
        .filter((l) => String(l.address).toLowerCase() === gate);
      let fwd = [];
      if (ADDR.test(dep.forwarder || '')) {
        try {
          fwd = (await getLogsChunked({ address: dep.forwarder, topics: [T_PROCESSED, '0x' + gate.slice(2).padStart(64, '0')] }, start, latest, at))
            .filter((l) => String(l.address).toLowerCase() === dep.forwarder.toLowerCase());
        } catch { fwd = []; }
      }
      const events = [...own, ...fwd].map(decodeLog).filter(Boolean).sort((a, b) => b.block - a.block || b.index - a.index).slice(0, 8);
      if (gen !== feedGen) return; // a newer load replaced this one
      list.replaceChildren();
      if (!events.length) {
        const li = el('li');
        if (lastReport) li.append(el('span', 't', 'none recent'), el('span', 'w', 'No recent events'), el('span', 'd', 'The last report, ' + fmt(lastReport) + ', is older than the two weeks this list covers.'));
        else li.append(el('span', 't', 'none yet'), el('span', 'w', 'No reports yet'));
        list.append(li); return;
      }
      for (const e of events) {
        const li = el('li');
        const w = el('span', 'w t-' + e.tone, e.what);
        li.append(el('span', 't', e.time ? fmt(e.time) : 'block ' + e.block), w, el('span', 'd', e.detail),
          e.tx ? ext('https://sepolia.etherscan.io/tx/' + e.tx, e.tx.slice(0, 6) + '…' + e.tx.slice(-4), 'x') : el('span', 'x', ''));
        list.append(li);
      }
    } catch {
      if (gen !== feedGen) return;
      const li = el('li'); li.append(el('span', 't', 'unavailable'), el('span', 'w', 'Events unreadable'), el('span', 'd', 'Statuses above come straight from the contract.'));
      list.replaceChildren(li);
      feedKey = null;
    }
  }


  // ---------- Headline: the live result in one plain sentence. Never claims more than the read shows.
  function setHeadline(head, sub) {
    // Written only when it changes, so a screen reader announces a new result once, not every minute.
    if ($('headline').textContent !== head) $('headline').textContent = head;
    if ($('subline').textContent !== sub) $('subline').textContent = sub;
  }
  function headlineFor(state) {
    const rows = state.rows, toks = state.tokens || [];
    const nc = rows.filter((r) => r.status !== 'OK');
    let head;
    if (!nc.length) head = 'All ' + CATS.length + ' categories are clear.';
    else {
      const kinds = new Set(nc.map((r) => r.status));
      const one = nc.length === 1;
      const verb = kinds.size === 1 && kinds.has('REVIEW') ? (one ? 'needs review' : 'need review')
        : kinds.size === 1 && kinds.has('BLOCK') ? (one ? 'is blocked' : 'are blocked') : (one ? 'needs attention' : 'need attention');
      head = nc.length + ' of ' + CATS.length + ' categories ' + verb + '.';
    }
    const parts = toks.map((t) => {
      const ci = CATS.findIndex(([k]) => k === t.category);
      const open = tokenOpen(t);
      const cat = ci >= 0 ? CATS[ci][1].toLowerCase() : 'its category';
      const st = ci >= 0 ? rows[ci].status : 'UNKNOWN';
      if (open === true) return t.symbol + ' can still move.';
      if (open === false) return t.symbol + ' transfers are blocked while ' + cat + ' reads ' + st + '.';
      return t.symbol + ' could not be checked, so treat it as blocked.';
    });
    return [head, parts.join(' ') || 'No demo tokens are configured.'];
  }

  // ---------- Page state
  function setLive(kind, text) { $('live').className = 'live ' + kind; $('livetext').textContent = text; }
  function setAlert(strong, text) {
    const a = $('alert'), key = strong ? strong + ' ' + text : '';
    if (a.dataset.key === key) return; // unchanged: leave it, so it is not re-announced
    a.dataset.key = key; a.replaceChildren();
    a.hidden = !strong;
    if (strong) { const s = el('div'); s.append(el('b', null, strong + ' '), text); a.append(s); }
  }

  let lastSig = null, lastStatusSig = null, firstRun = true, lastState = null, feedTick = 0, maxBlockSeen = 0;
  const NODE_LAG_MAX = 30 * 60; // seconds a node's newest block may trail this computer's clock
  async function load() {
    let dep;
    try {
      const r = await fetch('deployment.json', { cache: 'no-store' });
      if (r.status === 404) throw new Error('not-deployed');
      if (!r.ok) throw new Error('status ' + r.status);
      dep = await r.json();
      if (!ADDR.test(dep.regGateStatus)) throw new Error('bad address');
    } catch (e) {
      const missing = e && e.message === 'not-deployed';
      setLive('bad', missing ? 'Not deployed' : 'Configuration unreadable');
      $('read-addr').textContent = missing ? 'not deployed' : 'unknown';
      if (missing) setAlert('Not deployed.', 'Statuses appear once RegGateStatus is live on Sepolia.');
      else setAlert('The page could not load its configuration.', 'Showing UNKNOWN rather than guessing, so treat every transfer as blocked. Retrying every minute.');
      // Forget everything shown so far, so nothing stale survives and the next good cycle redraws in full.
      lastState = null; lastSig = null; lastStatusSig = null; feedKey = null; netGen++; feedGen++;
      renderCalls(null, false); renderTxs(null); renderBoard(null); runRead(false);
      { const li = el('li'); li.append(el('span', 't', 'unavailable'), el('span', 'w', 'Events unreadable'), el('span', 'd', 'The page could not load its configuration.')); $('events').replaceChildren(li); }
      setMetrics({ notClear: NaN, blocked: NaN, tokens: 0, age: NaN, unit: 'days' });
      $('networks').hidden = true;
      $('read-net').textContent = 'Not read'; $('read-last').textContent = 'last report unknown'; $('read-until').textContent = ''; $('window').textContent = '';
      invalidateSim('Nothing was simulated. The page could not load its configuration.');
      setHeadline(missing ? 'Not deployed yet.' : 'The page could not load its configuration.', 'Every transfer counts as blocked until it loads. Retrying every minute.');
      return;
    }
    const gate = dep.regGateStatus;
    const scan = 'https://sepolia.etherscan.io/address/' + gate;
    for (const id of ['nav-contract', 'cta-contract']) { const a = $(id); a.href = scan; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    setGateAddrs(dep);
    $('read-addr').textContent = shortAddr(gate);

    let state;
    try {
      // One RPC for the whole cycle, checked to be Sepolia, so reads cannot mix chains.
      const url = await pickRpc(RPCS, SEPOLIA_HEX);
      const at = [url];
      // Freshness by chain time, the same clock the contract uses. No block time, no verdict.
      const block = await rpc('eth_getBlockByNumber', ['latest', false], at);
      if (!block || !block.timestamp || !block.number) throw new Error('no block');
      chainNow = Number(BigInt(block.timestamp));
      const latestBlock = Number(BigInt(block.number));
      // A load-balanced RPC can hand us a node that is behind. Never present an old block as live:
      // not one older than the last cycle's, and not one far behind this computer's clock.
      if (latestBlock < maxBlockSeen) throw new Error('rpc node behind the last read');
      if (!TEST_RPC && Date.now() / 1000 - chainNow > NODE_LAG_MAX) throw new Error('rpc node lagging');
      maxBlockSeen = latestBlock;
      const blockTag = '0x' + latestBlock.toString(16);
      const callAt = (to, data) => rpc('eth_call', [{ to, data }, blockTag], at);
      const [lastHex, maxHex] = await Promise.all([callAt(gate, SEL.lastAsOf), callAt(gate, SEL.maxAge)]);
      const lastBig = uint(word(lastHex, 0)), maxBig = uint(word(maxHex, 0));
      // Values a real contract cannot hold mean bad data: show UNKNOWN, never a computed date.
      if (lastBig > BigInt(chainNow) + 3600n || maxBig === 0n || maxBig > 400n * 86400n) throw new Error('implausible contract values');
      const last = Number(lastBig), maxAge = Number(maxBig);
      const fresh = last > 0 && chainNow <= last + maxAge;
      const rows = await Promise.all(CATS.map(async (_, i) => {
        const [s, rep, latch] = await Promise.all([callAt(gate, SEL.statusOf + arg8(i)), callAt(gate, SEL.reportedStatus + arg8(i)), callAt(gate, SEL.latchInfo + arg8(i))]);
        const st = Number(uint(word(s, 0))), rs = Number(uint(word(rep, 0)));
        if (!(st in STATUS) || !(rs in STATUS)) throw new Error('bad status value');
        const unreviewed = uint(word(latch, 2));
        return { status: STATUS[st], reported: STATUS[rs], doc: last ? b32str(word(rep, 1)) : '', latched: uint(word(latch, 0)) === 1n,
          latchDoc: b32str(word(latch, 1)), unreviewed: unreviewed > 16n ? 16 : Number(unreviewed), fresh, last };
      }));
      const tokens = depTokens(dep).map((t) => ({ ...t }));
      const holder = ADDR.test(dep.demoHolder || '') ? dep.demoHolder : null;
      const probe = '0xa9059cbb' + '0'.repeat(60) + 'beef' + (10n ** 18n).toString(16).padStart(64, '0');
      await Promise.all(tokens.map(async (t) => {
        try { t.allowed = uint(word(await callAt(t.address, SEL.transfersAllowed), 0)) === 1n; } catch { t.allowed = null; }
        // The read panel shows a real transfer() call, not one inferred from two reads.
        if (holder) { try { t.sim = await callRaw({ from: holder, to: t.address, data: probe }, blockTag, at); } catch { t.sim = null; } }
      }));
      state = { rows, tokens, last, maxAge, fresh, latestBlock, url };

      if (TEST_RPC) { setLive('bad', 'Test RPC, not live'); setAlert('Reading a local test RPC.', 'These statuses are not the live Sepolia contract.'); }
      else if (!last) { setLive('bad', 'No report yet'); setAlert('No report yet.', 'Every category reads BLOCK until the workflow writes its first report.'); }
      else if (!fresh) { setLive('bad', 'Stale on Sepolia'); setAlert('Stale, so every transfer is blocked.', 'No fresh report arrived within the freshness limit. That is the fail-closed design working: silence blocks transfers.'); }
      else { setLive('ok', 'Live on Sepolia'); setAlert(null); }
      if (!last) setHeadline('No report yet.', 'Every category reads BLOCK until the workflow writes its first report.');
      else if (!fresh) setHeadline('The report is stale, so every transfer is blocked.', 'No fresh report arrived in time. Silence blocks, by design.');
      else { const [h, sub] = headlineFor(state); setHeadline(h, sub); }
      $('read-net').textContent = latestBlock ? 'Read at block ' + latestBlock.toLocaleString('en-US') : 'Read from Sepolia';
      $('read-last').textContent = last ? 'last report ' + fmt(last) : 'no report yet';
      $('read-until').textContent = last ? (fresh ? 'fresh until ' : 'stale since ') + fmt(last + maxAge) : '';
      $('window').textContent = last ? 'report of ' + fmtDay(last) + (fresh ? '' : ', stale') : 'no report yet';
      // Time left before this report goes stale and every category reads BLOCK.
      const left = last ? Math.max(0, last + maxAge - chainNow) : 0;
      const inDays = left >= 2 * 86400;
      const amount = inDays ? Math.floor(left / 86400) : Math.floor(left / 3600);
      setMetrics({ notClear: rows.filter((r) => r.status !== 'OK').length, blocked: tokens.filter((t) => t.allowed !== true).length, tokens: tokens.length,
        age: amount, unit: !last ? 'hours, no report yet' : !fresh ? 'hours, already BLOCK' : inDays ? 'days' : amount === 1 ? 'hour' : 'hours' });
    } catch {
      setLive('bad', 'Sepolia unreadable');
      setAlert('Sepolia is unreachable or returned bad data.', 'Showing UNKNOWN rather than guessing, so treat every transfer as blocked. Retrying every minute.');
      setHeadline('Sepolia cannot be read right now.', 'Every status shows UNKNOWN and every transfer counts as blocked until the chain answers.');
      state = { rows: null, tokens: depTokens(dep).map((t) => ({ ...t, allowed: null })) };
      setMetrics({ notClear: NaN, blocked: NaN, tokens: state.tokens.length, age: NaN, unit: 'days' });
      $('read-last').textContent = 'last report unknown'; $('read-until').textContent = '';
      $('read-net').textContent = 'Not read'; $('window').textContent = 'status unknown';
    }

    lastState = state;
    // Everything any view shows, so a new report with the same statuses still refreshes dates and Why panels.
    const sig = JSON.stringify([state.last, state.rows && state.rows.map((r) => [r.status, r.reported, r.doc, r.latched, r.latchDoc, r.unreviewed, r.fresh]),
      state.tokens.map((t) => [t.allowed, t.sim ? t.sim.data : null])]);
    // What a transfer would do: when this changes, the read animation replays and old simulator results expire.
    const statusSig = JSON.stringify([state.rows && state.rows.map((r) => [r.status, r.fresh]), state.tokens.map((t) => t.allowed)]);
    const changed = sig !== lastSig; lastSig = sig;
    const statusChanged = statusSig !== lastStatusSig; lastStatusSig = statusSig;
    if (changed) {
      renderCalls(state, state.rows != null && (firstRun || statusChanged)); renderTxs(state); renderBoard(state);
      runRead(state.rows != null && (firstRun || statusChanged));
    }
    if (statusChanged && !firstRun) invalidateSim('The status changed since the last result. Run it again.');
    firstRun = false;

    setupSim(dep);
    loadNetworks(dep, state);
    if (state.rows) {
      loadTitles(state.rows.map((r) => r.doc).filter(Boolean)).then((did) => { if (did && lastState === state) renderBoard(state); });
      const key = gate + '|' + state.last + '|' + state.rows.map((r) => [r.latched ? 1 : 0, r.latchDoc, r.unreviewed].join(':')).join('|');
      // Rejected reports change nothing on the contract, so also refresh the list every fifth cycle.
      if (state.latestBlock && (key !== feedKey || ++feedTick % 5 === 0)) { feedKey = key; loadFeed(dep, state.latestBlock, [state.url], state.last); }
    }
  }

  $('simform').addEventListener('submit', (ev) => ev.preventDefault());
  renderCalls(null, true); renderBoard(null);
  metricsObs.observe(document.querySelector('.metrics'));
  boardObs.observe($('board'));
  // One load at a time: the next starts a minute after the last one finished, so a slow
  // cycle can never land after a newer one and overwrite it.
  (async function cycle() {
    try { await load(); } catch { /* load renders its own error state */ }
    setTimeout(cycle, 60000);
  })();
})();
