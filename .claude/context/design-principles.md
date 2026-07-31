# Design Principles

## Table of Contents

1. [Design Philosophy](#design-philosophy)
2. [Visual Hierarchy](#visual-hierarchy)
3. [Color & Theming](#color--theming)
4. [Typography](#typography)
5. [Spacing & Layout](#spacing--layout)
6. [Component Guidelines](#component-guidelines)
7. [Accessibility](#accessibility)
8. [Responsive Design](#responsive-design)
9. [Motion & Interaction](#motion--interaction)
10. [Naming Conventions](#naming-conventions)
11. [Checklist](#checklist)

---

## Design Philosophy

This project targets S-Tier SaaS design quality inspired by **Linear, Stripe, Vercel, and Airbnb**. Every interface should feel professional, polished, and intentional.

### Core Tenets

- **Clarity over decoration** — every element serves a purpose; remove anything that doesn't communicate
- **Consistency over novelty** — use established patterns from the design system before inventing new ones
- **Subtlety over loudness** — rely on spacing, typography weight, and muted color to create hierarchy rather than bold borders or heavy shadows
- **Data density without clutter** — present information-rich views that remain scannable through whitespace and type scale

### Distinctiveness

Avoid generic AI-generated aesthetics. The UI should feel **crafted**, not templated:
- Use the brand color palette (brand, accent, indigo) with intention
- Prefer light mode for the professional/business context
- Use subtle contrast over harsh blacks/whites
- Design for the operator (facility managers) — efficient, task-oriented, trustworthy

---

## Visual Hierarchy

### Information Ordering

1. **Primary** — key metrics, page titles, action buttons. Use `fw={600}`, larger font sizes, `color="gray.9"`
2. **Secondary** — body text, descriptions, supporting data. Use `fw={400}`, standard sizes, `color="gray.6"`
3. **Tertiary** — labels, timestamps, metadata. Use smaller sizes, `color="gray.5"` or `c="dimmed"`
4. **Disabled/placeholder** — `color="gray.4"`

### Depth

- Rely on **borders and background contrast** rather than heavy shadows
- Cards: `border: 1px solid gray.2`, `bg="white"` on a `gray.0` page background
- Use shadows sparingly (elevation levels 0-2 for most elements)
- Focus states: change border color, not shadow

---

## Color & Theming

All colors come from `frontend/src/theme.ts`. Never use hardcoded hex values.

### Brand Palette

| Token | Hex | Usage |
|-------|-----|-------|
| `brand[5]` | `#ec322b` | Active navigation, brand accents |
| `brand[9]` | `#aa0a0a` | Primary buttons, CTAs |
| `accent[5]` | `#20f0d0` | Accent highlights, secondary metrics |
| `indigo[5]` | `#6366f1` | Interactive elements, links |

### Neutral Grays

| Token | Hex | Usage |
|-------|-----|-------|
| `gray[0]` | `#f9fafb` | Page background, hover states |
| `gray[1]` | `#f3f4f6` | Light borders |
| `gray[2]` | `#e5e7eb` | Card borders, dividers |
| `gray[3]` | `#d1d5db` | Input borders |
| `gray[5]` | `#6b7280` | Tertiary text, labels |
| `gray[6]` | `#4b5563` | Secondary text |
| `gray[9]` | `#111827` | Primary text, headings |

### Semantic Colors

- **Success**: bg `#ecfed7`, text `#228403`
- **Warning**: bg `#fff4e6`, text `#f97316`
- **Error**: bg `#ffe7f2`, text `#e11d48`
- **Info**: bg `rgba(99,102,241,0.1)`, text `indigo[5]`

### Rules

- Backgrounds: white for content surfaces, `gray[0]` for page chrome
- Text on white: `gray[9]` for primary, `gray[6]` for secondary
- Maintain **4.5:1** minimum contrast ratio (WCAG AA)
- Use Mantine theme props (`c="gray.6"`, `bg="gray.0"`), not inline hex

---

## Typography

### Font Stack

```
Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
```

Defined in `theme.ts` — never override the font family in components.

### Scale (from theme.ts)

| Token | Size | Usage |
|-------|------|-------|
| `xs` | 12px | Metadata, timestamps, small labels |
| `sm` | 14px | Body text, nav items, primary content |
| `md` | 16px | Emphasized body, form labels |
| `lg` | 18px | Section headings |
| `xl` | 20px | Page section titles |

For large metrics/numbers, use inline `fz={28}` or `fz={32}` with `fw={600}`.

### Weight Rules

- **400 (Regular)** — body text, descriptions, default
- **500 (Medium)** — buttons, active nav, emphasis
- **600 (Semibold)** — card titles, section headers, metric values, page titles
- **700 (Bold)** — avoid; use 600 instead for a cleaner look

### Letter Spacing

- Large numbers (28px+): `-0.01em` for tighter feel
- Uppercase labels: `0.5px` wider for readability
- Body text: default (no modification)

---

## Spacing & Layout

### Base Grid

All spacing follows a **4px base unit** via Mantine's spacing tokens:

| Token | Value | Usage |
|-------|-------|-------|
| `xs` | 10px | Tight gaps, inline spacing |
| `sm` | 12px | Small padding, icon margins |
| `md` | 16px | Standard padding, card spacing |
| `lg` | 20px | Section padding, large gaps |
| `xl` | 32px | Page section spacing |

### Layout Structure

- **Sidebar**: 240px fixed width (Mantine AppShell.Navbar), hidden on mobile
- **Header**: 60px fixed height
- **Content area**: flexible, padding `xl` (32px)
- **Card grid**: `SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}` with `spacing="lg"`

### Border Radius (from theme.ts)

| Token | Value | Usage |
|-------|-------|-------|
| `xs` | 2px | Micro elements |
| `sm` | 4px | Badges, small elements |
| `md` | 6px | Buttons, inputs, nav items |
| `lg` | 8px | Cards |
| `xl` | 12px | Large containers |

### Shadows (from theme.ts)

| Token | Usage |
|-------|-------|
| `xs` | Subtle, barely visible |
| `sm` | Cards at rest |
| `md` | Elevated cards, dropdowns |
| `lg` | Modals |
| `xl` | Overlays |

---

## Component Guidelines

### Use Mantine, Not Raw HTML

```tsx
// Correct
<Stack gap="md">
  <Text size="xl" fw={600}>Title</Text>
  <Group justify="space-between">
    <Button variant="filled">Primary</Button>
    <Button variant="outline">Secondary</Button>
  </Group>
</Stack>

// Wrong — no raw divs with inline styles
```

### Buttons

- **Primary** (`variant="filled"`): `brand[9]` bg, white text — one per view
- **Secondary** (`variant="outline"`): white bg, `gray[3]` border
- **Subtle** (`variant="subtle"`): transparent bg, text-colored
- Sizing: `size="sm"` (compact), `size="md"` (standard)

### Cards

- `bg="white"`, `radius="lg"` (8px), `p="lg"` (20px)
- Border: `1px solid var(--mantine-color-gray-2)`
- Footer divider: top border only with `pt="md"` and `mt="lg"`

### Forms

- Use `useForm` from `@mantine/form` for validation
- Use `useDisclosure` for modal state
- Show loading with `<Skeleton />` components, not spinners
- User feedback via `notifications.show()`

### Icons

- Source: `@tabler/icons-react`
- Sizes: 16px (small actions), 20px (medium), 24px (large headers)
- Always inherit color via `currentColor`

### Data Fetching

- Use Apollo Client hooks (`useQuery`, `useMutation`)
- Loading: `<Skeleton />` placeholders matching content shape
- Errors: `<Text c="red">`

---

## Accessibility

### WCAG 2.1 AA Compliance

- **Color contrast**: 4.5:1 for normal text, 3:1 for large text
- **Keyboard navigation**: all interactive elements must be focusable and operable
- **Focus indicators**: visible outline on `:focus-visible`, suppressed on mouse click
- **Semantic HTML**: use `<nav>`, `<main>`, `<button>` vs generic `<div>`
- **ARIA labels**: required on icon-only buttons (`aria-label="Settings"`)
- **Decorative icons**: `aria-hidden="true"` on icons next to text labels

### Focus Style

```tsx
// Mantine handles this by default, but for custom elements:
// outline: 2px solid rgba(99, 102, 241, 0.3), outline-offset: 2px
```

### Screen Readers

- Use `VisuallyHidden` from Mantine for screen-reader-only text
- Dynamic content: `role="status"` with `aria-live="polite"`
- Progress indicators: `role="progressbar"` with `aria-valuenow`

---

## Responsive Design

### Breakpoints

| Name | Width | Target |
|------|-------|--------|
| `base` | 0px+ | Mobile (375px reference) |
| `sm` | 768px+ | Tablet |
| `md` | 992px+ | Small desktop |
| `lg` | 1200px+ | Desktop (1440px reference) |
| `xl` | 1408px+ | Large desktop |

### Responsive Props

```tsx
<SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing={{ base: "sm", md: "lg" }}>
<Box p={{ base: "md", lg: "xl" }}>
```

### Mobile Adaptations

- Sidebar collapses via AppShell `breakpoint="sm"`
- Card grid stacks to single column
- Reduce padding (`xl` to `md`)
- Scale down heading sizes

---

## Motion & Interaction

### Transitions

- **Duration**: 150-200ms for hover/focus, 300ms for layout changes
- **Easing**: browser default (`ease`)
- **Properties**: `background`, `border-color`, `opacity` — avoid animating `width`/`height`

### Philosophy

Motion should be **subtle and purposeful**:
- Hover: background color shift to `gray[0]`
- Active nav: tinted background with brand color at 10% opacity
- Toggle switches: smooth slide (200ms)
- No bouncing, pulsing, or decorative animation

### Micro-Interactions (Optional)

- Button press: `transform: scale(0.98)` on `:active` (100ms)
- Card entrance: `opacity 0→1, translateY 8px→0` (300ms, ease-out)

---

## Naming Conventions

### Files

- Components: `PascalCase.tsx` (`SiteCard.tsx`, `CallMetrics.tsx`)
- Hooks: `camelCase.ts` prefixed with `use` (`useSiteData.ts`)
- Utilities: `camelCase.ts` (`formatCurrency.ts`)
- CSS modules: `ComponentName.module.css`

### Component Props

- Boolean props: `is`/`has` prefix (`isLoading`, `hasError`)
- Callbacks: `on` prefix (`onSubmit`, `onClose`)
- Children slots: descriptive names (`leftSection`, `rightSection`)

### Theme Tokens

Always reference via Mantine's token system:

```tsx
// Colors: "colorName.shade"
c="gray.9"  bg="gray.0"  color="brand.5"

// Spacing: named tokens
p="md"  gap="lg"  m="sm"

// Radius and shadow: named tokens
radius="lg"  shadow="sm"
```

---

## Checklist

Use this before finalizing any UI implementation:

### Visual Quality
- [ ] Uses Mantine components (not raw HTML/divs with inline styles)
- [ ] Uses theme tokens (not hardcoded colors, spacing, or font sizes)
- [ ] Visual hierarchy: clear primary/secondary/tertiary text levels
- [ ] Consistent spacing following the 4px grid
- [ ] Font weights: 500 or 600 only (no 700)
- [ ] Border radius proportional to element size

### Functionality
- [ ] Loading states with `<Skeleton />`
- [ ] Error states with clear messaging
- [ ] Empty states with helpful guidance
- [ ] Form validation with `useForm`
- [ ] Modal state with `useDisclosure`
- [ ] User feedback with `notifications`

### Responsiveness
- [ ] Works at mobile (375px), tablet (768px), desktop (1440px)
- [ ] Responsive props on grid/layout components
- [ ] Sidebar collapses on mobile

### Accessibility
- [ ] Keyboard navigable (Tab, Enter, Escape)
- [ ] Focus indicators visible on `:focus-visible`
- [ ] Color contrast >= 4.5:1 for text
- [ ] Icon-only buttons have `aria-label`
- [ ] Semantic HTML elements used

### Polish
- [ ] Hover states on all interactive elements
- [ ] Transitions are 150-300ms, subtle
- [ ] No console errors
- [ ] Icons from `@tabler/icons-react` with consistent sizing
- [ ] Original design respected (if mockup provided)
