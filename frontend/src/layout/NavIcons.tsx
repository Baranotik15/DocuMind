import type { JSX } from 'react'

/**
 * Hand-rolled per-nav-item glyphs for AppLayout.tsx's sidebar. No icon
 * library is installed (see design-principles.md's Icons section) - these
 * follow the same small inline-SVG convention as
 * PencilIcon/TrashIcon/SearchIcon/SortIcon in UploadPage.tsx and BrandMark in
 * AppLayout.tsx: `viewBox="0 0 24 24"`, sized ~20x20,
 * `aria-hidden="true"` + `focusable="false"` since each icon is purely
 * decorative and sits alongside (never instead of) the nav item's own
 * visible text label - the link's accessible name stays exactly that text.
 *
 * Unlike the other icons in the app, each glyph here is stroked with its own
 * fixed Mantine color token rather than `currentColor` - by explicit
 * request, the nav icons should read as colorful regardless of the parent
 * `NavLink`'s active/inactive/hover state, not inherit that muted/bright
 * color logic the way a `currentColor` icon would. Only the label text and
 * the sparkOrange active-mark (border + glow, applied on the `NavLink`
 * itself in AppLayout.tsx) still respond to active state - an icon sitting
 * at its own fixed color while the item is active or hovered is ordinary
 * palette use, not a conflict with "the mark" (see design-principles.md's
 * Color & Theming rules on that distinction). All five colors are existing
 * theme tokens (three of the app's own registered ramps plus two of
 * Mantine's stock colors, per design-principles.md's "Mantine's built-in
 * color names ... still available" rule) - no new hardcoded hex.
 */

/** Upload: an arrow rising into an open tray - the sidebar's own take on the
 * "upload" concept, distinct from (but in the same spirit as) the dropzone's
 * cloud-shaped `UploadIcon` in UploadPage.tsx. Stroked `sparkOrange-5` -
 * deliberately the exact same token that dropzone `UploadIcon` already uses,
 * so "upload" keeps one consistent color association app-wide rather than a
 * coincidental match. */
export function NavUploadIcon(): JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--mantine-color-sparkOrange-5)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M12 15V3" />
      <path d="m7 8 5-5 5 5" />
      <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </svg>
  )
}

/** Chat: a speech bubble. Stroked `signalBlue-5`, the app's primary/default
 * interactive accent - a fitting match for the chat pipeline. */
export function NavChatIcon(): JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--mantine-color-signalBlue-5)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  )
}

/** Relevance Preview: a crosshair/target, not a magnifying glass - the
 * Upload page's filename search (`SearchIcon`) already owns that glyph
 * elsewhere in the app, and "targeting" the relevant chunk reads more
 * precisely for this page's actual purpose anyway. Stroked Mantine's stock
 * `grape-5` - a hue none of the app's three branded ramps use, so this page
 * gets a genuinely distinct accent rather than reusing blue/gold/pink. */
export function NavRelevanceIcon(): JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--mantine-color-grape-5)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="8" />
      <line x1="22" y1="12" x2="18" y2="12" />
      <line x1="6" y1="12" x2="2" y2="12" />
      <line x1="12" y1="6" x2="12" y2="2" />
      <line x1="12" y1="22" x2="12" y2="18" />
    </svg>
  )
}

/** Logs & Stats: bar-chart bars of varying height. Stroked Mantine's stock
 * `cyan-5` - a cool, data/instrumentation-reading hue distinct from the
 * warmer/greener `teal-5` used on Improvements just below it. */
export function NavLogsIcon(): JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--mantine-color-cyan-5)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  )
}

/** Improvements: a trending-up arrow. Stroked Mantine's stock `teal-5` - the
 * same generic "positive/ok" tone the header's decorative "system ok" status
 * dot already uses elsewhere (see design-principles.md), a natural fit for a
 * trending-up glyph. Deliberately not `alertMagenta` - that ramp is reserved
 * for errors/destructive actions and would send the wrong signal here. */
export function NavImprovementsIcon(): JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--mantine-color-teal-5)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
      <polyline points="17 6 23 6 23 12" />
    </svg>
  )
}
