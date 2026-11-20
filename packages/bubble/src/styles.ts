export const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.root {
  --ink: #1f1a14; --paper: #fffbf2; --card: #ffffff; --muted: #6b5e4f; --line: rgba(31,26,20,.14);
  --honey: #f2a71b; --honey-ink: #7a4f00; --honey-tint: rgba(242,167,27,.14); --error: #b42318;
  --sky: #3b8fd9; --amber: #e8590c; --ok: #2b8a3e;
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink);
  -webkit-font-smoothing: antialiased;
}
button { font: inherit; color: inherit; cursor: pointer; }
button:focus-visible, textarea:focus-visible { outline: 2px solid var(--honey); outline-offset: 2px; }

/* Launcher: the hive */
.launcher {
  position: fixed; right: 16px; bottom: 12px; z-index: 2147483647;
  width: 76px; height: 87px; padding: 0; border: 0; background: none; border-radius: 16px;
  transition: transform .15s ease;
}
.launcher:hover { transform: scale(1.06); }
.launcher .hive { width: 76px; height: 87px; display: block; filter: drop-shadow(0 6px 10px rgba(31,26,20,.22)); transform-origin: 50% 92%; }
.launcher.busy .hive { animation: hum .28s ease-in-out infinite alternate; }
.launcher .idle { position: absolute; left: 29px; top: 14px; width: 18px; height: 18px; animation: orbit 6s linear infinite; pointer-events: none; }
.launcher .idle svg { width: 18px; height: 18px; }
.launcher.busy .idle { display: none; }
.wings { transform-box: fill-box; transform-origin: 50% 100%; animation: flap .09s linear infinite alternate; }

/* Panel */
.panel {
  position: fixed; right: 20px; bottom: 110px; z-index: 2147483647;
  width: min(380px, calc(100vw - 32px)); height: min(560px, calc(100vh - 120px));
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--paper); border: 1px solid var(--line); border-radius: 16px;
  box-shadow: 0 24px 64px rgba(31,26,20,.28);
}
header { display: flex; align-items: center; gap: 8px; padding: 12px 12px 12px 16px; border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 8px; font-weight: 650; flex: 1; min-width: 0; }
.brand svg { width: 24px; height: 24px; flex: none; }
.chip { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--honey-tint); color: var(--honey-ink); white-space: nowrap; }
.chip.off { background: rgba(180,35,24,.1); color: var(--error); }
.conn { font-size: 12px; color: var(--muted); }
.icon-btn { display: inline-flex; align-items: center; gap: 4px; border: 1px solid transparent; background: none; border-radius: 8px; padding: 6px; color: var(--muted); }
.icon-btn:hover:not(:disabled) { background: rgba(31,26,20,.06); color: var(--ink); }
.icon-btn:disabled { opacity: .4; cursor: default; }
.icon-btn svg { width: 18px; height: 18px; }
.icon-btn .txt { font-size: 13px; }

.banner { margin: 12px 12px 0; padding: 10px 12px; border-radius: 10px; background: var(--honey-tint); color: var(--honey-ink); font-size: 13px; }
.messages { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.empty { margin: auto; text-align: center; color: var(--muted); max-width: 260px; }
.empty svg { width: 56px; height: 56px; }
.empty p { margin: 8px 0 0; }
.msg { max-width: 88%; padding: 9px 12px; border-radius: 14px; white-space: pre-wrap; word-wrap: break-word; }
.msg.user { align-self: flex-end; background: var(--ink); color: var(--paper); border-bottom-right-radius: 4px; }
.msg.assistant { align-self: flex-start; background: var(--card); border: 1px solid var(--line); border-bottom-left-radius: 4px; }
.msg.system { align-self: center; max-width: 95%; background: none; color: var(--muted); font-size: 13px; text-align: center; padding: 2px 8px; }
.msg.system.error { color: var(--error); }
.route { align-self: flex-end; margin-top: -4px; font-size: 11px; color: var(--honey-ink); background: var(--honey-tint); border-radius: 999px; padding: 2px 8px; }
.meta { align-self: flex-start; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
.meta .icon-btn { padding: 2px 6px; }
.checks { display: inline-flex; gap: 4px; }
.check { font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--line); cursor: default; }
.check.ok { color: var(--ok); border-color: rgba(43,138,62,.35); background: rgba(43,138,62,.08); }
.check.failed { color: var(--error); border-color: rgba(180,35,24,.35); background: rgba(180,35,24,.06); }
.check.skipped { color: var(--muted); }
.card { align-self: stretch; padding: 10px 12px; border-radius: 12px; background: var(--card); border: 1px solid var(--honey); box-shadow: 0 2px 8px rgba(31,26,20,.08); }
.card p { margin: 0 0 8px; font-size: 13px; }
.card .actions { display: flex; gap: 8px; }
.card button { border: 1px solid var(--line); background: var(--paper); border-radius: 8px; padding: 5px 12px; font-size: 13px; }
.card button.primary { background: var(--ink); border-color: var(--ink); color: var(--paper); }
.card button:disabled { opacity: .45; cursor: default; }
.card .actions { align-items: center; }
.card .actions a { margin-left: auto; font-size: 12px; color: var(--honey-ink); }
.chip.spend { background: rgba(31,26,20,.06); color: var(--muted); cursor: default; }
.chip.spend.off { background: rgba(180,35,24,.1); color: var(--error); }
/* Deploy wizard */
.deploy { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.deploy-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.deploy-head h2 { margin: 0; font-size: 15px; }
.deploy .link { border: 0; background: none; padding: 0; color: var(--honey-ink); text-decoration: underline; font-size: 12px; }
.deploy-body { display: flex; flex-direction: column; gap: 10px; }
.deploy .muted { color: var(--muted); margin: 0; font-size: 13px; }
.deploy .small { font-size: 12px; margin: 0; }
.deploy a { color: var(--honey-ink); }
.hosts { display: grid; gap: 8px; }
.host { display: grid; gap: 2px; text-align: left; padding: 10px 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--card); }
.host.selected { border-color: var(--honey); box-shadow: inset 0 0 0 1px var(--honey); }
.host .top { display: flex; align-items: center; gap: 6px; }
.host .badge { font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 999px; background: var(--honey-tint); color: var(--honey-ink); }
.host .best { font-size: 13px; }
.host .meta { font-size: 11px; color: var(--muted); }
.host .state { font-size: 11px; font-weight: 600; color: var(--muted); }
.host .state.ok { color: var(--ok); }
.step { display: grid; grid-template-columns: 40px 1fr; gap: 10px; align-items: start; }
.step .art svg { width: 40px; height: 40px; display: block; }
.step h3 { margin: 2px 0 4px; font-size: 13px; }
.mini { margin: 0; padding-left: 18px; font-size: 12px; }
.deploy .row { display: flex; gap: 12px; align-items: center; margin: 6px 0 0; font-size: 12px; }
.env { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px; }
.env li { font: 600 11px/1 ui-monospace, Menlo, monospace; padding: 3px 6px; border-radius: 6px; background: rgba(43,138,62,.08); color: var(--ok); }
.env li.missing { background: rgba(232,89,12,.1); color: var(--amber); }
.deploy .primary { border: 0; border-radius: 10px; padding: 9px 14px; background: var(--ink); color: var(--paper); font-weight: 600; }
.deploy .primary:disabled { opacity: .4; cursor: default; }
.progress { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.progress li { display: grid; grid-template-columns: 32px 1fr; grid-template-rows: auto 4px; column-gap: 10px; row-gap: 4px; align-items: center; opacity: .45; }
.progress li.active, .progress li.done, .progress li.error { opacity: 1; }
.progress li.error .detail { color: var(--error); }
.progress li.error .bar i { background: var(--error); transform: scaleX(1) !important; }
.progress .art { grid-row: 1 / 3; }
.progress .art svg { width: 32px; height: 32px; display: block; }
.progress .text { display: grid; min-width: 0; }
.progress .text strong { font-size: 13px; }
.progress .detail { font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.progress .bar { height: 4px; border-radius: 4px; background: var(--line); overflow: hidden; }
.progress .bar i { display: block; height: 100%; background: var(--honey); transform-origin: left; transform: scaleX(0); transition: transform .3s ease; }
.progress li.done .bar i { background: var(--ok); transform: scaleX(1) !important; }
.progress li.busy .bar i { animation: busy 1s ease-in-out infinite alternate; }
.result { display: grid; gap: 8px; justify-items: start; }
.result .live { margin: 0; font-weight: 600; font-size: 14px; }
.qr { width: 132px; height: 132px; padding: 6px; background: #fff; border: 1px solid var(--line); border-radius: 10px; }
.qr svg { width: 100%; height: 100%; display: block; }
.domain summary { cursor: pointer; font-size: 12px; color: var(--honey-ink); }
.domain .mini { margin-top: 6px; }
.failure { display: grid; gap: 8px; justify-items: start; padding: 10px; border-radius: 10px; background: rgba(180,35,24,.06); }
.failure p { margin: 0; font-size: 13px; color: var(--error); }
.failure pre { margin: 0; justify-self: stretch; max-height: 140px; overflow: auto; background: var(--ink); color: var(--paper); padding: 8px; border-radius: 8px; font: 11px/1.4 ui-monospace, Menlo, monospace; white-space: pre-wrap; }
.deploy .note { margin: 0; padding: 10px; border-radius: 10px; background: var(--honey-tint); color: var(--honey-ink); font-size: 13px; }

/* Users & Data */
.panel.wide { width: min(760px, calc(100vw - 32px)); height: min(680px, calc(100vh - 120px)); }
.data { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; padding: 12px 16px 0; overflow: hidden; }
.data .link { border: 0; background: none; padding: 0; color: var(--honey-ink); text-decoration: underline; font-size: 12px; }
.data .muted { color: var(--muted); }
.data .small { font-size: 12px; }
.data p { margin: 0; }
.data h3 { margin: 4px 0 0; font-size: 13px; }
.data .primary { border: 0; border-radius: 10px; padding: 9px 14px; background: var(--ink); color: var(--paper); font-weight: 600; }
.data .primary:disabled { opacity: .4; cursor: default; }
.data .primary.danger { background: var(--error); }
.data .small-btn { padding: 5px 10px; font-size: 12px; }
.data .note { padding: 8px 10px; border-radius: 10px; background: var(--honey-tint); color: var(--honey-ink); font-size: 12px; }
.data .note.error-note { background: rgba(180,35,24,.07); color: var(--error); white-space: pre-wrap; }
.data .badge { font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 999px; background: var(--honey-tint); color: var(--honey-ink); }
.data-status { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
.data-status .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.data-status .dot.ok { background: var(--ok); }
.data-connect { display: grid; gap: 8px; overflow-y: auto; }
.data-connect .mini li { margin-bottom: 4px; }
.data-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--line); }
.data-tab { border: 0; border-bottom: 2px solid transparent; background: none; padding: 6px 10px; color: var(--muted); font-weight: 600; font-size: 13px; }
.data-tab[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--honey); }
.data-working { font-size: 12px; color: var(--honey-ink); }
.data-working::before { content: ""; display: inline-block; width: 8px; height: 8px; margin-right: 6px; border-radius: 50%; background: var(--honey); animation: pulse .8s ease-in-out infinite alternate; }
.data-body { flex: 1; min-height: 0; overflow-y: auto; padding-bottom: 12px; }
.data-pane { display: grid; gap: 10px; align-content: start; }
.data-ask { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: end; }
.data-ask textarea { font: inherit; resize: none; padding: 8px 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); color: var(--ink); min-width: 0; }
.data-ask textarea:focus-visible, .data input:focus-visible, .how .sql:focus-visible { outline: 2px solid var(--honey); outline-offset: 1px; }
.data-examples { display: flex; flex-wrap: wrap; gap: 6px; }
.chip-btn { border: 1px solid var(--line); background: var(--card); border-radius: 999px; padding: 4px 10px; font-size: 12px; }
.chip-btn:hover { border-color: var(--honey); }
.data-cards { display: grid; gap: 10px; }
.card { min-width: 0; display: grid; gap: 8px; padding: 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--card); }
.card .q { font-size: 12px; color: var(--muted); }
.card .headline { margin: 0; font-size: 18px; line-height: 1.3; overflow-wrap: anywhere; }
.data .meta { font-size: 11px; color: var(--muted); }
.failure-card { background: rgba(180,35,24,.06); border-color: rgba(180,35,24,.25); color: var(--error); white-space: pre-wrap; overflow-wrap: anywhere; }
.dtable { overflow: auto; max-height: 260px; border: 1px solid var(--line); border-radius: 8px; }
.dtable table { width: 100%; border-collapse: collapse; font-size: 12px; }
.dtable th { position: sticky; top: 0; padding: 6px 8px; background: var(--paper); border-bottom: 1px solid var(--line); text-align: left; font-weight: 600; white-space: nowrap; }
.dtable td { max-width: 260px; padding: 5px 8px; border-bottom: 1px solid var(--line); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dtable tr:last-child td { border-bottom: 0; }
.dtable .num { text-align: right; font-variant-numeric: tabular-nums; }
.dtable .null { color: var(--muted); }
.diff .old { color: var(--error); }
.diff .new { color: var(--ok); font-weight: 600; }
.diff .key { color: var(--muted); font: 11px ui-monospace, Menlo, monospace; }
.diff tr.gone td { color: var(--error); text-decoration: line-through; }
.diff tr.added td { color: var(--ok); }
.bars { display: grid; gap: 4px; }
.bar-row { display: grid; grid-template-columns: minmax(80px, 32%) 1fr auto; gap: 8px; align-items: center; font-size: 12px; }
.bar-row .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar-row .track { height: 10px; border-radius: 5px; background: var(--honey-tint); overflow: hidden; }
.bar-row .track i { display: block; height: 100%; border-radius: 5px; background: var(--honey); }
.bar-row .val { font-variant-numeric: tabular-nums; }
.how summary { cursor: pointer; font-size: 12px; color: var(--honey-ink); }
.how > * + * { margin-top: 6px; }
.how .sql { width: 100%; padding: 8px; border: 0; border-radius: 8px; background: var(--ink); color: var(--paper); font: 11px/1.45 ui-monospace, Menlo, monospace; resize: vertical; }
.how pre { max-height: 160px; overflow: auto; margin: 6px 0 0; padding: 8px; border-radius: 8px; background: var(--ink); color: var(--paper); font: 11px/1.4 ui-monospace, Menlo, monospace; white-space: pre-wrap; }
.proposal .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.proposal .word { font: inherit; padding: 7px 10px; border: 1px solid rgba(180,35,24,.5); border-radius: 8px; background: var(--card); color: var(--ink); min-width: 190px; }
.data .status { font-size: 12px; }
.ok-text { color: var(--ok); }
.error-text { color: var(--error); white-space: pre-wrap; }
.changes, .errors, .recent { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.changes li, .errors li { display: grid; gap: 4px; justify-items: start; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); }
.changes li.undone { opacity: .7; }
.errors .plain { font-size: 13px; }
.errors .msg { font: 11px/1.4 ui-monospace, Menlo, monospace; color: var(--muted); overflow-wrap: anywhere; }
.errors .how { justify-self: stretch; }
.logs-head { display: flex; align-items: center; justify-content: space-between; }
.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.stat { display: grid; padding: 8px 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); }
.stat strong { font-size: 20px; font-variant-numeric: tabular-nums; }
.stat span { font-size: 11px; color: var(--muted); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.recent li { display: flex; gap: 8px; font-size: 12px; }
.recent .when { min-width: 76px; color: var(--muted); }
.recent .who { font-weight: 600; }
.data-foot { display: grid; gap: 4px; padding: 8px 0 10px; border-top: 1px solid var(--line); }
.mask { display: flex; align-items: center; gap: 6px; font-size: 12px; }
@keyframes pulse { from { opacity: .35; } to { opacity: 1; } }
@keyframes busy { from { transform: scaleX(.1); } to { transform: scaleX(.6); } }

.think[aria-pressed="true"] { background: var(--honey-tint); color: var(--honey-ink); border-color: rgba(242,167,27,.5); }
.working { align-self: flex-start; display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); }
.working svg { width: 22px; height: 22px; animation: bob .9s ease-in-out infinite alternate; }

.composer { border-top: 1px solid var(--line); padding: 10px 12px 12px; background: var(--card); }
.picked { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; padding: 4px 4px 4px 10px; border-radius: 8px; background: var(--honey-tint); color: var(--honey-ink); font-size: 12px; }
.picked span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.picked .src { flex: none; font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; opacity: .75; }
.picked .src:empty { display: none; }
.picked .icon-btn { color: var(--honey-ink); padding: 2px; }
textarea {
  width: 100%; resize: none; border: 1px solid var(--line); border-radius: 10px; padding: 9px 10px;
  font: inherit; color: var(--ink); background: var(--paper); min-height: 44px; max-height: 140px;
}
.row { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
.modes { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; margin-left: auto; }
.modes button { border: 0; background: none; padding: 4px 8px; font-size: 12px; color: var(--muted); }
.modes button[aria-pressed="true"] { background: var(--ink); color: var(--paper); }
.send { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 32px; border: 0; border-radius: 8px; background: var(--ink); color: var(--paper); }
.send svg { width: 18px; height: 18px; }
.send.stop { background: var(--error); }

/* Picker */
.pick-box { position: fixed; left: 0; top: 0; z-index: 2147483646; pointer-events: none; border: 2px solid var(--honey); background: rgba(242,167,27,.12); border-radius: 4px; }
.pick-box::after { content: attr(data-tag); position: absolute; left: -2px; top: -22px; background: var(--ink); color: var(--paper); font: 600 11px/1 system-ui, sans-serif; padding: 4px 6px; border-radius: 4px; }
.pick-hint { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); z-index: 2147483647; background: var(--ink); color: var(--paper); padding: 8px 14px; border-radius: 999px; font-size: 13px; box-shadow: 0 8px 24px rgba(31,26,20,.25); }

/* Swarm */
.layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; overflow: hidden; }
/* Position comes from the flight engine every frame (inline transform on .bee); CSS animates only the inner parts. */
.bee { position: fixed; left: 0; top: 0; width: 34px; height: 34px; opacity: 0; transition: opacity .4s ease; filter: drop-shadow(0 3px 4px rgba(31,26,20,.3)); will-change: transform; }
.bee.out { opacity: 1; }
.bee.home { opacity: 0; }
.bee .body { width: 34px; height: 34px; }
.bee.thinking .body { animation: think 1.1s ease-in-out infinite alternate; }
.bee.clicking .body { animation: click .34s ease-out; }
.bee .sprite { width: 34px; height: 34px; transform: scale(.3); transition: transform .45s ease, filter .3s ease; }
.bee.out .sprite { transform: scale(var(--size, 1)); }
.bee.home .sprite { transform: scale(.25); }
.bee.error .sprite { filter: drop-shadow(0 0 5px rgba(232,89,12,.95)) hue-rotate(-20deg) saturate(1.5); }
.bee svg { width: 34px; height: 34px; display: block; transform-origin: 50% 55%; }
.bee .wings { animation-duration: var(--flap, .09s); }
.bee .label { position: absolute; left: 32px; top: 24px; white-space: nowrap; background: var(--ink); color: var(--paper); font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 999px; }
.bee .label:empty { display: none; }
.bee.building .label { background: var(--honey); color: var(--ink); }
.bee.done .label { background: var(--ok); color: #fff; }
.bee.done .label::before { content: "✓ "; }
.bee.error .label { background: var(--amber); color: #fff; }
.label .caret { display: inline-block; width: 2px; height: 11px; margin-left: 3px; vertical-align: -1px; background: currentColor; animation: blink 1s steps(2, start) infinite; }

/* Effects over page elements: the node is placed by inline transform, inner parts animate. */
.fx { position: fixed; left: 0; top: 0; pointer-events: none; transition: opacity .4s ease; will-change: transform; }
.fx.fade { opacity: 0 !important; }
.fx.ripple { border-radius: 10px; background: rgba(59,143,217,.035); }
.fx.ripple::before, .fx.ripple::after { content: ""; position: absolute; inset: 0; border: 2px solid var(--sky); border-radius: inherit; opacity: 0; animation: ripple 1.2s ease-out infinite; }
.fx.ripple::after { animation-delay: .6s; }
.fx.shimmer { overflow: hidden; border: 2px dashed var(--honey); border-radius: 8px; background: rgba(242,167,27,.09); }
.fx.shimmer .band { position: absolute; top: -20%; bottom: -20%; left: 0; width: 45%; background: linear-gradient(100deg, transparent, rgba(255,233,160,.75), transparent); transform: translateX(-120%); animation: sweep 1.15s ease-in-out infinite; }
.fx.check { width: 24px; height: 24px; }
.fx.check svg { width: 24px; height: 24px; padding: 4px; border-radius: 50%; background: var(--ok); color: #fff; box-shadow: 0 4px 10px rgba(31,26,20,.25); animation: pop .45s cubic-bezier(.2,1.6,.4,1) both; }
.fx.alert { border: 2px solid var(--amber); border-radius: 8px; background: rgba(232,89,12,.08); }
.fx.alert b { position: absolute; left: -11px; top: -11px; width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; background: var(--amber); color: #fff; font: 800 13px/1 system-ui, sans-serif; animation: nudge .6s ease-in-out infinite alternate; }

.tray { position: fixed; right: 104px; bottom: 28px; z-index: 2147483647; margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; align-items: flex-end; pointer-events: none; }
.tray li { display: flex; align-items: center; gap: 6px; background: var(--ink); color: var(--paper); font-size: 12px; padding: 4px 10px; border-radius: 999px; box-shadow: 0 4px 12px rgba(31,26,20,.2); }
/* Work on code that draws nothing on the page (config, data, server code) happens at the workbench. */
.tray li.bench { background: var(--paper); color: var(--ink); border: 1.5px dashed var(--honey); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: #9fd3ff; }
.dot.edit, .dot.write { background: var(--honey); }
.root.open .tray { display: none; }

@keyframes flap { from { transform: scaleY(1); } to { transform: scaleY(.55); } }
@keyframes bob { from { transform: translateY(0); } to { transform: translateY(-3px); } }
@keyframes hum { from { transform: rotate(-2.5deg); } to { transform: rotate(2.5deg); } }
@keyframes orbit {
  from { transform: rotate(0deg) translateX(26px) rotate(0deg); }
  to { transform: rotate(360deg) translateX(26px) rotate(-360deg); }
}
@keyframes ripple { from { transform: scale(.98); opacity: .85; } to { transform: scale(1.07); opacity: 0; } }
@keyframes sweep { to { transform: translateX(260%); } }
@keyframes pop { from { transform: scale(.3); } to { transform: scale(1); } }
@keyframes nudge { from { transform: scale(1); } to { transform: scale(1.18); } }
@keyframes think { from { transform: translateY(1px); } to { transform: translateY(-5px); } }
@keyframes click { 0% { transform: scale(1); } 40% { transform: scale(.72) translateY(3px); } 100% { transform: scale(1); } }
@keyframes blink { to { visibility: hidden; } }

@media (max-width: 480px) {
  .panel { right: 16px; left: 16px; width: auto; bottom: 104px; }
  .think .txt, .pick .txt { display: none; }
  .launcher { right: 12px; bottom: 8px; }
  .tray { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .bee, .bee .sprite { transition: none; }
  .wings, .launcher .hive, .launcher .idle, .bee .body, .bee .sprite, .working svg, .fx *, .fx::before, .fx::after, .label .caret { animation: none !important; }
  .fx.ripple::before { opacity: .8; }
  .fx.shimmer .band { display: none; }
  .progress li.busy .bar i { animation: none; }
  .data-working::before { animation: none; }
}
`;
