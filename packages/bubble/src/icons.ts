/** Inline SVG icons. Decorative, so each carries aria-hidden. */

export const BEE = `<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
  <g class="wings">
    <ellipse cx="26" cy="18" rx="10" ry="13" transform="rotate(-25 26 18)" fill="#dff1ff" stroke="#1f1a14" stroke-width="2.5" opacity=".95"/>
    <ellipse cx="38" cy="18" rx="10" ry="13" transform="rotate(25 38 18)" fill="#dff1ff" stroke="#1f1a14" stroke-width="2.5" opacity=".95"/>
  </g>
  <ellipse cx="32" cy="38" rx="17" ry="14" fill="#f2a71b" stroke="#1f1a14" stroke-width="2.5"/>
  <path d="M24 26.5c-2 3.4-3 7.3-3 11.5s1 8.1 3 11.5M32 24.2c-1.6 4.2-2.4 8.8-2.4 13.8s.8 9.6 2.4 13.8M40 26.5c2 3.4 3 7.3 3 11.5s-1 8.1-3 11.5" fill="none" stroke="#1f1a14" stroke-width="3.2" stroke-linecap="round"/>
  <circle cx="47.5" cy="34.5" r="2.2" fill="#1f1a14"/>
  <path d="M15 38h-5" stroke="#1f1a14" stroke-width="2.5" stroke-linecap="round"/>
</svg>`;

/** A straw skep beehive. The entrance hole sits at (48, 75) in drawing units; bees fly out of it. */
export const HIVE = `<svg class="hive" viewBox="10 8 76 87" aria-hidden="true" focusable="false">
  <ellipse cx="48" cy="90" rx="32" ry="4" fill="#1f1a14" opacity=".16"/>
  <g stroke="#1f1a14" stroke-width="2.5" stroke-linejoin="round" fill="#f4b02a">
    <rect x="40" y="13" width="16" height="13" rx="6.5"/>
    <rect x="33" y="23" width="30" height="15" rx="7.5"/>
    <rect x="27" y="35" width="42" height="16" rx="8"/>
    <rect x="22" y="48" width="52" height="17" rx="8.5"/>
    <rect x="18" y="62" width="60" height="18" rx="9"/>
  </g>
  <g fill="none" stroke="#b8730c" stroke-width="2" stroke-linecap="round" stroke-dasharray="2.5 5">
    <path d="M38 31.5h20"/>
    <path d="M33 44h30"/>
    <path d="M28 57.5h40"/>
    <path d="M24 72.5h12M60 72.5h12"/>
  </g>
  <g fill="none" stroke="#fff3c4" stroke-width="2.5" stroke-linecap="round">
    <path d="M44 17.5h3"/>
    <path d="M37.5 27.5h7"/>
    <path d="M31.5 39.5h9"/>
    <path d="M26.5 52.5h11"/>
    <path d="M23 66.5h12"/>
  </g>
  <path d="M38.5 80v-6.5a9.5 9.5 0 0 1 19 0V80z" fill="#2b1d10" stroke="#1f1a14" stroke-width="2.5" stroke-linejoin="round"/>
  <rect x="12" y="79" width="72" height="8" rx="3" fill="#c08845" stroke="#1f1a14" stroke-width="2.5"/>
</svg>`;

/** Where the hive entrance is, as a fraction of the drawn hive's size (viewBox 10 8 76 87). */
export const HIVE_ENTRANCE = { x: (48 - 10) / 76, y: (75 - 8) / 87 };

export const SEND =`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12l15-7-5 15-3-6-7-2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`;

export const STOP = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>`;

export const PICK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3l14 7-6 2-2 6L5 3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`;

export const UNDO = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7H4v5M4.5 11.5A8 8 0 1 1 6 17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const BULB = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.3 1.1 2.2h5c0-.9.4-1.7 1.1-2.2A6 6 0 0 0 12 3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const GLOBE = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`;

/** Users & Data: a database. */
export const DATA = `<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="5.5" rx="7.5" ry="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4.5 5.5v13c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-13M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;

/** Small pictures for the deploy steps (README §9: "each one a screen with a picture"). */
export const STEP_ART = {
  connect: `<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="6" y="14" width="16" height="20" rx="4" fill="#fff3c4" stroke="#1f1a14" stroke-width="2.5"/><rect x="26" y="14" width="16" height="20" rx="4" fill="#dff1ff" stroke="#1f1a14" stroke-width="2.5"/><path d="M18 24h12" stroke="#1f1a14" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="3 4"/></svg>`,
  build: `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M10 20l14-8 14 8v14l-14 8-14-8z" fill="#fff3c4" stroke="#1f1a14" stroke-width="2.5" stroke-linejoin="round"/><path d="M10 20l14 8 14-8M24 28v14" fill="none" stroke="#1f1a14" stroke-width="2.5" stroke-linejoin="round"/></svg>`,
  upload: `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M14 34a8 8 0 0 1-1-15.9A11 11 0 0 1 34 16a8.5 8.5 0 0 1 0 17" fill="#dff1ff" stroke="#1f1a14" stroke-width="2.5" stroke-linejoin="round"/><path d="M24 40V24m-6 6 6-6 6 6" fill="none" stroke="#1f1a14" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  live: `<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="16" fill="#e7f6ea" stroke="#1f1a14" stroke-width="2.5"/><path d="M8 24h32M24 8c5 4.5 7.5 10 7.5 16S29 35.5 24 40c-5-4.5-7.5-10-7.5-16S19 12.5 24 8z" fill="none" stroke="#1f1a14" stroke-width="2.5" stroke-linejoin="round"/></svg>`,
};

export const CLOSE =`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
