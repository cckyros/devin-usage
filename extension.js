const vscode = require('vscode');

const API_SERVER = 'https://server.codeium.com';
const SEAT_MGMT = `${API_SERVER}/exa.seat_management_pb.SeatManagementService`;
const SECRET_KEY = 'devinUsage.sessionToken';
const SHOW_AUTH_CODE_URL = 'https://app.devin.ai/auth/windsurf/show-auth-code';
const REFRESH_MS = 5 * 60 * 1000;

let out;
let statusBar;
let panel;
let lastData = null;   // normalized usage model
let lastError = null;
let lastFetchedAt = 0;
let refreshing = false;
let timer;

function log(...args) {
  const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  out.appendLine(line);
}

// ---------- data layer ----------

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', ...headers },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { }
  return { status: res.status, text, json };
}

async function signIn(context) {
  const url = `${SHOW_AUTH_CODE_URL}?prompt=select_account&state=${vscode.env.sessionId}&intent=windsurf&from=redirect`;
  await vscode.env.openExternal(vscode.Uri.parse(url));
  const code = await vscode.window.showInputBox({
    title: 'Devin Usage — Sign In',
    prompt: 'The Devin page shows an auth code. Copy it and paste here.',
    placeHolder: 'auth code',
    ignoreFocusOut: true
  });
  if (!code) return;
  const r = await postJson(`${SEAT_MGMT}/ExchangeDevinCode`, { code: code.trim() });
  const token = r.json && (r.json.sessionToken || r.json.session_token);
  if (!token) {
    log('exchange failed', r.status, r.text.slice(0, 300));
    vscode.window.showErrorMessage('Devin Usage: failed to exchange auth code');
    return;
  }
  await context.secrets.store(SECRET_KEY, token);
  vscode.window.showInformationMessage('Devin Usage: signed in');
  await refresh(context, true);
}

async function fetchUsage(context) {
  const token = await context.secrets.get(SECRET_KEY);
  if (!token) return { kind: 'no-auth' };
  const metadata = {
    ideName: 'windsurf', ideVersion: vscode.version,
    extensionName: 'windsurf', extensionVersion: '0.2.0',
    apiKey: token, locale: vscode.env.language, os: process.platform,
    sessionId: vscode.env.sessionId, requestId: String(Date.now())
  };
  const r = await postJson(`${SEAT_MGMT}/GetUserStatus`, { metadata });
  if (r.status !== 200 || !r.json) return { kind: 'error', detail: `HTTP ${r.status}` };
  const u = r.json.userStatus;
  const ps = u && u.planStatus;
  if (!u || !ps) return { kind: 'error', detail: 'no planStatus in response' };
  const pi = ps.planInfo || {};
  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  return {
    kind: 'ok',
    planName: pi.planName || 'Free',
    isDevin: !!pi.isDevin,
    billingStrategy: pi.billingStrategy || '',
    email: u.email || '',
    account: u.name || '',
    dailyRemainingPercent: num(ps.dailyQuotaRemainingPercent),
    weeklyRemainingPercent: num(ps.weeklyQuotaRemainingPercent),
    overageBalanceMicros: num(ps.overageBalanceMicros),
    dailyResetAtUnix: num(ps.dailyQuotaResetAtUnix),
    weeklyResetAtUnix: num(ps.weeklyQuotaResetAtUnix),
    flexCredits: num(ps.availableFlexCredits),
    hideDailyQuota: !!pi.hideDailyQuota,
    hideWeeklyQuota: !!pi.hideWeeklyQuota,
    acuConsumed: ps.acuConsumed != null ? Number(ps.acuConsumed) : null,
    acuLimit: ps.acuLimit != null ? Number(ps.acuLimit) : null
  };
}

// ---------- rendering ----------

function fmtReset(unix) {
  if (!unix) return '';
  const ms = unix * 1000 - Date.now();
  if (ms <= 0) return 'resetting…';
  const d = Math.floor(ms / 864e5), h = Math.floor(ms % 864e5 / 36e5), m = Math.floor(ms % 36e5 / 6e4);
  const date = new Date(unix * 1000);
  const local = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
    date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const rel = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  return `resets in ${rel} (${local})`;
}

function fmtMoney(micros) {
  const usd = Math.abs(micros) / 1e6;
  return usd === 0 ? '$0.00' : '$' + usd.toFixed(2);
}

function barClass(pct) {
  return pct <= 10 ? 'crit' : pct <= 30 ? 'warn' : 'ok';
}

function updateStatusBar(context) {
  const d = lastData;
  if (!d || d.kind === 'no-auth') {
    statusBar.text = '$(zap) Devin: Sign in';
    statusBar.tooltip = 'Devin Usage — click to sign in';
    statusBar.command = 'devinUsage.signIn';
    statusBar.color = undefined;
  } else if (d.kind === 'error') {
    statusBar.text = '$(zap) Devin: --';
    statusBar.tooltip = `Devin Usage — ${d.detail || 'fetch failed'} (click to retry)`;
    statusBar.command = 'devinUsage.refresh';
    statusBar.color = new vscode.ThemeColor('statusBarItem.warningForeground');
  } else {
    const w = d.weeklyRemainingPercent, dd = d.dailyRemainingPercent;
    statusBar.text = `$(zap) W ${w}% D ${dd}%`;
    statusBar.tooltip = `Devin ${d.planName} — weekly ${w}% left · daily ${dd}% left\nClick for details`;
    statusBar.command = 'devinUsage.showDashboard';
    const worst = Math.min(d.hideWeeklyQuota ? 100 : w, d.hideDailyQuota ? 100 : dd);
    statusBar.color = worst <= 10
      ? new vscode.ThemeColor('statusBarItem.errorForeground')
      : worst <= 30 ? new vscode.ThemeColor('statusBarItem.warningForeground') : undefined;
  }
  statusBar.show();
}

function barHtml(label, pct, resetUnix) {
  const used = Math.max(0, Math.min(100, 100 - pct));
  const cls = barClass(pct);
  return `
  <div class="row">
    <div class="row-head"><span>${label}</span><span class="pct">${pct}% <span class="dim">left</span></span></div>
    <div class="bar"><div class="fill ${cls}" style="width:${Math.max(used, 2)}%"></div></div>
    <div class="row-foot"><span class="dim">${used}% used</span><span class="dim">${fmtReset(resetUnix)}</span></div>
  </div>`;
}

function html(d) {
  const bars = [];
  if (d.kind === 'ok') {
    if (!d.hideDailyQuota) bars.push(barHtml('Daily quota', d.dailyRemainingPercent, d.dailyResetAtUnix));
    if (!d.hideWeeklyQuota) bars.push(barHtml('Weekly quota', d.weeklyRemainingPercent, d.weeklyResetAtUnix));
  }
  const over = d.overageBalanceMicros || 0;
  const overHtml = over !== 0
    ? `<div class="row purchase ${over < 0 ? 'over-neg' : ''}">
         <div class="row-head"><span>Overage ${over < 0 ? 'due' : 'balance'}</span><span class="money">${fmtMoney(over)}</span></div>
         <div class="row-foot"><span class="dim">${over < 0 ? 'charged beyond plan quota this cycle' : 'prepaid overage remaining'}</span></div>
       </div>` : '';
  const credits = d.flexCredits ? `<div class="chip">Add-on credits: <b>${d.flexCredits}</b></div>` : '';
  const acu = d.acuConsumed != null ? `<div class="chip">ACU: <b>${d.acuConsumed}</b>${d.acuLimit ? ' / ' + d.acuLimit : ''}</div>` : '';

  const body = d.kind === 'no-auth'
    ? `<div class="empty">Not signed in.<br><button onclick="signin()">Sign in to Devin</button></div>`
    : d.kind === 'error'
      ? `<div class="empty">Couldn't load usage (${d.detail || 'error'}).<br><button onclick="refresh()">Retry</button></div>`
      : `${bars.join('')}${overHtml}<div class="chips">${credits}${acu}</div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { font-family: var(--vscode-font-family); margin: 0; padding: 18px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .head { display:flex; align-items:baseline; gap:10px; margin-bottom:16px; }
    .head h1 { font-size: 15px; font-weight: 600; margin: 0; }
    .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .sub { font-size: 11px; opacity: .6; margin-left: auto; }
    .row { background: var(--vscode-editorWidget-background, rgba(127,127,127,.07)); border: 1px solid var(--vscode-widget-border, rgba(127,127,127,.18)); border-radius: 12px; padding: 12px 14px; margin-bottom: 12px; }
    .row-head { display:flex; justify-content:space-between; font-size: 12.5px; font-weight: 600; margin-bottom: 8px; }
    .pct { font-variant-numeric: tabular-nums; }
    .bar { height: 10px; border-radius: 999px; background: var(--vscode-input-background, rgba(127,127,127,.18)); overflow: hidden; }
    .fill { height: 100%; border-radius: 999px; transition: width .5s ease; }
    .fill.ok { background: linear-gradient(90deg,#4f9cf9,#6ee7c8); }
    .fill.warn { background: linear-gradient(90deg,#f6b756,#f78c6c); }
    .fill.crit { background: linear-gradient(90deg,#f76c6c,#e5534b); }
    .row-foot { display:flex; justify-content:space-between; font-size: 11px; margin-top: 6px; }
    .dim { opacity: .55; }
    .money { font-variant-numeric: tabular-nums; font-weight: 700; }
    .over-neg .money { color: var(--vscode-errorForeground,#e5534b); }
    .chips { display:flex; gap:8px; flex-wrap:wrap; }
    .chip { font-size: 11px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--vscode-widget-border, rgba(127,127,127,.2)); }
    .empty { text-align:center; padding: 40px 0; opacity:.75; line-height:2; }
    button { font: inherit; font-size:12px; padding:6px 14px; border-radius:8px; border:1px solid var(--vscode-widget-border,rgba(127,127,127,.3)); background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor:pointer; }
    .foot { display:flex; justify-content:space-between; align-items:center; margin-top:8px; font-size:11px; }
    .foot button { background: transparent; color: var(--vscode-foreground); padding:4px 10px; }
    </style></head><body>
    <div class="head">
      <h1>Devin Usage</h1>
      ${d.kind === 'ok' ? `<span class="badge">${d.planName}</span>` : ''}
      <span class="sub">${d.account || ''}${d.account && d.email ? ' · ' : ''}${d.email || ''}</span>
    </div>
    ${body}
    <div class="foot">
      <span class="dim">${lastFetchedAt ? 'updated ' + new Date(lastFetchedAt).toLocaleTimeString() : ''}</span>
      <button onclick="refresh()">Refresh</button>
    </div>
    <script>
      const vscode = acquireVsCodeApi();
      function refresh(){ vscode.postMessage({type:'refresh'}) }
      function signin(){ vscode.postMessage({type:'signin'}) }
      setInterval(()=>refresh(), 60000);
    </script></body></html>`;
}

function showDashboard(context) {
  if (panel) { panel.reveal(); renderPanel(); return; }
  panel = vscode.window.createWebviewPanel('devinUsage', 'Devin Usage', vscode.ViewColumn.Beside, { enableScripts: true });
  panel.onDidDispose(() => { panel = undefined; });
  panel.webview.onDidReceiveMessage(async m => {
    if (m.type === 'refresh') await refresh(context, true);
    if (m.type === 'signin') await signIn(context);
  });
  renderPanel();
  refresh(context);
}

function renderPanel() {
  if (!panel) return;
  const d = lastData || { kind: lastError ? 'error' : 'no-auth', detail: lastError };
  panel.webview.html = html(d);
}

async function refresh(context, force) {
  if (refreshing) return;
  if (!force && Date.now() - lastFetchedAt < REFRESH_MS) return;
  refreshing = true;
  try {
    lastData = await fetchUsage(context);
    lastError = lastData.kind === 'error' ? lastData.detail : null;
    if (lastData.kind === 'ok') lastFetchedAt = Date.now();
  } catch (e) {
    lastData = { kind: 'error', detail: String(e) };
    lastError = String(e);
  } finally {
    refreshing = false;
    updateStatusBar(context);
    renderPanel();
  }
}

function activate(context) {
  out = vscode.window.createOutputChannel('Devin Usage');
  context.subscriptions.push(out);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusBar.text = '$(zap) Devin';
  context.subscriptions.push(statusBar);

  context.subscriptions.push(vscode.commands.registerCommand('devinUsage.signIn', () => signIn(context)));
  context.subscriptions.push(vscode.commands.registerCommand('devinUsage.refresh', () => refresh(context, true)));
  context.subscriptions.push(vscode.commands.registerCommand('devinUsage.showDashboard', () => showDashboard(context)));
  context.subscriptions.push(vscode.commands.registerCommand('devinUsage.probe', () => probe(context)));

  timer = setInterval(() => refresh(context), REFRESH_MS);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  refresh(context);
}

async function probe(context) {
  out.show(true);
  log('probe:', JSON.stringify(lastData));
}

function deactivate() { if (timer) clearInterval(timer); }

module.exports = { activate, deactivate };
