/**
 * DocuMind visual design system.
 *
 * See `.claude/context/design-principles.md` for the full rationale. In short:
 * DocuMind reads as a precise editorial/systems tool for an admin operator
 * curating a RAG knowledge base, not a marketing dashboard. Colors and type
 * are restrained; the one expressive device is the amber "signature mark" -
 * a 3px left border used ONLY on elements that are actively edited or
 * contextually relevant (see `markAmber` below).
 */
import type { CSSVariablesResolver, MantineColorsTuple } from '@mantine/core'

import { createTheme } from '@mantine/core'

// ---------------------------------------------------------------------------
// Color tokens (source of truth - do not hardcode these hex values elsewhere)
// ---------------------------------------------------------------------------

/** Page/content background. */
const paper = '#F5F3EE'
/** Primary text; also the AppShell header's background. */
const ink = '#1B1F2B'
/** Secondary text/labels. */
const inkMuted = '#5B6472'
/** Default interactive color (buttons, links, focus rings) - NOT the amber mark. */
const signalBlueBase = '#2C5F73'
/**
 * Signature accent. Used ONLY as a 3px solid left border on elements that are
 * currently active/edited/contextually-relevant (active nav item, a chunk
 * with unsaved edits, the chat context-indicator badge). Never a background
 * fill or decoration - restraint is the point.
 */
const markAmberBase = '#E2A93B'
/** Errors, the dislike-active state, destructive actions. */
const alertRedBase = '#B84C3E'
/** Hairline borders/dividers throughout the app. */
const hairline = '#DEDACD'

// ---------------------------------------------------------------------------
// Shade ramps
// ---------------------------------------------------------------------------
//
// The plan specifies a single hex per interactive color. Mantine components
// (Button, Badge, ActionIcon, focus rings, hover/active states, ...) expect a
// 10-shade tuple, so we derive one from each base hex: index 6 is the exact
// token color (Mantine's default light-mode primary shade), lightening
// toward white below it and darkening toward black above it.

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
const markAmber = buildShades(markAmberBase)
const alertRed = buildShades(alertRedBase)

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------
//
// IBM Plex Sans for UI chrome (nav, headings, buttons, labels, body text);
// IBM Plex Mono for content/data being curated or inspected (chunk text,
// table cells that are data, chat message content) - applied per-component
// via `ff="monospace"` or `theme.fontFamilyMonospace`, not globally.

const plexSansStack = '"IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
const plexMonoStack = '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

export const theme = createTheme({
  primaryColor: 'signalBlue',
  primaryShade: 6,
  colors: {
    signalBlue,
    markAmber,
    alertRed,
  },
  fontFamily: plexSansStack,
  fontFamilyMonospace: plexMonoStack,
  headings: {
    fontFamily: plexSansStack,
  },
  other: {
    paper,
    ink,
    inkMuted,
    hairline,
  },
})

/**
 * Wires the flat (non-ramp) tokens - `paper`, `ink`, `inkMuted`, `hairline` -
 * into Mantine's own CSS variables so the whole component library (page
 * background, default text color, dimmed/placeholder text, and the
 * `gray-3` shade that Table/Paper/AppShell/inputs use for hairline borders)
 * picks up DocuMind's palette automatically, without re-implementing
 * light/dark variants Mantine already manages. Also exposes them as
 * standalone `--doc-*` variables for the few places components need the raw
 * value directly (e.g. the AppShell header background).
 */
export const cssVariablesResolver: CSSVariablesResolver = (resolvedTheme) => ({
  variables: {
    '--doc-paper': resolvedTheme.other.paper,
    '--doc-ink': resolvedTheme.other.ink,
    '--doc-ink-muted': resolvedTheme.other.inkMuted,
    '--doc-hairline': resolvedTheme.other.hairline,
  },
  light: {
    '--mantine-color-body': resolvedTheme.other.paper,
    '--mantine-color-text': resolvedTheme.other.ink,
    '--mantine-color-dimmed': resolvedTheme.other.inkMuted,
    '--mantine-color-placeholder': resolvedTheme.other.inkMuted,
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
    paper: string
    ink: string
    inkMuted: string
    hairline: string
  }
}
