/* ============================================================================
 * Equipment Lending Library - RVCE, college-wide lab equipment desk.
 * Engineering - LIVE single-page application.
 *
 * Dependency-free vanilla JS (no build step, no external libraries).
 * Served by the live backend from the same origin, so every API call uses a
 * relative path such as fetch('/api/catalog') with the session bearer token
 * in the Authorization header.
 *
 * Sections:
 *   1. constants & state
 *   2. tiny DOM helpers (hyperscript-style h())
 *   3. formatting helpers
 *   4. API layer & session storage
 *   5. toasts, modal dialogs & shared fragments
 *   6. application shell: top bar, tab bar, hash router
 *   7. auth views: login, register, settings
 *   8. student views: holdings, history, catalog, requests
 *   9. faculty views: dashboard, requests, reservations, loans, students,
 *      queue, equipment, maintenance, reports
 *  10. live availability feed (SSE) - silently refreshes the current view
 *  11. boot
 *
 * Notes:
 *   * No innerHTML is used anywhere - user data is only ever written with
 *     textContent / createTextNode (XSS-safe by construction).
 *   * Any 401 (other than failed login/register/password checks) clears the
 *     stored session and returns to the login screen.
 * ==========================================================================*/
'use strict';

(function () {
  /* ========================================================================
   * 1. constants & state
   * ======================================================================*/

  const SESSION_KEY = 'rvce.ell.session';       // {token, user} in localStorage
  const CAL_DAYS = 14;                          // availability calendar window
  const QUEUE_REFRESH_MS = 15000;               // queue auto-refresh cadence
  const LIVE_REFRESH_MS = 2500;                 // SSE refresh debounce
  const USN_RE = /^1RV\d{2}[A-Z]{2}\d{3}$/;     // 1RV24IS057
  const STUDENT_EMAIL_RE = /^([a-z0-9]+)\.([a-z]{2})(\d{2})@rvce\.edu\.in$/i;  // karthikanupr.is24@rvce.edu.in

  /* status → badge tone (used by every status chip in the app) */
  const TONES = {
    PENDING: 'amber', APPROVED: 'green', REJECTED: 'red', CANCELLED: 'gray',
    FULFILLED: 'blue', EXPIRED: 'gray',
    WAITING: 'gray', OFFERED: 'amber', SKIPPED: 'red',
    ACTIVE: 'green', OVERDUE: 'red', RETURNED: 'blue', LOST: 'dark',
    AVAILABLE: 'green', ON_LOAN: 'amber', MAINTENANCE: 'gray', RETIRED: 'gray',
    HELD: 'blue', DONE: 'green',
    NEW: 'green', GOOD: 'blue', FAIR: 'amber', DAMAGED: 'red',
    LOAN: 'amber', RESERVATION: 'blue',
  };

  /* hash routes: path → { view(main, route), role, public, title } */
  const ROUTES = {
    '/login':               { view: viewLogin,            public: true, title: 'Sign in' },
    '/register':            { view: viewRegister,         public: true, title: 'Student registration' },
    '/settings':            { view: viewSettings,         role: 'ANY', title: 'Settings' },
    '/student/holdings':    { view: viewHoldings,         role: 'STUDENT', title: 'My current holdings' },
    '/student/catalog':     { view: viewCatalog,          role: 'STUDENT', title: 'Equipment catalog' },
    '/student/requests':    { view: viewMyRequests,       role: 'STUDENT', title: 'My requests' },
    '/student/history':     { view: viewHistory,          role: 'STUDENT', title: 'My loan history' },
    '/faculty/dashboard':   { view: viewDashboard,        role: 'FACULTY', title: 'Dashboard' },
    '/faculty/requests':    { view: viewFacultyRequests,  role: 'FACULTY', title: 'Lending requests' },
    '/faculty/reservations':{ view: viewReservations,     role: 'FACULTY', title: 'Reservations' },
    '/faculty/loans':       { view: viewLoans,            role: 'FACULTY', title: 'Loans' },
    '/faculty/students':    { view: viewStudents,         role: 'FACULTY', title: 'Students' },
    '/faculty/queue':       { view: viewQueue,            role: 'FACULTY', title: 'Fair hold queue' },
    '/faculty/equipment':   { view: viewEquipment,        role: 'FACULTY', title: 'Equipment management' },
    '/faculty/maintenance': { view: viewMaintenance,      role: 'FACULTY', title: 'Maintenance blocks' },
    '/faculty/reports':     { view: viewReports,          role: 'FACULTY', title: 'Reports' },
    '/faculty/console':     { view: viewConsole,          role: 'FACULTY', title: 'SQL console' },
    '/admin/users':         { view: viewAdminUsers,       role: 'ADMIN',   title: 'Accounts & roles' },
  };

  /* routes that benefit from an SSE-triggered silent refresh */
  const LIVE_ROUTES = new Set([
    '/student/holdings', '/student/catalog', '/student/requests',
    '/faculty/dashboard', '/faculty/requests', '/faculty/reservations',
    '/faculty/loans', '/faculty/equipment', '/faculty/maintenance',
    '/faculty/reports',
  ]);

  /* application state (session identity comes from localStorage + /auth/me) */
  const state = {
    token: null,
    user: null,
    route: { path: '/login', parts: [] },
    cleanups: [],       // per-route cleanup callbacks (timers, listeners)
    modal: null,        // currently open modal backdrop element
    sse: null,          // EventSource for /api/events (may stay null)
  };

  /* small caches for slowly-changing lookups */
  const cache = { labs: null, categories: null };

  /* persistent loan-table preferences (also set by dashboard cards) */
  const loanPrefs = { status: 'active', labId: null, search: '', returnOnly: false };

  /* ========================================================================
   * 2. tiny DOM helpers - hyperscript-style h()
   * ======================================================================*/

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach((key) => {
        const val = props[key];
        if (val === null || val === undefined || val === false) return;
        if (key === 'class') el.className = val;
        else if (key === 'dataset') { Object.keys(val).forEach((dk) => { el.dataset[dk] = val[dk]; }); }
        else if (key === 'style' && typeof val === 'object') Object.assign(el.style, val);
        else if (key.startsWith('on') && typeof val === 'function') el.addEventListener(key.slice(2).toLowerCase(), val);
        else if (key === 'value') el.value = val;
        else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'hidden') el[key] = val;
        else if (val === true) el.setAttribute(key, '');
        else el.setAttribute(key, val);
      });
    }
    appendChildren(el, children);
    return el;
  }

  function appendChildren(el, children) {
    children.forEach((child) => {
      if (child === null || child === undefined || child === false) return;
      if (Array.isArray(child)) { appendChildren(el, child); return; }
      if (child && child.nodeType) el.appendChild(child);
      else el.appendChild(document.createTextNode(String(child)));
    });
  }

  /* ========================================================================
   * 3. formatting helpers
   * ======================================================================*/

  function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  /* first defined key of obj - keeps the UI tolerant of small API renames */
  function pick(obj) {
    if (!obj) return undefined;
    for (let i = 1; i < arguments.length; i += 1) {
      const key = arguments[i];
      const val = obj[key];
      if (val !== undefined && val !== null) return val;
    }
    return undefined;
  }

  function money(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '-';
    return '\u20b9' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtDate(value) {
    if (value === null || value === undefined || value === '') return '-';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '-' : d.toDateString('en-IN');
  }

  function fmtTime(value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  }

  function fmtDateTime(value) {
    if (value === null || value === undefined || value === '') return '-';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '-' : d.toDateString('en-IN') + ', ' + fmtTime(d);
  }

  /* Date → value for <input type="datetime-local"> in local time */
  function toLocalInputValue(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function fmtNum(value, digits) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(digits === undefined ? 1 : digits) : '-';
  }

  function pctText(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n + '%' : '-';
  }

  function countdownText(expiresIso) {
    if (!expiresIso) return '-';
    const ms = new Date(expiresIso).getTime() - Date.now();
    if (Number.isNaN(ms)) return '-';
    if (ms <= 0) return 'expired';
    const total = Math.floor(ms / 1000);
    const d = Math.floor(total / 86400);
    const hh = Math.floor((total % 86400) / 3600);
    const mm = Math.floor((total % 3600) / 60);
    const ss = total % 60;
    if (d > 0) return d + 'd ' + hh + 'h';
    if (hh > 0) return hh + 'h ' + mm + 'm';
    if (mm > 0) return mm + 'm ' + ss + 's';
    return ss + 's';
  }

  function humanRole(role) {
    const r = String(role || '').toUpperCase();
    if (r === 'FACULTY') return 'Faculty';
    if (r === 'STUDENT') return 'Student';
    if (r === 'ADMIN') return 'Administrator';
    return role ? String(role) : 'User';
  }

  function displayName(user) {
    if (!user) return 'Account';
    return user.full_name || user.name || user.email || 'Account';
  }

  /* ========================================================================
   * 4. API layer & session storage
   * ======================================================================*/

  function ApiError(status, code, message) {
    const err = new Error(message || code || 'Request failed');
    err.status = status;
    err.code = code;
    return err;
  }

  function errMessage(err) {
    if (!err) return 'Something went wrong.';
    if (err.code && err.message && err.message !== err.code) return err.code + ': ' + err.message;
    return err.message || err.code || 'Something went wrong.';
  }

  function isAuthEndpoint(path) {
    return path.indexOf('/api/auth/login') === 0
      || path.indexOf('/api/auth/register') === 0
      || path.indexOf('/api/auth/password') === 0
      || path.indexOf('/api/auth/logout') === 0;
  }

  const api = {
    async request(method, path, body) {
      const headers = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (state.token) headers.Authorization = 'Bearer ' + state.token;

      let res;
      try {
        res = await fetch(path, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (netErr) {
        throw ApiError(0, 'NETWORK', 'Could not reach the server - is the backend running?');
      }

      let data = null;
      const text = await res.text().catch(() => '');
      if (text) {
        try { data = JSON.parse(text); } catch (parseErr) { data = null; }
      }

      if (!res.ok) {
        const err = ApiError(res.status, (data && data.error) || ('HTTP_' + res.status), (data && data.message) || res.statusText);
        // any 401 outside the auth screens means the session expired
        if (res.status === 401 && !isAuthEndpoint(path)) handleSessionExpired();
        throw err;
      }
      return data;
    },
    get(path) { return api.request('GET', path); },
    post(path, body) { return api.request('POST', path, body === undefined ? {} : body); },
    del(path) { return api.request('DELETE', path); },
  };

  function handleSessionExpired() {
    if (!state.token) return;
    clearSession();
    toast('Session expired - please sign in again.', 'warn');
    if (state.route.path !== '/login') go('/login', { replace: true });
  }

  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.token === 'string' && parsed.token) {
        state.token = parsed.token;
        state.user = parsed.user || null;
      }
    } catch (err) { /* corrupted storage - start signed out */ }
  }

  function persistSession() {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ token: state.token, user: state.user }));
    } catch (err) { /* storage full / disabled - session stays in memory */ }
  }

  function saveSession(token, user) {
    state.token = token;
    state.user = user || null;
    persistSession();
  }

  function clearSession() {
    state.token = null;
    state.user = null;
    try { localStorage.removeItem(SESSION_KEY); } catch (err) { /* ignore */ }
  }

  function homeFor(user) {
    const role = String((user && user.role) || '').toUpperCase();
    if (role === 'FACULTY' || role === 'ADMIN') return '/faculty/dashboard';
    if (role === 'STUDENT') return '/student/holdings';
    return '/login';
  }

  async function getLabs() {
    if (!cache.labs) cache.labs = await api.get('/api/labs');
    return cache.labs;
  }

  /* ========================================================================
   * 5. toasts, modal dialogs & shared fragments
   * ======================================================================*/

  function toast(message, kind) {
    const host = document.getElementById('toasts');
    if (!host) return;
    const el = h('div', { class: 'toast toast-' + (kind || 'info'), role: 'status' }, message);
    host.appendChild(el);
    window.setTimeout(() => { el.classList.add('toast-out'); }, 4200);
    window.setTimeout(() => { el.remove(); }, 4600);
    while (host.children.length > 5) host.firstChild.remove();
  }

  function toastError(err) { toast(errMessage(err), 'error'); }

  function safely(promise) {
    if (promise && typeof promise.catch === 'function') promise.catch((err) => toastError(err));
    return promise;
  }

  function openModal(options) {
    closeModal();
    const box = h('div', { class: 'modal' + (options.wide ? ' modal-wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': options.title || 'Dialog' },
      h('div', { class: 'modal-head' },
        h('h2', { class: 'modal-title' }, options.title || ''),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close dialog', onclick: closeModal }, '\u00d7')),
      h('div', { class: 'modal-body' }, options.body || []),
      options.footer ? h('div', { class: 'modal-foot' }, options.footer) : null);
    const backdrop = h('div', { class: 'modal-backdrop', onclick: (ev) => { if (ev.target === backdrop) closeModal(); } }, box);
    document.body.appendChild(backdrop);
    document.body.classList.add('modal-open');
    state.modal = backdrop;
    const focusTarget = box.querySelector('input, select, textarea, button');
    if (focusTarget) window.setTimeout(() => focusTarget.focus(), 40);
    return box;
  }

  function closeModal() {
    if (!state.modal) return;
    state.modal.remove();
    state.modal = null;
    document.body.classList.remove('modal-open');
  }

  function confirmDialog(opts) {
    return new Promise((resolve) => {
      const finish = (value) => { closeModal(); resolve(value); };
      openModal({
        title: opts.title || 'Please confirm',
        body: h('p', { class: 'confirm-text' }, opts.message || ''),
        footer: [
          h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => finish(false) }, 'Cancel'),
          h('button', { class: 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary'), type: 'button', onclick: () => finish(true) }, opts.confirmLabel || 'Confirm'),
        ],
      });
    });
  }

  /* wraps a click handler: disables the button while the async work runs */
  function runFormAction(button, busyLabel, fn) {
    return (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      (async () => {
        if (button.disabled) return;
        const original = button.textContent;
        button.disabled = true;
        button.classList.add('is-busy');
        button.textContent = busyLabel || 'Working…';
        try {
          await fn();
        } catch (err) {
          toastError(err);
        } finally {
          button.disabled = false;
          button.classList.remove('is-busy');
          button.textContent = original;
        }
      })();
    };
  }

  function actionButton(label, className, fn) {
    const btn = h('button', { class: 'btn ' + (className || 'btn-secondary'), type: 'button' }, label);
    btn.addEventListener('click', runFormAction(btn, 'Working…', fn));
    return btn;
  }

  function showError(box, message) { box.textContent = message; box.hidden = false; }
  function hideError(box) { box.textContent = ''; box.hidden = true; }

  function chip(label, tone, title) {
    return h('span', { class: 'chip chip-' + (tone || 'gray'), title: title || null }, label);
  }

  function toneFor(status) {
    return TONES[String(status || '').toUpperCase()] || 'gray';
  }

  function statusChip(status) {
    const s = status === null || status === undefined || status === '' ? '-' : String(status);
    return chip(s, toneFor(status));
  }

  function chipLine(bits) {
    return h('div', { class: 'chip-line' }, bits.filter(Boolean));
  }

  function roleBadge(role) {
    return h('span', { class: 'role-badge role-' + String(role || '').toLowerCase() }, humanRole(role));
  }

  function field(labelText, control, hint) {
    return h('div', { class: 'field' },
      h('label', { class: 'field-label', for: control.id }, labelText),
      control,
      hint ? h('p', { class: 'field-hint' }, hint) : null);
  }

  function defList(pairs) {
    return h('dl', { class: 'def-list' }, pairs.filter(Boolean).map((pair) => [
      h('dt', {}, pair[0]),
      h('dd', {}, pair[1]),
    ]));
  }

  function panel(title, subtitle, actions, body) {
    return h('section', { class: 'panel' },
      h('div', { class: 'panel-head' },
        h('div', {},
          h('h2', { class: 'panel-title' }, title),
          subtitle ? h('p', { class: 'panel-sub' }, subtitle) : null),
        actions ? h('div', { class: 'panel-actions' }, actions) : null),
      h('div', { class: 'panel-body' }, body));
  }

  function loadingBlock(text) {
    return h('div', { class: 'state state-loading' },
      h('span', { class: 'spinner', 'aria-hidden': 'true' }),
      h('span', {}, text || 'Loading…'));
  }

  function emptyBlock(title, hint) {
    return h('div', { class: 'state state-empty' },
      h('p', { class: 'state-title' }, title),
      hint ? h('p', { class: 'state-hint' }, hint) : null);
  }

  function errorBlock(err) {
    return h('div', { class: 'state state-error', role: 'alert' },
      h('p', { class: 'state-title' }, 'Could not load this section'),
      h('p', { class: 'state-hint' }, errMessage(err)),
      h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => render() }, 'Retry'));
  }

  /* render a loading state, then the loader's node - or an error panel */
  function withLoad(main, loader) {
    main.replaceChildren(loadingBlock());
    return Promise.resolve()
      .then(loader)
      .then((node) => { main.replaceChildren(node || emptyBlock('Nothing to show yet.')); return node; })
      .catch((err) => { main.replaceChildren(errorBlock(err)); return null; });
  }

  function dataTable(headers, rows) {
    return h('div', { class: 'table-wrap' },
      h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, headers.map((label) => h('th', { scope: 'col' }, label)))),
        h('tbody', {}, rows.map((row) => {
          const cells = Array.isArray(row) ? row : row.cells;
          const props = Array.isArray(row) ? {} : { class: row.class || null };
          return h('tr', props, cells.map(toCell));
        }))));
  }

  function toCell(child) {
    if (child && child.tagName === 'TD') return child;
    if (child === null || child === undefined || child === false) return h('td', { class: 'muted' }, '-');
    return h('td', {}, child);
  }

  function utilizationBar(value) {
    const v = Math.max(0, Math.min(100, num(value)));
    return h('div', { class: 'ubar', title: pctText(value) },
      h('div', { class: 'ubar-fill', style: { width: v + '%' } }));
  }

  function statCard(label, value, tone, onClick) {
    return h('button', { class: 'stat-card' + (tone ? ' stat-' + tone : ''), type: 'button', onclick: onClick || null },
      h('span', { class: 'stat-value' }, value === undefined || value === null ? '-' : String(value)),
      h('span', { class: 'stat-label' }, label));
  }

  /* ========================================================================
   * 6. application shell: top bar, tab bar, hash router
   * ======================================================================*/

  function topbar() {
    const right = h('div', { class: 'topbar-right' });
    right.appendChild(h('span', { class: 'logo-chip' },
      h('img', { src: '/rvce-logo.png', alt: 'RVCE logo', height: 38 })));
    if (state.token && state.user) {
      const user = state.user;
      right.appendChild(h('div', { class: 'user-block' },
        h('span', { class: 'user-name' }, displayName(user)),
        roleBadge(user.role)));
      right.appendChild(h('button', { class: 'btn btn-ghost-light btn-sm', type: 'button', onclick: doLogout }, 'Logout'));
    }
    return h('header', { class: 'topbar' },
      h('div', { class: 'topbar-inner' },
        h('div', { class: 'brand' },
          h('span', { class: 'brand-block' }, 'RVCE'),
          h('span', { class: 'brand-dot', 'aria-hidden': 'true' }, '\u00b7'),
          h('div', { class: 'brand-text' },
            h('h1', { class: 'brand-title' }, 'Equipment Lending Library'),
            h('p', { class: 'brand-sub' }, 'RV College of Engineering - Lab Equipment Desk'))),
        right));
  }

  function tabbar() {
    const user = state.user;
    const items = user.role === 'STUDENT'
      ? [['/student/holdings', 'Holdings'], ['/student/catalog', 'Catalog'], ['/student/requests', 'Requests'], ['/student/history', 'History'], ['/settings', 'Settings']]
      : [
          ['/faculty/dashboard', 'Dashboard'],
          ['/faculty/requests', 'Requests'],
          ['/faculty/reservations', 'Reservations'],
          ['/faculty/loans', 'Loans'],
          ['/faculty/students', 'Students'],
          ['/faculty/queue', 'Queue'],
          ['/faculty/equipment', 'Equipment'],
          ['/faculty/maintenance', 'Maintenance'],
          ['/faculty/reports', 'Reports'],
          ['/faculty/console', 'SQL Console'],
        ].concat(user.role === 'ADMIN' ? [['/admin/users', 'Admin']] : [])
         .concat([['/settings', 'Settings']]);
    const path = state.route.path;
    return h('nav', { class: 'tabbar', 'aria-label': 'Sections' },
      h('div', { class: 'tabbar-inner' },
        items.map(([href, label]) => h('a', {
          class: 'tab' + (path === href ? ' tab-active' : ''),
          href: '#' + href,
          'aria-current': path === href ? 'page' : null,
        }, label))));
  }

  function currentRoute() {
    const raw = String(location.hash || '').replace(/^#/, '');
    const parts = raw.split('/').filter((p) => p.length > 0);
    return { path: parts.length ? '/' + parts.join('/') : '/login', parts };
  }

  function go(path, options) {
    const opts = options || {};
    const target = '#' + path;
    if (location.hash === target) { render(); return; }
    if (opts.replace) location.replace(target);
    else location.hash = target;
  }

  function registerCleanup(fn) { state.cleanups.push(fn); }

  function runCleanups() {
    state.cleanups.splice(0).forEach((fn) => {
      try { fn(); } catch (err) { /* cleanup must never break navigation */ }
    });
  }

  function render() {
    runCleanups();
    closeModal();

    const route = currentRoute();
    const def = ROUTES[route.path];

    if (!state.token || !state.user) {
      if (!def || !def.public) { go('/login', { replace: true }); return; }
    } else {
      if (!def || def.public) { go(homeFor(state.user), { replace: true }); return; }
      const roleOk = !def.role || def.role === 'ANY' || def.role === state.user.role
        || (def.role === 'FACULTY' && state.user.role === 'ADMIN');
      if (!roleOk) { go(homeFor(state.user), { replace: true }); return; }
    }

    state.route = route;
    document.title = (def.title ? def.title + ' - ' : '') + 'Equipment Lending Library - RVCE ISE';

    const app = document.getElementById('app');
    app.replaceChildren();
    app.appendChild(topbar());
    if (state.token && state.user) app.appendChild(tabbar());

    const main = h('main', { class: 'content', id: 'main' });
    app.appendChild(main);

    try { def.view(main, route); }
    catch (err) { main.replaceChildren(errorBlock(err)); }

    window.scrollTo(0, 0);
  }

  function doLogout() {
    const finish = () => {
      clearSession();
      toast('Signed out.', 'info');
      go('/login', { replace: true });
    };
    if (state.token) safely(api.post('/api/auth/logout').then(finish).catch(finish));
    else finish();
  }

  /* ========================================================================
   * 7. auth views: login, register, settings
   * ======================================================================*/

  function viewLogin(main) {
    const email = h('input', { id: 'login-email', class: 'input', type: 'email', required: true, autocomplete: 'email', placeholder: 'you@rvce.edu.in', spellcheck: 'false' });
    const password = h('input', { id: 'login-password', class: 'input', type: 'password', required: true, autocomplete: 'current-password' });
    const errorBox = h('div', { class: 'form-error', id: 'login-error', role: 'alert', hidden: true });
    const submit = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Sign in');

    const form = h('form', {
      class: 'card auth-card',
      novalidate: true,
      onsubmit: runFormAction(submit, 'Signing in…', async () => {
        hideError(errorBox);
        const mail = email.value.trim().toLowerCase();
        const pw = password.value;
        if (!mail || !pw) {
          showError(errorBox, 'Enter your email and password.');
          (mail ? password : email).focus();
          return;
        }
        let data;
        try {
          data = await api.post('/api/auth/login', { email: mail, password: pw });
        } catch (err) {
          showError(errorBox, err.status === 401 ? 'Invalid email or password.' : errMessage(err));
          return;
        }
        saveSession(data.token, data.user);
        toast('Welcome, ' + displayName(data.user) + '.', 'success');
        go(homeFor(data.user), { replace: true });
      }),
    },
      h('h2', { class: 'auth-title' }, 'Sign in'),
      h('p', { class: 'auth-sub' }, 'Use your RVCE account to use the college equipment desk.'),
      field('Email', email),
      field('Password', password),
      errorBox,
      submit,
      h('p', { class: 'auth-alt' }, 'New student? ', h('a', { href: '#/register' }, 'Register')));

    main.appendChild(h('div', { class: 'auth-wrap' }, form));
  }

  function viewRegister(main) {
    const name = h('input', { id: 'reg-name', class: 'input', type: 'text', required: true, autocomplete: 'name', placeholder: 'As on your college records' });
    const usn = h('input', { id: 'reg-usn', class: 'input', type: 'text', required: true, autocomplete: 'username', placeholder: '1RV24IS057', spellcheck: 'false' });
    const email = h('input', { id: 'reg-email', class: 'input', type: 'email', required: true, autocomplete: 'email', placeholder: 'karthikanupr.is24@rvce.edu.in', spellcheck: 'false' });
    const dept = h('select', { id: 'reg-dept', class: 'input', required: true, disabled: true });
    const deptHint = h('p', { class: 'field-hint' }, 'Loading departments…');
    const password = h('input', { id: 'reg-password', class: 'input', type: 'password', required: true, autocomplete: 'new-password', placeholder: 'At least 8 characters' });
    const confirm = h('input', { id: 'reg-confirm', class: 'input', type: 'password', required: true, autocomplete: 'new-password' });
    const errorBox = h('div', { class: 'form-error', id: 'register-error', role: 'alert', hidden: true });
    const submit = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Create account');
    const controls = [name, usn, email, dept, password, confirm];
    let deptList = [];

    dept.appendChild(h('option', { value: '' }, 'Loading…'));
    api.get('/api/departments').then((list) => {
      deptList = (Array.isArray(list) ? list : []).slice()
        .sort((a, b) => String(a.dept_name).localeCompare(String(b.dept_name)));
      if (!deptList.length) throw ApiError(404, 'NO_DEPARTMENTS', 'No departments found.');
      dept.replaceChildren(...deptList.map((d) => h('option', { value: d.dept_id },
        d.dept_name + (d.branch_code ? ' (' + d.branch_code + ')' : ''))));
      dept.disabled = false;
      deptHint.textContent = 'Pick the department printed on your USN; the email branch code follows it.';
    }).catch((err) => {
      dept.replaceChildren(h('option', { value: '' }, 'Departments unavailable'));
      deptHint.textContent = 'Could not load departments: ' + errMessage(err);
    });

    const form = h('form', {
      class: 'card auth-card auth-card-wide',
      novalidate: true,
      onsubmit: runFormAction(submit, 'Creating…', async () => {
        hideError(errorBox);
        controls.forEach((c) => { c.classList.remove('input-invalid'); c.removeAttribute('aria-invalid'); });

        const fullName = name.value.trim();
        const usnVal = usn.value.trim().toUpperCase();
        const mail = email.value.trim().toLowerCase();
        const pw = password.value;

        const selectedDept = deptList.find((d) => String(d.dept_id) === String(dept.value));
        const branch = selectedDept ? String(selectedDept.branch_code || '').toLowerCase() : '';
        const usnBranch = usnVal.slice(5, 7).toLowerCase();
        const batch = usnVal.slice(3, 5);
        const mailMatch = STUDENT_EMAIL_RE.exec(mail);
        const emailOk = !!mailMatch && !!branch
          && mailMatch[2].toLowerCase() === branch
          && mailMatch[3] === batch;
        const branchOk = !!branch && USN_RE.test(usnVal) && usnBranch === branch;

        const checks = [
          { control: name, ok: fullName.length >= 2, message: 'Enter your full name.' },
          { control: usn, ok: USN_RE.test(usnVal), message: 'USN must look like 1RV24IS057.' },
          { control: dept, ok: !!selectedDept && !!branch, message: 'Choose your department.' },
          { control: usn, ok: branchOk, message: 'The USN branch does not match the selected department.' },
          { control: email, ok: emailOk, message: 'Use fullname.<branch><YY>@rvce.edu.in (no dots), matching your USN branch and batch.' },
          { control: password, ok: pw.length >= 8, message: 'Password must be at least 8 characters.' },
          { control: confirm, ok: confirm.value === pw && pw.length > 0, message: 'Passwords do not match.' },
        ];
        const firstBad = checks.find((c) => !c.ok);
        if (firstBad) {
          showError(errorBox, firstBad.message);
          firstBad.control.classList.add('input-invalid');
          firstBad.control.setAttribute('aria-invalid', 'true');
          firstBad.control.focus();
          return;
        }

        let data;
        try {
          data = await api.post('/api/auth/register', {
            full_name: fullName,
            usn: usnVal,
            email: mail,
            dept_id: Number(dept.value),
            password: pw,
            confirm_password: confirm.value,
          });
        } catch (err) {
          showError(errorBox, errMessage(err));
          return;
        }
        saveSession(data.token, data.user);
        toast('Account created - welcome, ' + displayName(data.user) + '.', 'success');
        go(homeFor(data.user), { replace: true });
      }),
    },
      h('h2', { class: 'auth-title' }, 'Create your student account'),
      h('p', { class: 'auth-sub' }, 'Open to students of every RVCE engineering department. Use your college email fullname.<branch><YY>@rvce.edu.in (no dots) - this is the only way student accounts are created.'),
      field('Full name', name),
      field('USN', usn, 'Format: 1RV24IS057'),
      field('College email', email, 'fullname.<branch><YY>@rvce.edu.in (no dots; branch and batch follow your USN)'),
      field('Department', dept),
      deptHint,
      field('Password', password, 'At least 8 characters'),
      field('Confirm password', confirm),
      errorBox,
      submit,
      h('p', { class: 'auth-alt' }, 'Already have an account? ', h('a', { href: '#/login' }, 'Sign in')));

    main.appendChild(h('div', { class: 'auth-wrap' }, form));
  }

  function viewSettings(main) {
    const user = state.user || {};
    const infoPairs = [
      ['Full name', displayName(user)],
      ['Email', user.email || '-'],
      ['Role', roleBadge(user.role)],
    ];
    if (user.usn || user.student_id) infoPairs.push(['USN', user.usn || user.student_id]);
    if (user.staff_id) infoPairs.push(['Staff id', String(user.staff_id)]);
    if (user.dept_name) infoPairs.push(['Department', user.dept_name]);
    if (user.created_at) infoPairs.push(['Member since', fmtDate(user.created_at)]);

    const infoCard = h('section', { class: 'card' },
      h('h3', { class: 'card-title' }, 'Account'),
      defList(infoPairs));

    const current = h('input', { id: 'pw-current', class: 'input', type: 'password', required: true, autocomplete: 'current-password' });
    const next = h('input', { id: 'pw-new', class: 'input', type: 'password', required: true, autocomplete: 'new-password', placeholder: 'At least 8 characters' });
    const again = h('input', { id: 'pw-confirm', class: 'input', type: 'password', required: true, autocomplete: 'new-password' });
    const errorBox = h('div', { class: 'form-error', role: 'alert', hidden: true });
    const successBox = h('div', { class: 'form-success', role: 'status', hidden: true });
    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Update password');

    const form = h('form', {
      class: 'card',
      novalidate: true,
      onsubmit: runFormAction(submit, 'Updating…', async () => {
        hideError(errorBox);
        successBox.hidden = true;
        if (!current.value) { showError(errorBox, 'Enter your current password.'); current.focus(); return; }
        if (next.value.length < 8) { showError(errorBox, 'New password must be at least 8 characters.'); next.focus(); return; }
        if (next.value !== again.value) { showError(errorBox, 'New passwords do not match.'); again.focus(); return; }
        try {
          await api.post('/api/auth/password', { current_password: current.value, new_password: next.value });
        } catch (err) {
          if (err.status === 401 && err.code !== 'UNAUTHORIZED') { showError(errorBox, 'Current password is incorrect.'); return; }
          if (err.status === 401) { handleSessionExpired(); return; }
          showError(errorBox, errMessage(err));
          return;
        }
        form.reset();
        successBox.textContent = 'Password updated.';
        successBox.hidden = false;
        toast('Password updated.', 'success');
      }),
    },
      h('h3', { class: 'card-title' }, 'Change password'),
      field('Current password', current),
      field('New password', next),
      field('Confirm new password', again),
      errorBox,
      successBox,
      submit);

    main.appendChild(panel('Settings', 'Your account details and password.',
      null,
      h('div', { class: 'settings-grid' }, [infoCard, form])));
  }

  /* ========================================================================
   * 8. student views
   * ======================================================================*/

  function effectiveLoanStatus(row) {
    const s = String((row && row.loan_status) || '').toUpperCase();
    if (!row || row.returned_at) return s || 'RETURNED';
    if (s === 'LOST') return 'LOST';
    if (num(row.days_overdue) > 0 && s === 'ACTIVE') return 'OVERDUE';
    return s || 'ACTIVE';
  }

  /* Shared holdings table for the student area (mode 'student') and the
     faculty student-detail panel (mode 'faculty'). */
  function holdingsTable(rows, reload, mode) {
    if (!rows || rows.length === 0) {
      return emptyBlock('No equipment is on loan right now.',
        mode === 'student' ? 'Browse the catalog and raise a lending request when you need a unit.' : '');
    }
    return dataTable(
      ['Serial no', 'Model', 'Lab', 'Checkout', 'Due', 'Status', 'Fine', 'Days overdue', 'Actions'],
      rows.map((row) => {
        const eff = effectiveLoanStatus(row);
        const statusBits = [chip(eff, toneFor(eff))];
        if (row.return_requested_at) {
          statusBits.push(chip('Return requested', 'blue', row.return_request_note ? 'Note: ' + row.return_request_note : 'Return requested by the student'));
        }
        const actions = [];
        if (mode === 'student') {
          if (row.return_requested_at) {
            actions.push(actionButton('Cancel request', 'btn-ghost btn-sm', async () => {
              const ok = await confirmDialog({
                title: 'Cancel return request',
                message: 'Withdraw your request to return ' + (row.model_name || 'this unit') + ' (' + (row.serial_no || '') + ')?',
                confirmLabel: 'Cancel request',
              });
              if (!ok) return;
              await api.post('/api/me/loans/' + row.loan_id + '/cancel-return');
              toast('Return request cancelled.', 'info');
              await reload();
            }));
          } else {
            actions.push(h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => openReturnRequestModal(row, reload) }, 'Request return'));
          }
        } else {
          if (row.return_requested_at) {
            actions.push(h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openReturnConditionModal(row, reload, true) }, 'Returned'));
          } else if (!row.returned_at) {
            actions.push(h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => openReturnConditionModal(row, reload, false) }, 'Return'));
          }
        }
        return [
          row.serial_no || '-',
          row.model_name || '-',
          row.lab_name || row.lab || '-',
          fmtDate(row.checkout_at),
          fmtDate(row.due_date),
          chipLine(statusBits),
          money(row.fine_amount),
          num(row.days_overdue) > 0 ? h('span', { class: 'late' }, num(row.days_overdue) + ' d') : '-',
          h('div', { class: 'row-actions' }, actions),
        ];
      }));
  }

  function openReturnRequestModal(loan, reload) {
    const note = h('textarea', { id: 'rr-note', class: 'input', rows: 3, placeholder: 'Optional note for the lab desk (e.g. unit is kept ready at the counter)' });
    const submit = h('button', { class: 'btn btn-primary', type: 'button' }, 'Request return');
    submit.addEventListener('click', runFormAction(submit, 'Requesting…', async () => {
      const trimmed = note.value.trim();
      await api.post('/api/me/loans/' + loan.loan_id + '/request-return', trimmed ? { note: trimmed } : {});
      toast('Return requested - the lab desk has been notified.', 'success');
      closeModal();
      await reload();
    }));
    openModal({
      title: 'Request return - ' + (loan.model_name || ''),
      body: [
        h('p', { class: 'muted' }, 'Serial ' + (loan.serial_no || '') + ' · due ' + fmtDate(loan.due_date)),
        field('Note (optional)', note),
      ],
      footer: [
        h('button', { class: 'btn btn-secondary', type: 'button', onclick: closeModal }, 'Cancel'),
        submit,
      ],
    });
  }

  function openReturnConditionModal(loan, reload, wasRequested) {
    const select = h('select', { id: 'return-condition', class: 'input' },
      ['NEW', 'GOOD', 'FAIR', 'DAMAGED'].map((c) => h('option', { value: c, selected: c === 'GOOD' }, c)));
    const submit = h('button', { class: 'btn btn-primary', type: 'button' }, 'Record return');
    submit.addEventListener('click', runFormAction(submit, 'Recording…', async () => {
      const out = await api.post('/api/loans/' + loan.loan_id + '/return', { condition: select.value });
      const fine = num(pick(out || {}, 'fine_amount', 'fine'));
      toast(fine > 0 ? 'Returned - fine ' + money(fine) + ' recorded.' : 'Returned - no fine.', 'success');
      closeModal();
      await reload();
    }));
    openModal({
      title: 'Record return - ' + (loan.model_name || '') + ' (' + (loan.serial_no || '') + ')',
      body: [
        h('p', { class: 'muted' }, wasRequested
          ? 'The student has requested this return - confirm you have physically received the unit.'
          : 'Record the condition of the returned unit.'),
        loan.return_request_note ? h('p', { class: 'note-box' }, 'Student note: ' + loan.return_request_note) : null,
        field('Return condition', select),
      ],
      footer: [
        h('button', { class: 'btn btn-secondary', type: 'button', onclick: closeModal }, 'Cancel'),
        submit,
      ],
    });
  }

  function viewHoldings(main) {
    return withLoad(main, async () => {
      const wrap = h('div', { class: 'stack' });
      async function load() {
        const rows = await api.get('/api/me/loans?scope=current');
        wrap.replaceChildren(panel('My current holdings',
          'Equipment currently issued to you. Request a return when the unit is ready to be handed back at the lab desk.',
          null,
          holdingsTable(rows, load, 'student')));
      }
      await load();
      return wrap;
    });
  }

  function viewHistory(main) {
    return withLoad(main, async () => {
      const rows = await api.get('/api/me/loans?scope=history');
      const body = rows && rows.length
        ? dataTable(['Model', 'Serial no', 'Lab', 'Checkout', 'Returned', 'Condition', 'Fine', 'Status'],
          rows.map((row) => [
            row.model_name || '-',
            row.serial_no || '-',
            row.lab_name || row.lab || '-',
            fmtDate(row.checkout_at),
            fmtDate(row.returned_at),
            row.return_condition ? chip(row.return_condition, toneFor(row.return_condition)) : '-',
            money(row.fine_amount),
            statusChip('RETURNED'),
          ]))
        : emptyBlock('No loans have been returned yet.', 'Your returned equipment will be listed here.');
      return panel('My loan history', 'Loans you have already returned.', null, body);
    });
  }

  function kindTone(kind) {
    const k = String(kind || '').toUpperCase();
    if (k === 'LOAN') return 'amber';
    if (k === 'RESERVATION') return 'blue';
    return 'gray';
  }

  function barClass(kind) {
    const k = String(kind || '').toUpperCase();
    if (k === 'LOAN') return 'cal-loan';
    if (k === 'RESERVATION') return 'cal-res';
    return 'cal-maint';
  }

  function legendItem(label, cls) {
    return h('span', { class: 'legend-item' }, [h('span', { class: 'swatch ' + cls, 'aria-hidden': 'true' }), label]);
  }

  function calendarView(data) {
    const events = (data && data.events) || [];
    const dayMs = 86400000;
    const winStart = new Date();
    winStart.setHours(0, 0, 0, 0);
    const winMs = winStart.getTime();
    const winEnd = winMs + CAL_DAYS * dayMs;

    const sorted = events
      .map((ev) => ({
        kind: ev.kind,
        status: ev.status,
        s: new Date(ev.start_ts).getTime(),
        e: new Date(ev.end_ts).getTime(),
      }))
      .filter((ev) => Number.isFinite(ev.s) && Number.isFinite(ev.e) && ev.e > winMs && ev.s < winEnd)
      .sort((a, b) => a.s - b.s);

    const laneEnds = [];
    const bars = sorted.map((ev) => {
      let lane = laneEnds.findIndex((end) => end <= ev.s);
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
      laneEnds[lane] = ev.e;
      const left = Math.max(0, ((ev.s - winMs) / (winEnd - winMs)) * 100);
      const width = Math.max(0.9, ((Math.min(winEnd, ev.e) - Math.max(winMs, ev.s)) / (winEnd - winMs)) * 100);
      return h('div', {
        class: 'cal-bar ' + barClass(ev.kind),
        style: { left: left + '%', width: width + '%', top: (lane * 22 + 4) + 'px' },
        title: ev.kind + ' · ' + (ev.status || '') + ' · ' + fmtDateTime(ev.s) + ' → ' + fmtDateTime(ev.e),
      }, String(ev.kind || ''));
    });

    const dayLabels = [];
    for (let i = 0; i < CAL_DAYS; i += 1) {
      const d = new Date(winMs + i * dayMs);
      dayLabels.push(h('div', { class: 'cal-day', title: d.toDateString('en-IN') }, [
        h('span', {}, String(d.getDate())),
        h('small', {}, d.toLocaleDateString('en-IN', { month: 'short' })),
      ]));
    }

    const list = sorted.length
      ? h('ul', { class: 'cal-list' }, sorted.map((ev) => h('li', {},
        chip(ev.kind, kindTone(ev.kind)),
        h('span', { class: 'cal-list-dates' }, fmtDateTime(ev.s) + ' → ' + fmtDateTime(ev.e)),
        h('span', { class: 'muted' }, ' · ' + (ev.status || '')))))
      : h('p', { class: 'muted' }, 'Nothing booked in the next ' + CAL_DAYS + ' days - this unit is free.');

    return h('div', { class: 'cal' }, [
      h('div', { class: 'cal-legend' }, [
        legendItem('LOAN', 'cal-loan'),
        legendItem('RESERVATION', 'cal-res'),
        legendItem('MAINTENANCE', 'cal-maint'),
      ]),
      h('div', { class: 'cal-days' }, dayLabels),
      h('div', { class: 'cal-track', style: { height: Math.max(1, laneEnds.length) * 22 + 8 + 'px' } }, bars),
      list,
    ]);
  }

  function openCalendarModal(item) {
    const holder = h('div', { class: 'stack' }, loadingBlock('Loading calendar…'));
    openModal({ title: 'Availability - ' + (item.serial_no || ('item #' + item.item_id)), wide: true, body: holder });
    safely(api.get('/api/items/' + item.item_id + '/calendar?days=' + CAL_DAYS).then((data) => {
      holder.replaceChildren(calendarView(data));
    }).catch((err) => {
      holder.replaceChildren(errorBlock(err));
    }));
  }

  function unitRow(unit) {
    const availability = String(pick(unit, 'availability', 'lifecycle_status') || '-');
    const nextFree = pick(unit, 'next_free_ts');
    const condition = pick(unit, 'item_condition');
    return h('div', { class: 'unit-row' }, [
      h('span', { class: 'unit-serial' }, unit.serial_no || ('#' + unit.item_id)),
      chip(String(condition || '-'), toneFor(condition)),
      chip(availability, toneFor(availability)),
      nextFree && availability !== 'AVAILABLE' ? h('span', { class: 'muted small' }, 'next free ' + fmtDate(nextFree)) : null,
      h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => openCalendarModal(unit) }, 'Calendar'),
    ]);
  }

  function openRequestModal(model) {
    const maxDays = num(pick(model, 'max_loan_days', 'max_days')) || 3;
    const startDefault = new Date();
    startDefault.setDate(startDefault.getDate() + 1);
    startDefault.setHours(9, 0, 0, 0);
    const endDefault = new Date(startDefault.getTime());
    endDefault.setDate(endDefault.getDate() + Math.max(1, Math.min(maxDays, 3)));
    endDefault.setHours(17, 0, 0, 0);

    const purpose = h('textarea', { id: 'req-purpose', class: 'input', rows: 4, maxlength: 1000, placeholder: 'Why do you need this equipment? (at least 10 characters)' });
    const start = h('input', { id: 'req-start', class: 'input', type: 'datetime-local', value: toLocalInputValue(startDefault) });
    const end = h('input', { id: 'req-end', class: 'input', type: 'datetime-local', value: toLocalInputValue(endDefault) });
    const remarks = h('textarea', { id: 'req-remarks', class: 'input', rows: 2, placeholder: 'Optional remarks' });
    const errorBox = h('div', { class: 'form-error', role: 'alert', hidden: true });
    const submit = h('button', { class: 'btn btn-primary', type: 'button' }, 'Submit request');

    submit.addEventListener('click', runFormAction(submit, 'Submitting…', async () => {
      hideError(errorBox);
      const text = purpose.value.trim();
      if (text.length < 10) { showError(errorBox, 'Please describe the purpose in at least 10 characters.'); purpose.focus(); return; }
      if (!start.value || !end.value) { showError(errorBox, 'Choose the requested start and end date/time.'); return; }
      const startMs = new Date(start.value).getTime();
      const endMs = new Date(end.value).getTime();
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
        showError(errorBox, 'The requested end must be after the requested start.');
        return;
      }
      const body = {
        model_id: model.model_id,
        purpose: text,
        requested_start: new Date(startMs).toISOString(),
        requested_end: new Date(endMs).toISOString(),
      };
      if (remarks.value.trim()) body.remarks = remarks.value.trim();
      await api.post('/api/me/requests', body);
      toast('Request submitted - waiting for faculty approval.', 'success');
      closeModal();
    }));

    openModal({
      title: 'Request - ' + (model.model_name || ''),
      body: [
        h('p', { class: 'muted' },
          (model.manufacturer ? model.manufacturer + ' · ' : '')
          + (pick(model, 'category_name', 'category') || '') 
          + ' · max ' + maxDays + ' days · late fee ' + money(pick(model, 'late_fee_per_day', 'late_fee')) + '/day'),
        field('Purpose', purpose, 'Minimum 10 characters - this is shown to the faculty reviewer.'),
        h('div', { class: 'grid-2' }, [
          field('Requested start', start),
          field('Requested end', end),
        ]),
        field('Remarks (optional)', remarks),
        errorBox,
      ],
      footer: [
        h('button', { class: 'btn btn-secondary', type: 'button', onclick: closeModal }, 'Cancel'),
        submit,
      ],
    });
  }

  function modelCard(model) {
    const total = num(pick(model, 'total_items', 'items_total', 'total'));
    const available = num(pick(model, 'available_items', 'available'));
    const onLoan = num(pick(model, 'on_loan_items', 'on_loan'));
    const maintenance = num(pick(model, 'maintenance_items', 'maintenance'));
    const nextFree = pick(model, 'next_free_ts');
    const maxDays = pick(model, 'max_loan_days', 'max_days');
    const fee = pick(model, 'late_fee_per_day', 'late_fee');

    const unitsBox = h('div', { class: 'units-box', hidden: true });
    let unitsLoaded = false;
    const unitsBtn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'View ' + total + ' unit' + (total === 1 ? '' : 's'));

    unitsBtn.addEventListener('click', () => {
      if (!unitsBox.hidden) {
        unitsBox.hidden = true;
        unitsBtn.textContent = 'View ' + total + ' unit' + (total === 1 ? '' : 's');
        return;
      }
      unitsBox.hidden = false;
      unitsBtn.textContent = 'Hide units';
      if (unitsLoaded) return;
      unitsBox.replaceChildren(loadingBlock('Loading units…'));
      safely(api.get('/api/catalog/' + model.model_id + '/items').then((units) => {
        unitsBox.replaceChildren(units && units.length
          ? h('div', { class: 'unit-list' }, units.map(unitRow))
          : emptyBlock('No units are registered for this model.'));
        unitsLoaded = true;
      }).catch((err) => {
        unitsBox.replaceChildren(errorBlock(err));
      }));
    });

    const requestBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Request');
    requestBtn.disabled = total === 0;
    if (total === 0) requestBtn.title = 'No units are registered for this model yet';
    requestBtn.addEventListener('click', () => openRequestModal(model));

    return h('article', { class: 'card model-card' }, [
      h('div', { class: 'model-card-head' }, [
        h('h3', { class: 'model-name' }, model.model_name || '-'),
        h('div', { class: 'model-badges' }, [
          chip(String(pick(model, 'category_name', 'category') || '-'), 'blue'),
          model.dept_name ? chip(model.dept_name, 'gray') : null,
        ]),
      ]),
      h('p', { class: 'model-manufacturer' }, (model.manufacturer || '-') + (model.dept_name ? ' · ' + model.dept_name : '')),
      model.description ? h('p', { class: 'model-desc' }, model.description) : null,
      h('div', { class: 'model-meta' }, [
        h('span', { class: 'model-avail' }, [h('strong', {}, String(available)), ' of ' + total + ' available']),
        onLoan > 0 ? h('span', { class: 'muted small' }, onLoan + ' on loan') : null,
        maintenance > 0 ? h('span', { class: 'muted small' }, maintenance + ' in maintenance') : null,
        h('span', {}, 'Max ' + (maxDays === undefined ? '-' : maxDays) + ' days'),
        h('span', {}, 'Late fee ' + money(fee) + '/day'),
        nextFree ? h('span', { class: 'muted small' }, 'Next free ' + fmtDate(nextFree)) : null,
      ]),
      h('div', { class: 'model-actions' }, [requestBtn, unitsBtn]),
      unitsBox,
    ]);
  }

  function viewCatalog(main) {
    return withLoad(main, async () => {
      let selectedDept = null;
      let modelsCache = [];
      let departments = [];
      const search = h('input', { class: 'input search-input', type: 'search', placeholder: 'Search by model, manufacturer, category or department…', 'aria-label': 'Search the catalog' });
      const chipsRow = h('div', { class: 'chips-row', role: 'group', 'aria-label': 'Filter by department' });
      const listWrap = h('div', { class: 'model-grid' });

      try { departments = await api.get('/api/departments'); } catch (err) { departments = []; }

      function deptChip(label, id) {
        return h('button', {
          class: 'chip-btn' + (selectedDept === id ? ' chip-btn-active' : ''),
          type: 'button',
          'aria-pressed': selectedDept === id ? 'true' : 'false',
          onclick: () => { selectedDept = id; renderChips(); safely(load()); },
        }, label);
      }
      function renderChips() {
        chipsRow.replaceChildren(...[deptChip('All departments', null)]
          .concat(departments.map((d) => deptChip(d.dept_name, d.dept_id))));
      }
      function applyFilter() {
        const q = search.value.trim().toLowerCase();
        const models = modelsCache.filter((m) => !q
          || [m.model_name, m.manufacturer, m.category_name, m.dept_name, m.description]
            .join(' ').toLowerCase().indexOf(q) !== -1);
        listWrap.replaceChildren(...(models.length
          ? models.map(modelCard)
          : [emptyBlock('No models match your search.', 'Try another model, manufacturer, category or department.')]));
      }
      async function load() {
        listWrap.replaceChildren(loadingBlock('Loading catalog…'));
        modelsCache = (await api.get('/api/catalog'
          + (selectedDept === null ? '' : '?dept_id=' + encodeURIComponent(selectedDept)))) || [];
        applyFilter();
      }
      search.addEventListener('input', applyFilter);

      renderChips();
      await load();
      return panel('Equipment catalog', 'Browse college-wide equipment, check live availability and raise a lending request.',
        null,
        h('div', { class: 'stack' }, [h('div', { class: 'toolbar' }, [search]), chipsRow, listWrap]));
    });
  }

  function viewMyRequests(main) {
    return withLoad(main, async () => {
      const rows = await api.get('/api/me/requests');
      const body = rows && rows.length
        ? dataTable(['#', 'Model', 'Purpose', 'Requested window', 'Submitted', 'Status', 'Remarks'],
          rows.map((r) => [
            r.request_id,
            r.model_name || '-',
            h('span', { class: 'purpose-cell', title: r.purpose || '' }, r.purpose || '-'),
            fmtDateTime(r.requested_start) + ' → ' + fmtDateTime(r.requested_end),
            fmtDate(r.submitted_on),
            statusChip(r.request_status),
            r.remarks || '-',
          ]))
        : emptyBlock('You have not raised any requests yet.', 'Open the catalog to request equipment.');
      return panel('My requests', 'Lending requests you have submitted and their approval status.', null, body);
    });
  }

  /* ========================================================================
   * 9. faculty views
   * ======================================================================*/

  function summaryValues(summary) {
    return {
      items: pick(summary, 'items_total', 'items', 'total_items'),
      available: pick(summary, 'available', 'available_items'),
      onLoan: pick(summary, 'on_loan', 'on_loan_items'),
      overdue: pick(summary, 'overdue_loans', 'overdue', 'overdue_count'),
      pending: pick(summary, 'pending_requests', 'pending'),
      queue: pick(summary, 'queue_waiting', 'queue'),
      utilization: pick(summary, 'avg_utilization', 'avg_utilization_pct'),
    };
  }

  function summaryCards(summary, returnRequested) {
    const v = summaryValues(summary || {});
    const goto = (path, prepare) => () => { if (prepare) prepare(); go(path); };
    const cards = [
      statCard('Items', v.items, null, goto('/faculty/equipment')),
      statCard('Available', v.available, 'ok', goto('/faculty/equipment')),
      statCard('On loan', v.onLoan, null, goto('/faculty/loans', () => { loanPrefs.status = 'active'; loanPrefs.returnOnly = false; })),
      statCard('Overdue', v.overdue, 'alert', goto('/faculty/loans', () => { loanPrefs.status = 'overdue'; loanPrefs.returnOnly = false; })),
      statCard('Pending requests', v.pending, 'warn', goto('/faculty/requests')),
      statCard('Queue waiting', v.queue, null, goto('/faculty/queue')),
    ];
    // the dashboard additionally derives a "return requested" count
    if (returnRequested !== undefined) {
      cards.push(statCard('Return requested', returnRequested, 'primary', goto('/faculty/loans', () => { loanPrefs.status = 'active'; loanPrefs.returnOnly = true; })));
    }
    cards.push(statCard('Avg utilization', pctText(v.utilization), null, goto('/faculty/reports')));
    return h('div', { class: 'stat-grid' }, cards);
  }

  function viewDashboard(main) {
    return withLoad(main, async () => {
      const wrap = h('div', { class: 'stack' });
      async function load() {
        const [summary, activeLoans] = await Promise.all([
          api.get('/api/reports/summary'),
          api.get('/api/loans?status=active'),
        ]);
        const returnRequested = (activeLoans || []).filter((l) => l.return_requested_at).length;
        wrap.replaceChildren(panel('Dashboard', 'Live overview of the college equipment desk.', null, [
          summaryCards(summary, returnRequested),
          h('p', { class: 'muted small' }, 'Cards with a highlighted value jump to the matching section.'),
        ]));
      }
      await load();
      return wrap;
    });
  }

  function requestTable(rows, reload) {
    if (!rows || rows.length === 0) {
      return emptyBlock('No requests in this state.', 'New student requests appear here for review.');
    }
    return dataTable(['#', 'Student', 'Semester', 'Model', 'Purpose', 'Requested window', 'Submitted', 'Status', 'Actions'],
      rows.map((r) => {
        const actions = [];
        if (r.request_status === 'PENDING') {
          actions.push(h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openApproveModal(r, reload) }, 'Approve'));
          actions.push(h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => openRejectModal(r, reload) }, 'Reject'));
        }
        return [
          r.request_id,
          h('div', {}, [h('strong', {}, r.full_name || '-'), h('div', { class: 'muted small' }, r.student_id || '')]),
          r.semester === null || r.semester === undefined ? '-' : r.semester,
          r.model_name || '-',
          h('span', { class: 'purpose-cell', title: r.purpose || '' }, r.purpose || '-'),
          fmtDateTime(r.requested_start) + ' → ' + fmtDateTime(r.requested_end),
          fmtDate(r.submitted_on),
          statusChip(r.request_status),
          h('div', { class: 'row-actions' }, actions),
        ];
      }));
  }

  function openApproveModal(request, reload) {
    const select = h('select', { id: 'approve-item', class: 'input', disabled: true },
      h('option', { value: '' }, 'Loading units…'));
    const errorBox = h('div', { class: 'form-error', role: 'alert', hidden: true });
    const submit = h('button', { class: 'btn btn-primary', type: 'button' }, 'Approve request');

    select.replaceChildren(h('option', { value: '' }, 'Loading units…'));
    safely(api.get('/api/catalog/' + request.model_id + '/items').then((units) => {
      const options = [h('option', { value: '' }, 'Auto - let the server pick the best free unit')];
      (units || [])
        .filter((u) => ['AVAILABLE', 'ON_LOAN'].indexOf(String(pick(u, 'availability', 'lifecycle_status') || '')) !== -1)
        .forEach((u) => {
          const availability = pick(u, 'availability', 'lifecycle_status');
          const nextFree = pick(u, 'next_free_ts');
          options.push(h('option', { value: u.item_id },
            (u.serial_no || ('#' + u.item_id)) + ' - ' + availability + (nextFree && availability !== 'AVAILABLE' ? ' (next free ' + fmtDate(nextFree) + ')' : '')));
        });
      select.replaceChildren(...options);
      select.disabled = false;
    }).catch((err) => {
      select.replaceChildren(h('option', { value: '' }, 'Auto - let the server pick the best free unit'));
      select.disabled = false;
      showError(errorBox, 'Could not load units: ' + errMessage(err));
    }));

    submit.addEventListener('click', runFormAction(submit, 'Approving…', async () => {
      const body = select.value ? { item_id: Number(select.value) } : {};
      const outcome = await api.post('/api/requests/' + request.request_id + '/approve', body);
      const kind = outcome && outcome.outcome;
      if (kind === 'RESERVED') {
        toast('RESERVED: reservation #' + pick(outcome, 'reservation_id') + ' created (item #' + pick(outcome, 'item_id') + ').', 'success');
      } else if (kind === 'QUEUED') {
        toast('QUEUED: ticket #' + pick(outcome, 'ticket_no') + ' for item #' + pick(outcome, 'item_id') + '.', 'info');
      } else {
        toast('Request approved.', 'success');
      }
      closeModal();
      await reload();
    }));

    openModal({
      title: 'Approve request #' + request.request_id,
      body: [
        defList([
          ['Student', (request.full_name || '') + ' (' + (request.student_id || '') + ')'],
          ['Model requested', request.model_name || ('#' + request.model_id)],
          ['Semester', request.semester === null || request.semester === undefined ? '-' : String(request.semester)],
          ['Window', fmtDateTime(request.requested_start) + ' → ' + fmtDateTime(request.requested_end)],
          ['Purpose', request.purpose || '-'],
        ]),
        field('Assign a specific unit', select, 'Keep “Auto” to let the server reserve the best unit, or queue the request when every unit is busy.'),
        errorBox,
      ],
      footer: [
        h('button', { class: 'btn btn-secondary', type: 'button', onclick: closeModal }, 'Cancel'),
        submit,
      ],
    });
  }

  function openRejectModal(request, reload) {
    const note = h('textarea', { id: 'reject-note', class: 'input', rows: 3, placeholder: 'Optional note shown in the request remarks' });
    const submit = h('button', { class: 'btn btn-danger', type: 'button' }, 'Reject request');
    submit.addEventListener('click', runFormAction(submit, 'Rejecting…', async () => {
      const trimmed = note.value.trim();
      await api.post('/api/requests/' + request.request_id + '/reject', trimmed ? { note: trimmed } : {});
      toast('Request rejected.', 'info');
      closeModal();
      await reload();
    }));
    openModal({
      title: 'Reject request #' + request.request_id,
      body: [
        h('p', { class: 'muted' }, (request.full_name || '') + ' · ' + (request.model_name || '')),
        field('Note (optional)', note),
      ],
      footer: [
        h('button', { class: 'btn btn-secondary', type: 'button', onclick: closeModal }, 'Cancel'),
        submit,
      ],
    });
  }

  function viewFacultyRequests(main) {
    return withLoad(main, async () => {
      let status = 'PENDING';
      let rowsCache = [];
      const chipsRow = h('div', { class: 'chips-row', role: 'group', 'aria-label': 'Filter requests by status' });
      const search = h('input', { class: 'input search-input', type: 'search', placeholder: 'Search student, USN, model or purpose…', 'aria-label': 'Search requests' });
      const bodyWrap = h('div');

      const defs = [['PENDING', 'Pending'], ['APPROVED', 'Approved'], ['REJECTED', 'Rejected'], ['ALL', 'All']];
      function renderChips() {
        chipsRow.replaceChildren(...defs.map(([value, label]) => h('button', {
          class: 'chip-btn' + (status === value ? ' chip-btn-active' : ''),
          type: 'button',
          'aria-pressed': status === value ? 'true' : 'false',
          onclick: () => { status = value; renderChips(); safely(load()); },
        }, label)));
      }
      function applyFilter() {
        const q = search.value.trim().toLowerCase();
        const rows = rowsCache.filter((r) => !q
          || [r.full_name, r.student_id, r.model_name, r.purpose, r.request_status].join(' ').toLowerCase().indexOf(q) !== -1);
        bodyWrap.replaceChildren(rowsCache.length > 0 && rows.length === 0
          ? emptyBlock('No requests match your search.', 'Clear the search box or change the status filter.')
          : requestTable(rows, load));
      }
      async function load() {
        bodyWrap.replaceChildren(loadingBlock('Loading requests…'));
        rowsCache = (await api.get('/api/requests' + (status === 'ALL' ? '' : '?status=' + status))) || [];
        applyFilter();
      }
      search.addEventListener('input', applyFilter);

      renderChips();
      await load();
      return panel('Lending requests',
        'Approve to reserve a unit or join the FIFO hold queue, or reject with a note. Showing ' +
          (state.user.role === 'ADMIN' ? 'every department' : (state.user.staff_dept_name || 'your department')) + '.',
        null,
        h('div', { class: 'stack' }, [h('div', { class: 'toolbar' }, [chipsRow, search]), bodyWrap]));
    });
  }

  function viewReservations(main) {
    return withLoad(main, async () => {
      let status = 'HELD';
      const chipsRow = h('div', { class: 'chips-row', role: 'group', 'aria-label': 'Filter reservations' });
      const bodyWrap = h('div');

      function renderChips() {
        chipsRow.replaceChildren(...[['HELD', 'Held'], ['ALL', 'All']].map(([value, label]) => h('button', {
          class: 'chip-btn' + (status === value ? ' chip-btn-active' : ''),
          type: 'button',
          'aria-pressed': status === value ? 'true' : 'false',
          onclick: () => { status = value; renderChips(); safely(load()); },
        }, label)));
      }

      async function checkout(reservation, reload) {
        const ok = await confirmDialog({
          title: 'Check out reservation #' + reservation.reservation_id,
          message: 'Hand ' + (reservation.serial_no || 'the unit') + ' (' + (reservation.model_name || '') + ') to '
            + (reservation.full_name || '') + ' (' + (reservation.student_id || '') + ')?',
          confirmLabel: 'Check out',
        });
        if (!ok) return;
        const out = await api.post('/api/reservations/' + reservation.reservation_id + '/checkout');
        toast('Loan #' + pick(out || {}, 'loan_id') + ' created - unit issued.', 'success');
        await reload();
      }

      async function load() {
        bodyWrap.replaceChildren(loadingBlock('Loading reservations…'));
        const rows = await api.get('/api/reservations?status=' + status);
        bodyWrap.replaceChildren(rows && rows.length
          ? dataTable(['#', 'Student', 'Model', 'Serial no', 'Reserved window', 'Hold expires', 'Status', 'Actions'],
            rows.map((r) => [
              r.reservation_id,
              h('div', {}, [h('strong', {}, r.full_name || '-'), h('div', { class: 'muted small' }, r.student_id || '')]),
              r.model_name || '-',
              r.serial_no || '-',
              fmtDateTime(pick(r, 'start_ts', 'start')) + ' → ' + fmtDateTime(pick(r, 'end_ts', 'end')),
              fmtDateTime(r.hold_expires_at),
              statusChip(r.status),
              h('div', { class: 'row-actions' },
                r.status === 'HELD'
                  ? [actionButton('Checkout', 'btn-primary btn-sm', () => checkout(r, load))]
                  : []),
            ]))
          : emptyBlock('No held reservations right now.', 'Approving a request reserves a unit here until it is collected.'));
      }

      renderChips();
      await load();
      return panel('Reservations',
        'Approved requests holding a specific unit - check out a hold to convert it into a loan.',
        null,
        h('div', { class: 'stack' }, [chipsRow, bodyWrap]));
    });
  }

  function loanTable(rows, reload) {
    if (!rows || rows.length === 0) {
      return emptyBlock('No loans match the current filters.', 'Change the status filter, lab filter or search text.');
    }
    return dataTable(['Student', 'Item', 'Lab', 'Checkout', 'Due', 'Status', 'Fine', 'Actions'],
      rows.map((row) => {
        const eff = effectiveLoanStatus(row);
        const statusBits = [chip(eff, toneFor(eff))];
        if (row.return_requested_at) {
          statusBits.push(chip('Return requested', 'blue', row.return_request_note ? 'Note: ' + row.return_request_note : 'Student requested this return'));
        }
        if (num(row.days_overdue) > 0 && !row.returned_at) {
          statusBits.push(h('span', { class: 'late small' }, num(row.days_overdue) + ' d overdue'));
        }
        let actions = null;
        if (!row.returned_at) {
          if (row.return_requested_at) {
            actions = [h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openReturnConditionModal(row, reload, true) }, 'Returned')];
          } else {
            actions = [h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => openReturnConditionModal(row, reload, false) }, 'Return')];
          }
        }
        return [
          h('div', {}, [
            h('strong', {}, row.full_name || '-'),
            h('div', { class: 'muted small' }, (row.student_id || '') + (row.email ? ' · ' + row.email : '')),
          ]),
          h('div', {}, [
            row.serial_no || '-',
            h('div', { class: 'muted small' }, row.model_name || ''),
          ]),
          row.lab_name || row.lab || '-',
          fmtDate(row.checkout_at),
          fmtDate(row.due_date),
          chipLine(statusBits),
          money(row.fine_amount),
          h('div', { class: 'row-actions' }, actions || []),
        ];
      }));
  }

  function viewLoans(main) {
    return withLoad(main, async () => {
      const filters = [['active', 'Active'], ['overdue', 'Overdue'], ['returned', 'Returned'], ['all', 'All']];
      const filtersRow = h('div', { class: 'btn-group', role: 'group', 'aria-label': 'Loan status filter' });
      const search = h('input', {
        id: 'loan-search', class: 'input input-inline', type: 'search', placeholder: 'Search student name, USN or email…',
        'aria-label': 'Search loans by student', autocomplete: 'off', value: loanPrefs.search,
      });
      const returnOnlyBtn = h('button', { type: 'button', class: 'chip-btn' + (loanPrefs.returnOnly ? ' chip-btn-active' : '') }, 'Return requested only');
      const labChips = h('div', { class: 'chips-row', role: 'group', 'aria-label': 'Filter by lab' });
      const bodyWrap = h('div');
      let fetched = [];

      let labs = [];
      try { labs = await getLabs(); } catch (err) { labs = []; }

      function renderFilters() {
        filtersRow.replaceChildren(...filters.map(([value, label]) => h('button', {
          class: 'btn btn-filter' + (loanPrefs.status === value ? ' btn-filter-active' : ''),
          type: 'button',
          'aria-pressed': loanPrefs.status === value ? 'true' : 'false',
          onclick: () => { loanPrefs.status = value; renderFilters(); safely(load()); },
        }, label)));
      }
      function renderLabChips() {
        labChips.replaceChildren(...[h('button', {
          class: 'chip-btn' + (loanPrefs.labId === null ? ' chip-btn-active' : ''),
          type: 'button', 'aria-pressed': loanPrefs.labId === null ? 'true' : 'false',
          onclick: () => { loanPrefs.labId = null; renderLabChips(); safely(load()); },
        }, 'All labs')].concat(labs.map((l) => h('button', {
          class: 'chip-btn' + (loanPrefs.labId === l.lab_id ? ' chip-btn-active' : ''),
          type: 'button', 'aria-pressed': loanPrefs.labId === l.lab_id ? 'true' : 'false',
          onclick: () => { loanPrefs.labId = l.lab_id; renderLabChips(); safely(load()); },
        }, l.lab_name))));
      }

      function applyFilters() {
        const q = loanPrefs.search.trim().toLowerCase();
        const filtered = fetched.filter((r) => {
          if (loanPrefs.returnOnly && !r.return_requested_at) return false;
          if (!q) return true;
          return String(r.full_name || '').toLowerCase().indexOf(q) !== -1
            || String(r.student_id || '').toLowerCase().indexOf(q) !== -1
            || String(r.email || '').toLowerCase().indexOf(q) !== -1
            || String(r.serial_no || '').toLowerCase().indexOf(q) !== -1
            || String(r.model_name || '').toLowerCase().indexOf(q) !== -1;
        });
        if (loanPrefs.status === 'active' || loanPrefs.status === 'overdue') {
          filtered.sort((a, b) => new Date(a.due_date) - new Date(b.due_date));
        }
        bodyWrap.replaceChildren(loanTable(filtered, load));
      }

      async function load() {
        bodyWrap.replaceChildren(loadingBlock('Loading loans…'));
        fetched = await api.get('/api/loans?status=' + loanPrefs.status + (loanPrefs.labId === null ? '' : '&lab_id=' + encodeURIComponent(loanPrefs.labId)));
        applyFilters();
      }

      search.addEventListener('input', () => { loanPrefs.search = search.value; applyFilters(); });
      returnOnlyBtn.addEventListener('click', () => {
        loanPrefs.returnOnly = !loanPrefs.returnOnly;
        returnOnlyBtn.classList.toggle('chip-btn-active', loanPrefs.returnOnly);
        applyFilters();
      });

      renderFilters();
      renderLabChips();
      await load();
      return panel('Loans',
        'Active, overdue and returned loans - mark student return requests as physically received.',
        null,
        h('div', { class: 'stack' }, [
          h('div', { class: 'toolbar' }, [filtersRow, search, returnOnlyBtn]),
          labChips,
          bodyWrap,
        ]));
    });
  }

  function viewStudents(main) {
    return withLoad(main, async () => {
      const search = h('input', {
        id: 'student-search', class: 'input', type: 'search', placeholder: 'Search by name or USN…',
        'aria-label': 'Search students', autocomplete: 'off',
      });
      const listBox = h('div', { class: 'student-list' });
      const detailBox = h('div', { class: 'student-detail' });
      const left = h('aside', { class: 'card student-panel' }, [
        h('h3', { class: 'card-title' }, 'Students'),
        search,
        listBox,
      ]);
      const right = h('section', { class: 'card student-panel student-panel-detail' }, [
        h('h3', { class: 'card-title' }, 'Student detail'),
        detailBox,
      ]);

      let students = [];
      let selectedId = null;
      let debounce = null;

      function renderList() {
        if (!students.length) {
          listBox.replaceChildren(emptyBlock('No students found.'));
          return;
        }
        listBox.replaceChildren(...students.map((s) => h('button', {
          class: 'student-item' + (selectedId === s.student_id ? ' student-item-active' : ''),
          type: 'button',
          'aria-pressed': selectedId === s.student_id ? 'true' : 'false',
          onclick: () => safely(openStudent(s.student_id)),
        }, [
          h('span', { class: 'student-item-name' }, s.full_name || s.student_id),
          h('span', { class: 'muted small' }, (s.student_id || '') + ' · Semester ' + (s.semester === null || s.semester === undefined ? '-' : s.semester)),
          s.active_loans ? chip(String(s.active_loans) + ' active', s.active_loans > 0 ? 'amber' : 'gray') : null,
        ])));
      }

      async function loadList() {
        students = await api.get('/api/students?q=' + encodeURIComponent(search.value.trim()));
        if (!Array.isArray(students)) students = [];
        renderList();
      }

      async function openStudent(id) {
        selectedId = id;
        renderList();
        detailBox.replaceChildren(loadingBlock('Loading student…'));
        const data = await api.get('/api/students/' + encodeURIComponent(id) + '/summary');
        detailBox.replaceChildren(studentDetail(data, () => openStudent(id)));
      }

      search.addEventListener('input', () => {
        window.clearTimeout(debounce);
        debounce = window.setTimeout(() => safely(loadList()), 300);
      });
      registerCleanup(() => window.clearTimeout(debounce));

      detailBox.replaceChildren(emptyBlock('Select a student', 'Search and click a student to see their holdings and history.'));
      await loadList();
      return h('div', { class: 'split' }, [left, right]);
    });
  }

  function studentDetail(data, reload) {
    const s = (data && data.student) || {};
    const current = (data && data.current_loans) || [];
    const history = (data && data.history_loans) || [];
    return h('div', { class: 'stack' }, [
      h('div', {}, [
        h('h4', { class: 'detail-name' }, s.full_name || 'Student'),
        h('p', { class: 'muted small' },
          (s.student_id || '') + ' · ' + (s.email || '-')
          + ' · Semester ' + (s.semester === null || s.semester === undefined ? '-' : s.semester)
          + (s.dept_name ? ' · ' + s.dept_name : '')),
      ]),
      h('h5', { class: 'sub-title' }, 'Current holdings'),
      holdingsTable(current, reload, 'faculty'),
      h('h5', { class: 'sub-title' }, 'History'),
      history.length
        ? dataTable(['Model', 'Serial no', 'Checkout', 'Returned', 'Condition', 'Fine'],
          history.map((row) => [
            row.model_name || '-',
            row.serial_no || '-',
            fmtDate(row.checkout_at),
            fmtDate(row.returned_at),
            row.return_condition ? chip(row.return_condition, toneFor(row.return_condition)) : '-',
            money(row.fine_amount),
          ]))
        : emptyBlock('No returned loans yet.'),
    ]);
  }

  function viewQueue(main) {
    return withLoad(main, async () => {
      let rowsCache = [];
      const search = h('input', { class: 'input search-input', type: 'search', placeholder: 'Search student, serial no, model or status…', 'aria-label': 'Search the queue' });
      const bodyWrap = h('div');
      const processBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Process queue');
      processBtn.addEventListener('click', runFormAction(processBtn, 'Processing…', async () => {
        const out = await api.post('/api/queue/tick', {});
        const offers = out && out.offers;
        const count = Array.isArray(offers) ? offers.length : num(offers);
        toast(count > 0
          ? 'Processed - ' + count + ' offer' + (count === 1 ? '' : 's') + ' issued.'
          : 'Processed - no offers to issue right now.', count > 0 ? 'success' : 'info');
        await load();
      }));

      function applyFilter() {
        const q = search.value.trim().toLowerCase();
        const rows = rowsCache.filter((r) => !q
          || [r.full_name, r.student_id, r.serial_no, r.model_name, r.queue_status].join(' ').toLowerCase().indexOf(q) !== -1);
        bodyWrap.replaceChildren(rowsCache.length > 0 && rows.length === 0
          ? emptyBlock('No queue entries match your search.', 'Clear the search box to see the full FIFO board.')
          : queueBoard(rows));
      }
      async function load() {
        rowsCache = (await api.get('/api/queue')) || [];
        applyFilter();
      }
      search.addEventListener('input', applyFilter);

      await load();

      const refreshTimer = window.setInterval(() => {
        if (!document.hidden && !state.modal) safely(load());
      }, QUEUE_REFRESH_MS);
      const ticker = window.setInterval(updateCountdowns, 1000);
      registerCleanup(() => { window.clearInterval(refreshTimer); window.clearInterval(ticker); });

      return panel('Fair hold queue',
        'FIFO tickets per unit - offers expire automatically and repeat no-shows are skipped. Refreshes every 15 seconds while open.',
        processBtn,
        h('div', { class: 'stack' }, [h('div', { class: 'toolbar' }, [search]), bodyWrap]));
    });
  }

  function updateCountdowns() {
    document.querySelectorAll('[data-expires]').forEach((el) => {
      el.textContent = countdownText(el.dataset.expires);
      el.classList.toggle('countdown-expired', el.textContent === 'expired');
    });
  }

  function queueBoard(rows) {
    if (!rows || rows.length === 0) {
      return emptyBlock('The queue is empty.', 'Requests join the queue when every unit of the model is busy for the requested window.');
    }
    const groups = new Map();
    rows.forEach((r) => {
      if (!groups.has(r.item_id)) groups.set(r.item_id, []);
      groups.get(r.item_id).push(r);
    });
    const cards = [];
    groups.forEach((entries) => {
      entries.sort((a, b) => num(a.ticket_no) - num(b.ticket_no));
      const first = entries[0];
      cards.push(h('section', { class: 'card queue-card' }, [
        h('div', { class: 'queue-head' }, [
          h('h3', { class: 'model-name' }, first.serial_no || ('item #' + first.item_id)),
          h('span', { class: 'muted small' }, first.model_name || ''),
        ]),
        dataTable(['Ticket', 'Student', 'Purpose', 'Status', 'Offer expires', 'No-shows'],
          entries.map((r) => [
            '#' + r.ticket_no,
            h('div', {}, [h('strong', {}, r.full_name || '-'), h('div', { class: 'muted small' }, r.student_id || '')]),
            h('span', { class: 'purpose-cell', title: r.purpose || '' }, r.purpose || '-'),
            statusChip(r.queue_status),
            r.queue_status === 'OFFERED'
              ? h('span', { class: 'countdown', dataset: { expires: r.offer_expires_at || '' } }, countdownText(r.offer_expires_at))
              : '-',
            String(num(r.no_show_count)),
          ])),
      ]));
    });
    return h('div', { class: 'queue-grid' }, cards);
  }

  function viewEquipment(main) {
    return withLoad(main, async () => {
      const allLabs = await getLabs();
      const admin = state.user.role === 'ADMIN';
      const labs = admin
        ? allLabs
        : allLabs.filter((l) => Number(l.dept_id) === Number(state.user.staff_dept_id));
      if (!labs || !labs.length) {
        return emptyBlock('No labs are assigned to your department.', 'Ask the administrator to configure your department labs.');
      }

      let openLab = labs[0];
      let itemsCache = [];
      const search = h('input', { class: 'input search-input', type: 'search', placeholder: 'Search serial no, model, condition or status…', 'aria-label': 'Search lab items' });
      const tabsRow = h('div', { class: 'chips-row', role: 'tablist', 'aria-label': 'Labs' });
      const itemsBox = h('div');

      const itemForm = addItemForm(
        () => (openLab ? openLab.lab_id : null),
        () => (openLab ? openLab.lab_name : ''),
        () => (openLab ? openLab.dept_id : null),
        () => { safely(loadItems()); });
      const modelForm = addModelForm(() => { safely(itemForm.populateModels()); });

      function renderTabs() {
        tabsRow.replaceChildren(...labs.map((l) => h('button', {
          class: 'chip-btn' + (openLab && l.lab_id === openLab.lab_id ? ' chip-btn-active' : ''),
          type: 'button',
          role: 'tab',
          'aria-selected': openLab && l.lab_id === openLab.lab_id ? 'true' : 'false',
          onclick: () => { openLab = l; renderTabs(); itemForm.setLab(l); safely(loadItems()); },
        }, l.lab_name + ' · ' + num(l.total_items))));
      }

      function applyItemFilter() {
        const q = search.value.trim().toLowerCase();
        const rows = itemsCache.filter((r) => !q || [r.serial_no, r.model_name, r.manufacturer,
          r.item_condition, pick(r, 'availability', 'lifecycle_status')]
          .join(' ').toLowerCase().indexOf(q) !== -1);
        if (rows.length > 0) {
          itemsBox.replaceChildren(labItemsTable(rows, loadItems));
        } else if (itemsCache.length > 0) {
          itemsBox.replaceChildren(emptyBlock('No units match your search.', 'Clear the search box to see every unit in this lab.'));
        } else {
          itemsBox.replaceChildren(labItemsTable([], loadItems));
        }
      }
      async function loadItems() {
        itemsBox.replaceChildren(loadingBlock('Loading lab items…'));
        itemsCache = (await api.get('/api/labs/' + openLab.lab_id + '/items')) || [];
        applyItemFilter();
      }
      search.addEventListener('input', applyItemFilter);

      renderTabs();
      itemForm.setLab(openLab);
      await loadItems();

      return h('div', { class: 'stack' }, [
        panel('Equipment management',
          (admin ? 'All departments' : (state.user.staff_dept_name || 'Your department')) +
            ' - units of the selected lab, plus forms to add serialized units and catalogue models. You can only manage your own department.',
          null,
          h('div', { class: 'stack' }, [tabsRow, h('div', { class: 'toolbar' }, [search]), itemsBox])),
        h('div', { class: 'grid-2' }, [itemForm.el, modelForm.el]),
      ]);
    });
  }

  function labItemsTable(rows, reload) {
    if (!rows || rows.length === 0) {
      return emptyBlock('This lab has no units yet.', 'Use “Add item” below to register the first serialized unit.');
    }
    return dataTable(['Serial no', 'Model', 'Condition', 'Availability', 'Next free', 'Actions'],
      rows.map((r) => {
        const availability = String(pick(r, 'availability', 'lifecycle_status') || '-');
        const actions = [];
        if (availability === 'RETIRED') {
          actions.push(actionButton('Restore', 'btn-secondary btn-sm', async () => {
            await api.post('/api/items/' + r.item_id + '/restore');
            toast('Item ' + (r.serial_no || '') + ' restored.', 'success');
            await reload();
          }));
        } else if (availability !== 'LOST') {
          actions.push(actionButton('Retire', 'btn-danger btn-sm', async () => {
            const ok = await confirmDialog({
              title: 'Retire item',
              message: 'Retire ' + (r.serial_no || 'item #' + r.item_id) + '? It will be hidden from lending.',
              confirmLabel: 'Retire',
              danger: true,
            });
            if (!ok) return;
            await api.post('/api/items/' + r.item_id + '/retire');
            toast('Item ' + (r.serial_no || '') + ' retired.', 'info');
            await reload();
          }));
        }
        return [
          r.serial_no || '-',
          h('div', {}, [r.model_name || '-', h('div', { class: 'muted small' }, r.manufacturer || '')]),
          chip(String(pick(r, 'item_condition') || '-'), toneFor(pick(r, 'item_condition'))),
          chip(availability, toneFor(availability)),
          pick(r, 'next_free_ts') ? fmtDateTime(pick(r, 'next_free_ts')) : '-',
          h('div', { class: 'row-actions' }, actions),
        ];
      }));
  }

  function addItemForm(getLabId, getLabName, getDeptId, onCreated) {
    const serial = h('input', { id: 'add-item-serial', class: 'input', type: 'text', placeholder: 'e.g. ISE-PRJ-05', spellcheck: 'false' });
    const modelSelect = h('select', { id: 'add-item-model', class: 'input' }, h('option', { value: '' }, 'Loading models…'));
    const condition = h('select', { id: 'add-item-condition', class: 'input' },
      ['NEW', 'GOOD', 'FAIR', 'DAMAGED'].map((c) => h('option', { value: c, selected: c === 'GOOD' }, c)));
    const labNote = h('p', { class: 'field-hint' });
    const errorBox = h('div', { class: 'form-error', role: 'alert', hidden: true });
    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add item');

    const form = h('form', {
      class: 'card form-card',
      novalidate: true,
      onsubmit: runFormAction(submit, 'Adding…', async () => {
        hideError(errorBox);
        const serialNo = serial.value.trim().toUpperCase();
        if (!serialNo) { showError(errorBox, 'Enter the serial number.'); serial.focus(); return; }
        if (!modelSelect.value) { showError(errorBox, 'Choose a model.'); modelSelect.focus(); return; }
        const labId = getLabId();
        if (!labId) { showError(errorBox, 'Open a lab tab first.'); return; }
        const created = await api.post('/api/items', {
          serial_no: serialNo,
          model_id: Number(modelSelect.value),
          lab_id: labId,
          item_condition: condition.value,
        });
        const id = pick(created || {}, 'item_id', 'id');
        toast('Item ' + serialNo + ' added to ' + getLabName() + (id ? ' (item #' + id + ')' : '') + '.', 'success');
        form.reset();
        condition.value = 'GOOD';
        serial.focus();
        onCreated();
      }),
    },
      h('h3', { class: 'card-title' }, 'Add item'),
      h('p', { class: 'muted small' }, 'A serialized physical unit is added to the currently open lab.'),
      field('Serial no', serial),
      field('Model', modelSelect),
      field('Condition', condition),
      labNote,
      errorBox,
      submit);

    function populateModels() {
      const deptId = getDeptId ? getDeptId() : null;
      safely(api.get('/api/catalog' + (deptId ? '?dept_id=' + encodeURIComponent(deptId) : '')).then((models) => {
        const options = [h('option', { value: '' }, 'Select a model…')];
        (models || []).forEach((m) => {
          options.push(h('option', { value: m.model_id }, (m.model_name || '') + (m.manufacturer ? ' - ' + m.manufacturer : '')));
        });
        modelSelect.replaceChildren(...options);
      }).catch((err) => {
        modelSelect.replaceChildren(h('option', { value: '' }, 'Models unavailable'));
        showError(errorBox, errMessage(err));
      }));
    }

    populateModels();
    return {
      el: form,
      populateModels,
      setLab: (lab) => { labNote.textContent = lab ? 'Will be added to ' + lab.lab_name + (lab.location ? ' · ' + lab.location : '') + '.' : 'Open a lab to add units.'; },
    };
  }

  function addModelForm(onCreated) {
    const isAdmin = state.user.role === 'ADMIN';
    const name = h('input', { id: 'add-model-name', class: 'input', type: 'text', placeholder: 'e.g. Logitech C920 webcam' });
    const manufacturer = h('input', { id: 'add-model-manufacturer', class: 'input', type: 'text', placeholder: 'e.g. Logitech' });
    const description = h('textarea', { id: 'add-model-desc', class: 'input', rows: 2, placeholder: 'Short description (optional)' });
    const category = h('select', { id: 'add-model-category', class: 'input' }, h('option', { value: '' }, 'Loading categories…'));
    const dept = h('select', { id: 'add-model-dept', class: 'input' }, h('option', { value: '' }, 'Loading departments…'));
    const errorBox = h('div', { class: 'form-error', role: 'alert', hidden: true });
    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add model');

    function populateCategories() {
      const load = cache.categories ? Promise.resolve(cache.categories) : api.get('/api/categories');
      safely(load.then((categories) => {
        cache.categories = categories || [];
        category.replaceChildren(...[h('option', { value: '' }, 'Select a category…')].concat(
          cache.categories.map((c) => h('option', { value: c.category_id }, c.category_name + ' · max ' + c.max_loan_days + ' days'))));
      }).catch((err) => {
        category.replaceChildren(h('option', { value: '' }, 'Categories unavailable'));
        showError(errorBox, errMessage(err));
      }));
    }

    if (isAdmin) {
      safely(api.get('/api/departments').then((list) => {
        dept.replaceChildren(...[h('option', { value: '' }, 'Select a department…')].concat(
          (list || []).map((d) => h('option', { value: d.dept_id }, d.dept_name))));
      }).catch((err) => {
        dept.replaceChildren(h('option', { value: '' }, 'Departments unavailable'));
        showError(errorBox, errMessage(err));
      }));
    }

    const form = h('form', {
      class: 'card form-card',
      novalidate: true,
      onsubmit: runFormAction(submit, 'Adding…', async () => {
        hideError(errorBox);
        const modelName = name.value.trim();
        if (!modelName) { showError(errorBox, 'Enter the model name.'); name.focus(); return; }
        if (!manufacturer.value.trim()) { showError(errorBox, 'Enter the manufacturer.'); manufacturer.focus(); return; }
        if (!category.value) { showError(errorBox, 'Choose a category.'); category.focus(); return; }
        if (isAdmin && !dept.value) { showError(errorBox, 'Choose the department that owns this model.'); dept.focus(); return; }
        const body = {
          model_name: modelName,
          manufacturer: manufacturer.value.trim(),
          category_id: Number(category.value),
        };
        if (description.value.trim()) body.description = description.value.trim();
        if (isAdmin) body.dept_id = Number(dept.value);
        const created = await api.post('/api/models', body);
        const id = pick(created || {}, 'model_id', 'id');
        toast('Model “' + modelName + '” added' + (id ? ' (# ' + id + ')' : '') + '.', 'success');
        form.reset();
        onCreated();
      }),
    },
      h('h3', { class: 'card-title' }, 'Add catalogue model'),
      h('p', { class: 'muted small' }, 'Create a reusable equipment model, then add serialized units of it.'),
      field('Model name', name),
      field('Manufacturer', manufacturer),
      field('Description (optional)', description),
      field('Category', category),
      isAdmin
        ? field('Department', dept)
        : h('p', { class: 'muted small' }, 'This model will belong to ' + (state.user.staff_dept_name || 'your department') + '.'),
      errorBox,
      submit);

    populateCategories();
    return { el: form };
  }

  /* ========================================================================
   * 15. SQL console (faculty read-only / administrator unrestricted)
   * ======================================================================*/

  function viewConsole(main) {
    const isAdmin = state.user.role === 'ADMIN';
    const editor = h('textarea', {
      id: 'console-sql', class: 'input console-editor', rows: 7, spellcheck: false,
      placeholder: 'SELECT * FROM v_lab_items ORDER BY item_id;',
      'aria-label': 'SQL statement',
    });
    const runBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Run query  (Ctrl+Enter)');
    const status = h('div', { class: 'console-status muted' }, 'Ready - one statement per run.');
    const resultWrap = h('div', { class: 'console-result' }, emptyBlock('Run a query to see the results here.'));
    const schemaList = h('div', { class: 'schema-list' });
    const schemaSearch = h('input', { class: 'input input-inline', type: 'search', placeholder: 'Filter tables…', 'aria-label': 'Filter tables' });
    let relations = [];

    function renderSchema() {
      const q = schemaSearch.value.trim().toLowerCase();
      const list = relations.filter((r) => !q || r.name.toLowerCase().indexOf(q) !== -1);
      if (list.length === 0) {
        schemaList.replaceChildren(emptyBlock('No matching tables.'));
        return;
      }
      schemaList.replaceChildren(...list.map((rel) => h('details', { class: 'schema-rel' }, [
        h('summary', {}, [h('span', { class: 'schema-name' }, rel.name), h('span', { class: 'schema-kind' }, rel.kind)]),
        h('div', { class: 'schema-cols' }, rel.columns.map((c) => h('div', { class: 'schema-col' },
          c.name + ' : ' + c.type + (c.nullable ? '' : '  NOT NULL')))),
        h('button', {
          class: 'btn btn-ghost btn-sm', type: 'button',
          onclick: () => { editor.value = 'SELECT * FROM ' + rel.name + ' LIMIT 100;'; editor.focus(); },
        }, 'Query this table'),
      ])));
    }

    function fmtCell(value) {
      if (value === null || value === undefined) return 'NULL';
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
    }

    async function run() {
      const sqlText = editor.value.trim();
      if (!sqlText) { toast('Write a SQL statement first.', 'warn'); editor.focus(); return; }
      status.textContent = 'Running…';
      status.classList.remove('console-status-error');
      try {
        const out = await api.post('/api/console/query', { sql: sqlText, max_rows: 300 });
        const columns = out.columns || [];
        const rows = out.rows || [];
        status.textContent = out.command + ' · ' + rows.length + ' row(s) · ' + out.duration_ms + ' ms · '
          + (out.read_only ? 'read-only (faculty)' : 'unrestricted (admin)')
          + (out.truncated ? ' · truncated' : '');
        if (columns.length > 0) {
          resultWrap.replaceChildren(dataTable(columns, rows.map((row) => columns.map((c) => fmtCell(row[c])))));
        } else {
          resultWrap.replaceChildren(emptyBlock(out.command + ' completed.', String(out.row_count) + ' row(s) affected.'));
        }
      } catch (err) {
        status.textContent = err.code || 'SQL error';
        status.classList.add('console-status-error');
        resultWrap.replaceChildren(h('div', { class: 'console-error' }, [
          h('strong', {}, err.code || 'SQL_ERROR'),
          h('p', {}, err.message || 'Query failed.'),
        ]));
      }
    }

    runBtn.addEventListener('click', run);
    editor.addEventListener('keydown', (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); run(); }
    });
    schemaSearch.addEventListener('input', renderSchema);

    safely(api.get('/api/console/schema').then((data) => {
      relations = (data && data.relations) || [];
      renderSchema();
    }).catch((err) => { schemaList.replaceChildren(errorBlock(err)); }));

    main.replaceChildren(panel(
      'SQL console',
      isAdmin
        ? 'Administrator console - any single SQL statement (SELECT, INSERT, UPDATE, DELETE, DDL) runs with full permissions and is committed.'
        : 'Read-only console - SELECT / WITH / TABLE / VALUES only. Each statement runs in a READ ONLY transaction and results render as tables below.',
      null,
      h('div', { class: 'console-layout' }, [
        h('aside', { class: 'console-side' }, [
          h('h3', { class: 'console-side-title' }, 'Database schema'),
          schemaSearch,
          schemaList,
        ]),
        h('div', { class: 'console-main' }, [
          editor,
          h('div', { class: 'toolbar' }, [
            runBtn,
            h('span', { class: 'muted small' }, isAdmin ? 'Unrestricted - changes are committed.' : 'Read-only - data cannot be modified.'),
          ]),
          status,
          resultWrap,
        ]),
      ])));
  }

  /* ========================================================================
   * 16. administration - account directory, faculty onboarding, resets
   * ======================================================================*/

  function viewAdminUsers(main) {
    return withLoad(main, async () => {
      let usersCache = [];
      const search = h('input', { class: 'input search-input', type: 'search', placeholder: 'Search name, email, role or USN…', 'aria-label': 'Search accounts' });
      const bodyWrap = h('div');
      const addBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Add faculty account');
      addBtn.addEventListener('click', () => openCreateFacultyModal(load));

      function applyFilter() {
        const q = search.value.trim().toLowerCase();
        const rows = usersCache.filter((u) => !q
          || [u.name, u.email, u.role, u.student_id, u.staff_role].join(' ').toLowerCase().indexOf(q) !== -1);
        if (rows.length === 0) {
          bodyWrap.replaceChildren(emptyBlock('No accounts match your search.', 'Clear the search box to see every account.'));
          return;
        }
        bodyWrap.replaceChildren(dataTable(['Name', 'Email', 'Role', 'Details', 'Last login', 'Actions'],
          rows.map((u) => [
            u.name || '-',
            u.email,
            roleBadge(u.role),
            u.role === 'STUDENT'
              ? ('USN ' + (u.student_id || '-'))
              : ((u.staff_role || '-') + (u.staff_dept_name ? ' · ' + u.staff_dept_name : '')),
            u.last_login ? fmtDateTime(u.last_login) : '-',
            h('div', { class: 'row-actions' }, [
              h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => openResetPasswordModal(u, load) }, 'Reset password'),
              h('button', {
                class: 'btn btn-danger btn-sm',
                type: 'button',
                disabled: u.user_id === state.user.user_id,
                title: u.user_id === state.user.user_id ? 'You cannot delete your own account' : null,
                onclick: async () => {
                  const ok = await confirmDialog({
                    title: 'Delete account',
                    message: 'Delete the login for ' + u.email + '? The student/staff record stays, but this account can no longer sign in.',
                    confirmLabel: 'Delete account',
                    danger: true,
                  });
                  if (!ok) return;
                  try {
                    await api.del('/api/admin/users/' + u.user_id);
                    toast('Account ' + u.email + ' deleted.', 'info');
                    await load();
                  } catch (err) { toastError(err); }
                },
              }, 'Delete'),
            ]),
          ])));
      }
      async function load() {
        bodyWrap.replaceChildren(loadingBlock('Loading accounts…'));
        usersCache = (await api.get('/api/admin/users')) || [];
        applyFilter();
      }
      search.addEventListener('input', applyFilter);
      await load();

      return panel('Accounts & roles',
        'Every account in the system. Faculty accounts are created here (or with the documented SQL); student accounts come from self-registration.',
        addBtn,
        h('div', { class: 'stack' }, [h('div', { class: 'toolbar' }, [search]), bodyWrap]));
    });
  }

  function openCreateFacultyModal(reload) {
    const name = h('input', { id: 'fac-name', class: 'input', type: 'text', placeholder: 'e.g. Dr. Ananya Rao' });
    const email = h('input', { id: 'fac-email', class: 'input', type: 'email', placeholder: 'ananyarao@rvce.edu.in' });
    const role = h('select', { id: 'fac-role', class: 'input' },
      [['LAB_ADMIN', 'Lab administrator'], ['TECHNICIAN', 'Technician'], ['DEPT_ADMIN', 'Department administrator']]
        .map(([v, l]) => h('option', { value: v }, l)));
    const dept = h('select', { id: 'fac-dept', class: 'input' }, h('option', { value: '' }, 'Loading departments…'));
    const password = h('input', { id: 'fac-password', class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'At least 8 characters' });
    const errorBox = h('div', { class: 'form-error', role: 'alert', hidden: true });
    const submit = h('button', { class: 'btn btn-primary', type: 'button' }, 'Create account');

    safely(api.get('/api/departments').then((list) => {
      dept.replaceChildren(...[h('option', { value: '' }, 'Select a department…')].concat(
        (list || []).map((d) => h('option', { value: d.dept_id }, d.dept_name))));
    }).catch((err) => {
      dept.replaceChildren(h('option', { value: '' }, 'Departments unavailable'));
      showError(errorBox, errMessage(err));
    }));

    submit.addEventListener('click', runFormAction(submit, 'Creating…', async () => {
      hideError(errorBox);
      const payload = {
        staff_name: name.value.trim(),
        email: email.value.trim().toLowerCase(),
        staff_role: role.value,
        dept_id: Number(dept.value),
        password: password.value,
      };
      if (!payload.staff_name) { showError(errorBox, 'Enter the faculty name.'); name.focus(); return; }
      if (!/^[a-z0-9._%+-]+@rvce\.edu\.in$/.test(payload.email)) {
        showError(errorBox, 'Email must be a name@rvce.edu.in address.'); email.focus(); return;
      }
      if (!payload.dept_id) { showError(errorBox, 'Choose the faculty department.'); dept.focus(); return; }
      if (payload.password.length < 8) {
        showError(errorBox, 'Password must be at least 8 characters.'); password.focus(); return;
      }
      try {
        const created = await api.post('/api/admin/faculty', payload);
        toast('Faculty account created for ' + created.email + '.', 'success');
        closeModal();
        await reload();
      } catch (err) {
        showError(errorBox, errMessage(err));
      }
    }));

    openModal({
      title: 'Add faculty account',
      body: [
        h('p', { class: 'muted' }, 'Faculty are pre-approved when they join. The account can sign in immediately and change its password from Settings.'),
        field('Full name', name),
        field('College email', email, 'No batch suffix, e.g. ananyarao@rvce.edu.in'),
        field('Department', dept),
        field('Staff role', role),
        field('Initial password', password, 'Minimum 8 characters; ask the faculty member to change it after the first login.'),
        errorBox,
      ],
      footer: [h('button', { class: 'btn btn-secondary', type: 'button', onclick: closeModal }, 'Cancel'), submit],
    });
  }

  function openResetPasswordModal(user, reload) {
    const pw = h('input', { id: 'reset-password', class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'New password (min 8 characters)' });
    const errorBox = h('div', { class: 'form-error', role: 'alert', hidden: true });
    const submit = h('button', { class: 'btn btn-primary', type: 'button' }, 'Reset password');
    submit.addEventListener('click', runFormAction(submit, 'Saving…', async () => {
      hideError(errorBox);
      if (pw.value.length < 8) {
        showError(errorBox, 'Password must be at least 8 characters.');
        pw.focus();
        return;
      }
      try {
        await api.post('/api/admin/users/' + user.user_id + '/reset-password', { new_password: pw.value });
        toast('Password reset for ' + user.email + ' - their other sessions were signed out.', 'success');
        closeModal();
        await reload();
      } catch (err) {
        showError(errorBox, errMessage(err));
      }
    }));
    openModal({
      title: 'Reset password - ' + user.email,
      body: [
        defList([['Account', user.email], ['Role', humanRole(user.role)], ['Name', user.name || '-']]),
        field('New password', pw),
        errorBox,
      ],
      footer: [h('button', { class: 'btn btn-secondary', type: 'button', onclick: closeModal }, 'Cancel'), submit],
    });
  }

  function viewMaintenance(main) {
    return withLoad(main, async () => {
      const labs = await getLabs();
      const itemLists = await Promise.all((labs || []).map((l) => api.get('/api/labs/' + l.lab_id + '/items')));
      const allItems = [];
      itemLists.forEach((list) => { (list || []).forEach((item) => allItems.push(item)); });

      let selectedItem = null;
      const picker = buildItemPicker(allItems, (item) => { selectedItem = item; });

      const startDefault = new Date();
      startDefault.setHours(startDefault.getHours() + 1, 0, 0, 0);
      const endDefault = new Date(startDefault.getTime() + 4 * 3600 * 1000);
      const start = h('input', { id: 'maint-start', class: 'input', type: 'datetime-local', value: toLocalInputValue(startDefault) });
      const end = h('input', { id: 'maint-end', class: 'input', type: 'datetime-local', value: toLocalInputValue(endDefault) });
      const reason = h('textarea', { id: 'maint-reason', class: 'input', rows: 2, placeholder: 'e.g. bulb replacement / calibration' });
      const errorBox = h('div', { class: 'form-error', role: 'alert', hidden: true });
      const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Create block');

      const form = h('form', {
        class: 'card form-card',
        novalidate: true,
        onsubmit: runFormAction(submit, 'Creating…', async () => {
          hideError(errorBox);
          if (!selectedItem) { showError(errorBox, 'Search and select the unit to block.'); return; }
          if (!reason.value.trim()) { showError(errorBox, 'Describe the reason for the block.'); reason.focus(); return; }
          if (!start.value || !end.value) { showError(errorBox, 'Choose the block start and end.'); return; }
          const startMs = new Date(start.value).getTime();
          const endMs = new Date(end.value).getTime();
          if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
            showError(errorBox, 'The end must be after the start.');
            return;
          }
          const created = await api.post('/api/maintenance', {
            item_id: selectedItem.item_id,
            start: new Date(startMs).toISOString(),
            end: new Date(endMs).toISOString(),
            reason: reason.value.trim(),
          });
          toast('Maintenance block #' + pick(created || {}, 'block_id') + ' created.', 'success');
          form.reset();
          picker.clear();
          selectedItem = null;
          await loadActive();
        }),
      },
        h('h3', { class: 'card-title' }, 'New maintenance block'),
        h('p', { class: 'muted small' }, 'Blocks the unit from lending for the selected window.'),
        h('div', { class: 'field' }, [h('span', { class: 'field-label' }, 'Unit'), picker.el]),
        h('div', { class: 'grid-2' }, [field('Start', start), field('End', end)]),
        field('Reason', reason),
        errorBox,
        submit);

      let status = 'active';
      const chipsRow = h('div', { class: 'chips-row', role: 'group', 'aria-label': 'Filter maintenance blocks' });
      const listBox = h('div');

      function renderChips() {
        chipsRow.replaceChildren(...[['active', 'Active'], ['all', 'All']].map(([value, label]) => h('button', {
          class: 'chip-btn' + (status === value ? ' chip-btn-active' : ''),
          type: 'button',
          'aria-pressed': status === value ? 'true' : 'false',
          onclick: () => { status = value; renderChips(); safely(loadActive()); },
        }, label)));
      }

      async function loadActive() {
        listBox.replaceChildren(loadingBlock('Loading maintenance blocks…'));
        const rows = await api.get('/api/maintenance?status=' + status);
        listBox.replaceChildren(maintenanceTable(rows, loadActive));
      }

      renderChips();
      await loadActive();

      return h('div', { class: 'stack' }, [
        h('div', { class: 'grid-2' }, [
          form,
          panel('Maintenance blocks', 'Active and past blocks.', null, h('div', { class: 'stack' }, [chipsRow, listBox])),
        ]),
      ]);
    });
  }

  function buildItemPicker(items, onSelect) {
    const input = h('input', { id: 'maint-item-search', class: 'input', type: 'search', placeholder: 'Search serial or model…', autocomplete: 'off' });
    const results = h('div', { class: 'picker-results', hidden: true });
    const selectedBox = h('div', { class: 'picker-selected' });
    let current = null;

    function renderSelected() {
      if (!current) {
        selectedBox.replaceChildren(h('span', { class: 'muted small' }, 'No unit selected yet.'));
        return;
      }
      selectedBox.replaceChildren(
        h('span', { class: 'picker-chip' }, [
          h('strong', {}, current.serial_no || ('#' + current.item_id)),
          ' · ' + (current.model_name || '') + (current.lab_name ? ' · ' + current.lab_name : ''),
        ]),
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { current = null; onSelect(null); renderSelected(); } }, 'Clear'));
    }

    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      if (!q) { results.hidden = true; return; }
      const matches = items
        .filter((it) => (String(it.serial_no || '') + ' ' + String(it.model_name || '')).toLowerCase().indexOf(q) !== -1)
        .slice(0, 8);
      results.replaceChildren(...(matches.length
        ? matches.map((it) => h('button', {
          class: 'picker-result',
          type: 'button',
          onclick: () => {
            current = it;
            onSelect(it);
            input.value = '';
            results.hidden = true;
            renderSelected();
          },
        }, [
          h('strong', {}, it.serial_no || ('#' + it.item_id)),
          h('span', { class: 'muted' }, ' · ' + (it.model_name || '') + (it.lab_name ? ' · ' + it.lab_name : '')),
          chip(String(pick(it, 'availability', 'lifecycle_status') || ''), toneFor(pick(it, 'availability', 'lifecycle_status'))),
        ]))
        : [h('div', { class: 'muted small' }, 'No matching units.')]));
      results.hidden = false;
    });

    renderSelected();
    return {
      el: h('div', { class: 'picker' }, [input, results, selectedBox]),
      clear: () => { current = null; onSelect(null); input.value = ''; results.hidden = true; renderSelected(); },
    };
  }

  function maintenanceTable(rows, reload) {
    if (!rows || rows.length === 0) {
      return emptyBlock('No maintenance blocks in this state.');
    }
    return dataTable(['#', 'Item', 'Reason', 'Window', 'Status', 'Actions'],
      rows.map((r) => [
        r.block_id,
        h('div', {}, [
          h('strong', {}, r.serial_no || ('item #' + r.item_id)),
          h('div', { class: 'muted small' }, r.model_name || ''),
        ]),
        h('span', { class: 'purpose-cell', title: r.reason || '' }, r.reason || '-'),
        fmtDateTime(pick(r, 'start_ts', 'start')) + ' → ' + fmtDateTime(pick(r, 'end_ts', 'end')),
        statusChip(r.status),
        h('div', { class: 'row-actions' },
          r.status === 'ACTIVE'
            ? [actionButton('Close', 'btn-secondary btn-sm', async () => {
              await api.post('/api/maintenance/' + r.block_id + '/close');
              toast('Maintenance block #' + r.block_id + ' closed.', 'success');
              await reload();
            })]
            : []),
      ]));
  }

  function viewReports(main) {
    return withLoad(main, async () => {
      const [summary, utilization, deptUtil, overdue, idle] = await Promise.all([
        api.get('/api/reports/summary'),
        api.get('/api/reports/utilization'),
        api.get('/api/reports/dept-utilization'),
        api.get('/api/reports/overdue'),
        api.get('/api/reports/idle'),
      ]);

      const escalation = actionButton('Run overdue escalation', 'btn-danger', async () => {
        const out = await api.post('/api/admin/escalate', {});
        const count = pick(out || {}, 'escalated', 'count', 'updated');
        toast(count === undefined ? 'Overdue escalation complete.' : 'Overdue escalation complete - ' + count + ' loan(s) updated.', 'success');
        render();
      });

      const utilBody = utilization && utilization.length
        ? dataTable(['Serial no', 'Model', 'Dept', 'Window start', 'Window h', 'Busy h', 'Utilization'],
          utilization.map((r) => [
            r.serial_no || '-',
            r.model_name || '-',
            r.dept_name || '-',
            fmtDate(r.win_start),
            fmtNum(r.window_hours),
            fmtNum(r.busy_hours),
            h('div', { class: 'ubar-cell' }, [utilizationBar(r.utilization_pct), h('span', { class: 'ubar-text' }, pctText(r.utilization_pct))]),
          ]))
        : emptyBlock('No utilization data yet.');

      const deptBody = deptUtil && deptUtil.length
        ? dataTable(['Department', 'Items', 'Avg utilization', 'Busy h', 'Window h'],
          deptUtil.map((r) => [
            r.dept_name || '-',
            r.item_count,
            h('div', { class: 'ubar-cell' }, [utilizationBar(r.avg_utilization_pct), h('span', { class: 'ubar-text' }, pctText(r.avg_utilization_pct))]),
            fmtNum(r.total_busy_hours),
            fmtNum(r.total_window_hours),
          ]))
        : emptyBlock('No department utilization data yet.');

      const overdueBody = overdue && overdue.length
        ? dataTable(['Student', 'Item', 'Dept', 'Due', 'Days overdue', 'Projected fine', 'Fine recorded', 'Status'],
          overdue.map((r) => [
            h('div', {}, [h('strong', {}, r.full_name || '-'), h('div', { class: 'muted small' }, r.student_id || '')]),
            h('div', {}, [r.serial_no || '-', h('div', { class: 'muted small' }, r.model_name || '')]),
            r.dept_name || '-',
            fmtDate(r.due_date),
            h('span', { class: 'late' }, String(num(r.days_overdue)) + ' d'),
            money(pick(r, 'projected_fine')),
            money(pick(r, 'fine_amount')),
            statusChip(pick(r, 'loan_status')),
          ]))
        : emptyBlock('No overdue loans - everything is back on time.');

      const idleBody = idle && idle.length
        ? dataTable(['Serial no', 'Model', 'Dept', 'Utilization', 'Busy h', 'Window h'],
          idle.map((r) => [
            r.serial_no || '-',
            r.model_name || '-',
            r.dept_name || '-',
            h('div', { class: 'ubar-cell' }, [utilizationBar(r.utilization_pct), h('span', { class: 'ubar-text' }, pctText(r.utilization_pct))]),
            fmtNum(r.busy_hours),
            fmtNum(r.window_hours),
          ]))
        : emptyBlock('No idle equipment - nice.');

      return h('div', { class: 'stack' }, [
        panel('Reports', 'Summary, utilization, department, overdue and idle-equipment reports.', null, summaryCards(summary, undefined)),
        panel('Item utilization', 'Share of the 90-day window each unit spent on loan or in maintenance.', null, utilBody),
        panel('Department utilization', null, null, deptBody),
        panel('Overdue loans', 'Run the escalation to move ACTIVE loans past due to OVERDUE and refresh fines.', escalation, overdueBody),
        panel('Idle equipment', 'Units under 5% utilization in the window.', null, idleBody),
      ]);
    });
  }

  /* ========================================================================
   * 10. live availability feed (SSE)
   * ======================================================================*/

  function connectEvents() {
    if (typeof window.EventSource !== 'function' || state.sse) return;
    let source = null;
    try { source = new EventSource('/api/events'); } catch (err) { return; }
    state.sse = source;
    const onEvent = () => scheduleLiveRefresh();
    source.onmessage = onEvent;
    source.onerror = () => { /* EventSource reconnects automatically */ };
    try { source.addEventListener('availability', onEvent); } catch (err) { /* named events unsupported */ }
  }

  let liveTimer = null;
  function scheduleLiveRefresh() {
    if (liveTimer !== null) return;
    liveTimer = window.setTimeout(() => {
      liveTimer = null;
      if (!state.token || !state.user || state.modal || document.hidden) return;
      const tag = document.activeElement ? document.activeElement.tagName : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (LIVE_ROUTES.has(state.route.path)) render();
    }, LIVE_REFRESH_MS);
  }

  /* ========================================================================
   * 11. boot
   * ======================================================================*/

  function boot() {
    loadSession();
    window.addEventListener('hashchange', render);
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeModal(); });
    render();
    connectEvents();

    // refresh the cached identity from the server (and validate the token)
    if (state.token) {
      safely(api.get('/api/auth/me').then((data) => {
        const fresh = data && data.user;
        if (!fresh) return;
        const wasLoggedOut = !state.user;
        const changed = JSON.stringify(fresh) !== JSON.stringify(state.user);
        state.user = fresh;
        persistSession();
        if (wasLoggedOut || (changed && state.route.path === '/settings')) render();
      }).catch(() => { /* api layer already handled 401 */ }));
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}());
