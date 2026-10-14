window.__ModuleLoader__.load({
  id: 'junior-dev',
  factory: (require) => {
    // S25: run progress docked above the input box of a junior-dev chat. Styled like DSH's own docks
    // (the todo panel): same width as the composer card, panel surface, 13px text.
    const React = require('react');
    const h = React.createElement;
    const API = '/api/junior-dev/progress';
    const POLL_MS = 2000;

    // Must equal PHASES in lib/engine/phases.js (a test checks it).
    const PHASES = ['intake', 'research', 'interview', 'prd_parity', 'requirements', 'verification_plan', 'specs', 'implementation_plan', 'preflight', 'final_parity', 'build', 'verify', 'human_checks', 'deliver', 'done'];
    const PHASE_LABEL = { intake: 'Intake', research: 'Research', interview: 'Interview', prd_parity: 'PRD parity', requirements: 'Requirements', verification_plan: 'Verification plan', specs: 'Specs', implementation_plan: 'Implementation plan', preflight: 'Preflight', final_parity: 'Final parity', build: 'Build', verify: 'Verify', human_checks: 'Your checks', deliver: 'Deliver', done: 'Done' };
    // The whole run as four stages; widths are each stage's share of the bar.
    const STAGES = [
      { key: 'plan', label: 'Plan', weight: 25, phases: PHASES.slice(0, PHASES.indexOf('build')) },
      { key: 'build', label: 'Build', weight: 55, phases: ['build'] },
      { key: 'verify', label: 'Verify', weight: 12, phases: ['verify', 'human_checks'] },
      { key: 'deliver', label: 'Deliver', weight: 8, phases: ['deliver'] },
    ];

    /** Pure: where the run is, as {stage, fractions per stage (0..1), pct overall, label}. */
    function overall(data) {
      const phase = data.phase;
      const done = phase === 'done';
      const at = done ? STAGES.length : STAGES.findIndex((s) => s.phases.includes(phase));
      const bar = data.bar || { done: 0, total: 0 };
      const fractions = STAGES.map((s, i) => {
        if (i < at) return 1;
        if (i > at) return 0;
        if (s.key === 'build') return bar.total ? bar.done / bar.total : 0;
        return s.phases.indexOf(phase) / s.phases.length;
      });
      const pct = Math.round(STAGES.reduce((sum, s, i) => sum + s.weight * fractions[i], 0));
      let label = PHASE_LABEL[phase] || phase;
      if (phase === 'build' && bar.total) label = `Build · ${bar.done} of ${bar.total} done`;
      if (phase === 'human_checks') label = 'Waiting for your checks';
      return { stage: done ? null : STAGES[at] ? STAGES[at].key : null, fractions, pct: done ? 100 : pct, label };
    }

    const TONE = {
      brand: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
      success: 'var(--dsw-alias-label-success, #1a7f37)',
      warning: 'var(--dsw-alias-label-warning, #9a6700)',
      danger: 'var(--dsw-alias-label-danger, #cf222e)',
      muted: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.8))',
    };
    function toneOf(data) {
      if (data.phase === 'done') return 'success';
      if (data.side === 'blocked' || data.side === 'stopped') return 'danger';
      if (data.side === 'paused' || data.parked) return 'warning';
      return 'brand';
    }

    const CSS = `
@keyframes jd-dock-sheen { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
@keyframes jd-dock-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
.jd-dock-sheen { position: absolute; inset: 0; width: 40%; background: linear-gradient(90deg, transparent, rgba(255,255,255,.35), transparent); animation: jd-dock-sheen 1.6s ease-in-out infinite; }
.jd-dock-pulse { animation: jd-dock-pulse 1.4s ease-in-out infinite; }
.jd-dock-head:not(:disabled):hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08)); }
@media (prefers-reduced-motion: reduce) { .jd-dock-pulse { animation: none; } .jd-dock-sheen { display: none; } }`;
    function ensureStyle() {
      if (typeof document === 'undefined' || document.getElementById('jd-dock-style')) return;
      const el = document.createElement('style');
      el.id = 'jd-dock-style';
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    function sessionIdFrom(props) {
      if (props && typeof props.sessionId === 'string') return props.sessionId;
      if (props && props.session && typeof props.session.id === 'string') return props.session.id;
      const m = window.location.pathname.match(/([0-9a-f]{8}-[0-9a-f-]{27,}|[A-Za-z0-9_-]{16,})\/?$/);
      return m ? m[1] : null;
    }

    async function fetchProgress(sessionId) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 5000);
      try {
        const res = await fetch(`${API}?sessionId=${encodeURIComponent(sessionId)}`, { signal: ctl.signal, credentials: 'same-origin' });
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      } finally {
        clearTimeout(t);
      }
    }

    const ICON = { done: '✓', blocked: '!', parked: '?', working: '◐', checking: '◐', submitted: '◐', recheck: '↻' };
    const ITEM_TONE = { done: TONE.success, blocked: TONE.danger, parked: TONE.warning, working: TONE.brand, checking: TONE.brand, submitted: TONE.brand };

    function Segments({ view, tone, working }) {
      return h(
        'div',
        { 'data-testid': 'junior-dev-bar', role: 'progressbar', 'aria-valuenow': view.pct, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuetext': `${view.pct}% · ${view.label}`, style: { display: 'flex', gap: 4 } },
        STAGES.map((s, i) => {
          const f = view.fractions[i];
          const current = s.key === view.stage;
          return h(
            'div',
            { key: s.key, style: { flex: `${s.weight} 1 0`, minWidth: 0 } },
            h(
              'div',
              { style: { position: 'relative', height: 4, borderRadius: 2, overflow: 'hidden', background: 'var(--dsw-alias-border-l2, rgba(127,127,127,.22))' } },
              h('div', { style: { width: `${Math.round(f * 100)}%`, height: '100%', borderRadius: 2, background: TONE[tone], transition: 'width .6s ease' } }),
              current && working ? h('div', { className: 'jd-dock-sheen' }) : null,
            ),
            h('div', { style: { marginTop: 4, fontSize: 11, lineHeight: '14px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: current ? 'var(--dsw-alias-label-primary, inherit)' : TONE.muted, fontWeight: current ? 500 : 400 } }, s.label),
          );
        }),
      );
    }

    function Dock(props) {
      const sessionId = sessionIdFrom(props);
      const [data, setData] = React.useState(null);
      const [open, setOpen] = React.useState(false);
      React.useEffect(() => {
        ensureStyle();
        if (!sessionId) return undefined;
        let alive = true;
        let timer;
        const tick = async () => {
          const d = await fetchProgress(sessionId);
          if (alive) setData(d);
          if (alive) timer = setTimeout(tick, POLL_MS);
        };
        tick();
        return () => {
          alive = false;
          clearTimeout(timer);
        };
      }, [sessionId]);
      if (!data || !data.active) return null;
      const view = overall(data);
      const tone = toneOf(data);
      const working = Boolean(data.loopRunning) && !data.side;
      const items = data.checklist || [];
      const notes = [];
      if (data.side) notes.push(`${data.side}${data.sideReason ? `: ${data.sideReason}` : ''}`);
      if (data.grewBy) notes.push(`plan grew by ${data.grewBy}`);
      if (data.parked) notes.push(`${data.parked} waiting on your answers`);
      if (data.blocked) notes.push(`${data.blocked} blocked`);
      if (data.queued) notes.push(`${data.queued} question${data.queued === 1 ? '' : 's'} queued`);
      const inset = 'var(--dsh-composer-dock-inset, 8px)';
      return h(
        'div',
        {
          'data-testid': 'junior-dev-dock',
          style: {
            boxSizing: 'border-box',
            width: `calc(100% - 2 * var(--dsh-composer-side-clearance, 16px) - 4 * ${inset})`,
            maxWidth: `calc(var(--dsh-composer-card-max-width, 952px) - 4 * ${inset})`,
            margin: '0 auto',
            flex: 'none',
            overflow: 'hidden',
            borderRadius: 'var(--dsw-radius-lg, 12px)',
            background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-secondary, rgba(127,127,127,.08)))',
            backdropFilter: 'var(--dsw-menu-backdrop-filter, none)',
            boxShadow: 'var(--dsw-elevation-panel, 0 1px 3px rgba(0,0,0,.2))',
            color: 'var(--dsw-alias-label-primary, inherit)',
            fontSize: 13,
            lineHeight: '20px',
          },
        },
        h(
          'button',
          {
            type: 'button',
            className: 'jd-dock-head',
            'aria-expanded': items.length ? open : undefined,
            disabled: !items.length,
            onClick: () => setOpen(!open),
            style: { boxSizing: 'border-box', width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px 6px', border: 'none', background: 'none', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: items.length ? 'pointer' : 'default' },
          },
          h('span', { className: working ? 'jd-dock-pulse' : undefined, style: { width: 8, height: 8, borderRadius: '50%', flex: 'none', background: TONE[tone] } }),
          h('span', { style: { fontWeight: 500, flex: 'none' } }, 'Junior Dev'),
          h('span', { style: { color: TONE.muted, flex: 'none' } }, data.feature),
          h('span', { style: { color: 'var(--dsw-alias-label-secondary, inherit)', minWidth: 0, flex: '1 1 auto', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, `· ${view.label}`),
          h('span', { style: { color: TONE.muted, flex: 'none', fontVariantNumeric: 'tabular-nums' } }, `${view.pct}%`),
          items.length ? h('span', { 'aria-hidden': true, style: { color: TONE.muted, flex: 'none', width: 14, textAlign: 'center', transform: open ? 'none' : 'rotate(180deg)', transition: 'transform .15s' } }, '⌃') : null,
        ),
        h('div', { style: { padding: '0 12px 8px' } }, h(Segments, { view, tone, working })),
        open && items.length
          ? h(
              'ul',
              { 'data-testid': 'junior-dev-checklist', style: { listStyle: 'none', margin: 0, padding: '6px 12px 8px', maxHeight: 168, overflowY: 'auto', borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.15))' } },
              items.map((c) =>
                h(
                  'li',
                  { key: c.id, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' } },
                  h('span', { style: { width: 14, flex: 'none', textAlign: 'center', color: ITEM_TONE[c.status] || TONE.muted } }, ICON[c.status] || '○'),
                  h('span', { style: { flex: '1 1 auto', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: c.status === 'done' ? TONE.muted : 'inherit' } }, c.title),
                  h('span', { style: { flex: 'none', color: TONE.muted, fontVariantNumeric: 'tabular-nums' } }, `${c.done}/${c.total}`),
                ),
              ),
            )
          : null,
        notes.length ? h('div', { 'data-testid': 'junior-dev-notes', style: { padding: '0 12px 8px', fontSize: 12, lineHeight: '18px', color: TONE[tone === 'brand' ? 'muted' : tone] } }, notes.join(' · ')) : null,
      );
    }

    return {
      name: 'junior-dev',
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'junior-dev', order: 1 }, Dock));
      },
    };
  },
});
