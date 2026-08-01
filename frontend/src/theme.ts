/**
 * DocuMind visual design system.
 *
 * See `.claude/context/design-principles.md` for the full rationale. In
 * short: DocuMind reads as a bold, dark, "neon" operator console for curating
 * a RAG knowledge base - a saturated blue+orange pairing on a deep navy
 * background, generous type, rounded/glowing surfaces. The signature device
 * carried over from the previous pass is the "mark" - now a `sparkOrange`
 * left border WITH an outer glow - used ONLY on elements that are actively
 * edited or contextually relevant (see `sparkOrange` below).
 */
import type { CSSVariablesResolver, MantineColorsTuple } from '@mantine/core'

import { createTheme } from '@mantine/core'

// ---------------------------------------------------------------------------
// Color tokens (source of truth - do not hardcode these hex values elsewhere)
// ---------------------------------------------------------------------------

/** Page background. Deep navy blue, per the user's reference swatch (previously read as too near-black/desaturated). */
const voidBg = '#101B36'
/** Elevated surface background - cards, panels, the header bar, the navbar, the dropzone. Deliberately close to `void`, just a touch lighter, not a bold contrast. */
const surface = '#131B2E'
/** Primary text; soft white-blue rather than pure white for comfortable reading on the dark background. */
const text = '#E8EDFA'
/** Secondary text/labels/timestamps. */
const textMuted = '#7C8AAD'
/** Primary accent: structure/connections/trust - primary buttons, links, default interactive color. */
const signalBlueBase = '#3D6BFF'
/**
 * Secondary accent: active/highlighted state, secondary CTAs. Also the base
 * color of the signature "mark" - see below.
 */
const sparkOrangeBase = '#FFA726'
/** Errors, the dislike-active state, destructive actions - distinct from both blue and orange. */
const alertMagentaBase = '#FF3D71'
/**
 * Hairline borders/dividers throughout the app. A translucent light-on-dark
 * value (rather than a flat hex) so the same token reads correctly no matter
 * which surface shade (`void` vs `surface`) it's drawn on top of.
 */
const hairline = 'rgba(232, 237, 250, 0.12)'

// ---------------------------------------------------------------------------
// Shade ramps
// ---------------------------------------------------------------------------
//
// The plan specifies a single hex per interactive color. Mantine components
// (Button, Badge, ActionIcon, focus rings, hover/active states, ...) expect a
// 10-shade tuple, so we derive one from each base hex: index 6 is the exact
// token color (Mantine's default primary shade), lightening toward white
// below it and darkening toward black above it.

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '')
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ]
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b]
    .map((channel) => Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, '0'))
    .join('')}`
}

function mix(hex: string, target: [number, number, number], weight: number): string {
  const [r, g, b] = hexToRgb(hex)
  return rgbToHex([r + (target[0] - r) * weight, g + (target[1] - g) * weight, b + (target[2] - b) * weight])
}

function buildShades(hex: string): MantineColorsTuple {
  const white: [number, number, number] = [255, 255, 255]
  const black: [number, number, number] = [0, 0, 0]
  const lightWeights = [0.92, 0.8, 0.64, 0.48, 0.32, 0.16]
  const darkWeights = [0.14, 0.28, 0.42]

  return [
    ...lightWeights.map((weight) => mix(hex, white, weight)),
    hex,
    ...darkWeights.map((weight) => mix(hex, black, weight)),
  ] as unknown as MantineColorsTuple
}

const signalBlue = buildShades(signalBlueBase)
const sparkOrange = buildShades(sparkOrangeBase)
const alertMagenta = buildShades(alertMagentaBase)

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------
//
// IBM Plex Sans for UI chrome (nav, headings, buttons, labels, body text);
// IBM Plex Mono for content/data being curated or inspected (chunk text,
// table cells that are data, chat message content) - applied per-component
// via `ff="monospace"` or `theme.fontFamilyMonospace`, not globally.
//
// This pass raises the base scale noticeably across the board (bigger page
// titles, bigger body/table text) - see `fontSizes`/`headings` below.

const plexSansStack = '"IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
const plexMonoStack = '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

export const theme = createTheme({
  primaryColor: 'signalBlue',
  primaryShade: 6,
  // All three brand accents (signalBlue/sparkOrange/alertMagenta) are bright
  // enough that Mantine's luminance check picks near-black text for filled
  // buttons/badges automatically - `black` is pointed at `void` rather than
  // pure #000 so that dark-on-bright text stays in-palette. This keeps
  // filled-button contrast comfortably at or above WCAG AA (verified against
  // the exact hexes below - see .claude/context/design-principles.md) without
  // hand-picking a text color at every call site.
  autoContrast: true,
  black: voidBg,
  colors: {
    signalBlue,
    sparkOrange,
    alertMagenta,
  },
  // Rounded panels/cards/inputs everywhere by default - buttons that need a
  // full pill shape (Send, the dislike control) still opt into radius="xl"
  // explicitly per the design brief.
  defaultRadius: 'lg',
  fontFamily: plexSansStack,
  fontFamilyMonospace: plexMonoStack,
  // Noticeably bigger than Mantine's defaults (xs 12/sm 14/md 16/lg 18/xl 20)
  // at every step - the brief asked for a clear, non-timid increase.
  fontSizes: {
    xs: '0.875rem',
    sm: '1rem',
    md: '1.125rem',
    lg: '1.375rem',
    xl: '1.625rem',
  },
  headings: {
    fontFamily: plexSansStack,
    fontWeight: '700',
    sizes: {
      h1: { fontSize: '2.75rem', lineHeight: '1.25' },
      h2: { fontSize: '2.25rem', lineHeight: '1.3' },
      h3: { fontSize: '1.875rem', lineHeight: '1.35' },
      h4: { fontSize: '1.5rem', lineHeight: '1.4' },
      h5: { fontSize: '1.25rem', lineHeight: '1.45' },
      h6: { fontSize: '1.125rem', lineHeight: '1.5' },
    },
  },
  other: {
    void: voidBg,
    surface,
    text,
    textMuted,
    hairline,
    /**
     * The signature "mark" glow - paired with a `sparkOrange` left border on
     * the active nav item / a dirty chunk / the chat context-indicator (the
     * same three spots as the previous amber-mark pass, see
     * design-principles.md). Exposed once here so the exact glow never
     * drifts between the three call sites.
     */
    markGlow: '0 0 16px rgba(255, 138, 0, 0.75)',
  },
})

/**
 * Wires the flat (non-ramp) tokens - `void`, `surface`, `text`, `textMuted`,
 * `hairline` - into Mantine's own CSS variables so the whole component
 * library (page background, default text color, dimmed/placeholder text, and
 * the `gray-3` shade that Table/Paper/AppShell/inputs use for hairline
 * borders) picks up DocuMind's palette automatically, without re-implementing
 * variants Mantine already manages. Also exposes them as standalone `--doc-*`
 * variables for the few places components need the raw value directly (e.g.
 * the AppShell header background, the dropzone surface).
 *
 * The app runs in Mantine's default "light" color scheme (no dark-mode
 * toggle) - "light" here just means "the one scheme in use", the actual
 * values it resolves to are the dark/neon palette above.
 */
export const cssVariablesResolver: CSSVariablesResolver = (resolvedTheme) => ({
  variables: {
    '--doc-void': resolvedTheme.other.void,
    '--doc-surface': resolvedTheme.other.surface,
    '--doc-text': resolvedTheme.other.text,
    '--doc-text-muted': resolvedTheme.other.textMuted,
    '--doc-hairline': resolvedTheme.other.hairline,
    '--doc-mark-glow': resolvedTheme.other.markGlow,
  },
  light: {
    '--mantine-color-body': resolvedTheme.other.void,
    '--mantine-color-text': resolvedTheme.other.text,
    '--mantine-color-dimmed': resolvedTheme.other.textMuted,
    '--mantine-color-placeholder': resolvedTheme.other.textMuted,
    '--mantine-color-gray-3': resolvedTheme.other.hairline,
  },
  dark: {},
})

// Note: intentionally NOT augmenting `MantineThemeColorsOverride` here - doing
// so replaces (rather than extends) Mantine's `DefaultMantineColor` union,
// which would drop its `(string & {})` escape hatch and make every existing
// `color`/`c`/`bg` usage of Mantine's built-in palette a type error.
declare module '@mantine/core' {
  export interface MantineThemeOther {
    void: string
    surface: string
    text: string
    textMuted: string
    hairline: string
    markGlow: string
  }
}
