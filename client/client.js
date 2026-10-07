window.__ModuleLoader__.load({
  id: 'junior-dev',
  factory: (require) => {
    // S25: progress checklist + progress bar docked above the input box of a junior-dev chat.
    const React = require('react');
    const h = React.createElement;
    const API = '/api/junior-dev/progress';
    const POLL_MS = 2000;

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

    const ICON = { done: '✓', blocked: '!', parked: '?', working: '…', checking: '…', submitted: '…', recheck: '↻' };
    const TONE = { done: 'var(--dsw-alias-label-success, #1a7f37)', blocked: 'var(--dsw-alias-label-danger, #cf222e)', parked: 'var(--dsw-alias-label-warning, #9a6700)' };

    function Dock(props) {
      const sessionId = sessionIdFrom(props);
      const [data, setData] = React.useState(null);
      const [open, setOpen] = React.useState(true);
      React.useEffect(() => {
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
      const pct = data.bar && data.bar.total ? data.bar.pct : 0;
      const status = `${data.phase}${data.side ? ` · ${data.side}` : ''}${data.loopRunning ? ' · working' : ''}`;
      const notes = [];
      if (data.grewBy) notes.push(`plan grew: +${data.grewBy} items`);
      if (data.parked) notes.push(`${data.parked} waiting on your answers`);
      if (data.blocked) notes.push(`${data.blocked} blocked`);
      if (data.queued) notes.push(`${data.queued} question(s) queued`);
      return h(
        'div',
        {
          'data-testid': 'junior-dev-dock',
          style: { border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.3))', borderRadius: 10, padding: '8px 12px', margin: '0 0 8px', fontSize: 13, color: 'var(--dsw-alias-label-primary, inherit)', background: 'var(--dsw-alias-bg-secondary, transparent)' },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }, onClick: () => setOpen(!open) },
          h('strong', null, `junior-dev · ${data.feature}`),
          h('span', { style: { opacity: 0.7 } }, status),
          h('span', { style: { marginLeft: 'auto', opacity: 0.7 } }, data.bar && data.bar.total ? `${data.bar.done}/${data.bar.total} · ${pct}%` : ''),
        ),
        h(
          'div',
          { 'data-testid': 'junior-dev-bar', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100, style: { height: 6, borderRadius: 3, background: 'var(--dsw-alias-fill-secondary, rgba(127,127,127,.2))', margin: '6px 0', overflow: 'hidden' } },
          h('div', { style: { width: `${pct}%`, height: '100%', background: 'var(--dsw-alias-fill-brand, #2f81f7)', transition: 'width .3s' } }),
        ),
        open && data.checklist && data.checklist.length
          ? h(
              'ul',
              { 'data-testid': 'junior-dev-checklist', style: { listStyle: 'none', margin: 0, padding: 0 } },
              data.checklist.map((c) =>
                h(
                  'li',
                  { key: c.id, style: { display: 'flex', gap: 8, padding: '1px 0' } },
                  h('span', { style: { width: 14, color: TONE[c.status] || 'inherit' } }, ICON[c.status] || '○'),
                  h('span', null, c.title),
                  h('span', { style: { marginLeft: 'auto', opacity: 0.6 } }, `${c.done}/${c.total}`),
                ),
              ),
            )
          : null,
        notes.length ? h('div', { style: { marginTop: 4, opacity: 0.8 } }, notes.join(' · ')) : null,
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
