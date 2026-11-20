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
.chip.spend { background: rgba(31,26,20,.06); color: var(--muted); cursor: default; }
.chip.spend.off { background: rgba(180,35,24,.1); color: var(--error); }
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
}
`;
