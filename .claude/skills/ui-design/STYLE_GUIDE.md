# Stripe Dashboard Style Guide

## Table of Contents
1. [Overview](#overview)
2. [Design Principles](#design-principles)
3. [Color Palette](#color-palette)
4. [Typography](#typography)
5. [Spacing System](#spacing-system)
6. [Layout & Grid](#layout--grid)
7. [Component Styles](#component-styles)
8. [Shadows & Elevation](#shadows--elevation)
9. [Border Radius](#border-radius)
10. [Opacity & Transparency](#opacity--transparency)
11. [Icons](#icons)
12. [Animations & Transitions](#animations--transitions)
13. [Interactive States](#interactive-states)
14. [Data Visualization](#data-visualization)
15. [Accessibility](#accessibility)

---

## Overview

This style guide documents the design system used in the Stripe-inspired dashboard. The design emphasizes **clarity, simplicity, and functionality** with a clean, modern aesthetic that prioritizes information density without sacrificing readability.

### Core Philosophy
- **Minimalist**: Clean lines, ample whitespace, subtle borders
- **Functional**: Every element serves a purpose
- **Accessible**: High contrast, readable fonts, clear hierarchy
- **Professional**: Enterprise-grade polish and consistency

---

## Design Principles

### 1. Information Hierarchy
- Use font weight and size to establish importance
- Large metrics (28px) draw attention to key data
- Secondary information uses smaller sizes (12-13px) and gray tones

### 2. Consistent Spacing
- All spacing follows an 4px base unit system
- Vertical rhythm maintained with consistent gaps

### 3. Subtle Depth
- Rely primarily on borders rather than heavy shadows
- Use backgrounds and borders to create layers

### 4. Progressive Disclosure
- Show important information first
- Use hover states to reveal additional actions
- Keep interfaces clean until interaction

---

## Color Palette

### Primary Colors

```css
/* Primary Brand Color */
--primary-500: #ec322b;        /* Main interactive elements (brand[5]) */
--primary-600: #ec271d;        /* Hover states (brand[6]) */
--primary-900: #aa0a0a;        /* Dark variant (brand[9]) */
--primary-alpha-10: rgba(236, 50, 43, 0.1);  /* Backgrounds */
```

**Usage:**
- Active navigation items (background: rgba(236, 50, 43, 0.1), color: #ec322b)
- Primary buttons (background: #aa0a0a for primary shade)
- Links and interactive text
- Brand elements
- Call-to-action buttons

### Neutral Grays

```css
/* Grayscale Palette (from Mantine theme) */
--gray-900: #111827;          /* Primary text, headings (gray[9]) */
--gray-800: #1f2937;          /* (gray[8]) */
--gray-700: #374151;          /* (gray[7]) */
--gray-600: #4b5563;          /* Secondary text (gray[6]) */
--gray-500: #6b7280;          /* Tertiary text, labels (gray[5]) */
--gray-400: #9ca3af;          /* Disabled text, light icons (gray[4]) */
--gray-300: #d1d5db;          /* Borders, dividers (gray[3]) */
--gray-200: #e5e7eb;          /* Light borders (gray[2]) */
--gray-100: #f3f4f6;          /* Borders, light dividers (gray[1]) */
--gray-50:  #f9fafb;          /* Background tints, hover states (gray[0]) */
--white:    #ffffff;          /* Cards, surfaces, backgrounds */
```

**Text Color Hierarchy:**
- **Primary text** (headings, values): `#111827` (gray[9])
- **Secondary text** (body, descriptions): `#4b5563` (gray[6])
- **Tertiary text** (labels, meta): `#6b7280` (gray[5])
- **Disabled/placeholder**: `#9ca3af` (gray[4])

**Border Color Hierarchy:**
- **Strong borders** (dividers): `#e5e7eb` (gray[2])
- **Light borders** (cards): `#f3f4f6` (gray[1])
- **Interactive borders** (inputs, buttons): `#d1d5db` (gray[3])

**Background Hierarchy:**
- **Page background**: `#f9fafb` (gray[0])
- **Card/surface**: `#ffffff`
- **Hover state**: `#f9fafb` (gray[0])

### Accent Colors

```css
/* Accent Color */
--accent-500: #20f0d0;      /* Main accent (accent[5]) */
--accent-600: #1ad4b7;      /* Hover states (accent[6]) */
--accent-400: #4bf5dd;      /* Light variant (accent[4]) */
--accent-alpha-10: rgba(32, 240, 208, 0.1);  /* Backgrounds */

/* Indigo - Interactive Elements */
--indigo-500: #6366f1;        /* Interactive elements (indigo[5]) */
--indigo-600: #4f46e5;        /* Hover states (indigo[6]) */
--indigo-700: #4338ca;        /* Active states (indigo[7]) */
```

### Semantic Colors

```css
/* Success/Positive */
--success-bg:   #ecfed7;      /* Badge background */
--success-text: #228403;      /* Badge text, positive indicators */

/* Data Visualization Colors */
--chart-red:     #ec322b;     /* Primary metric line (brand) */
--chart-accent: #20f0d0;    /* Secondary metrics (accent) */
--chart-indigo:  #6366f1;     /* Tertiary metrics (indigo) */
--chart-orange:  #f97316;     /* Warning/attention metrics */
--chart-gray:    #6b7280;     /* Neutral metrics */
```

**Color Application Rules:**

1. **Backgrounds**: Always white (#ffffff) for content cards, gray[0] (#f9fafb) for page background
2. **Text on white**: Use gray[9] (#111827) for readability
3. **Text on colored backgrounds**: Ensure 4.5:1 contrast ratio minimum
4. **Interactive elements**: brand[9] (#aa0a0a) for primary actions, indigo[5] (#6366f1) for secondary
5. **Hover states**: Use gray[0] (#f9fafb) background or darken primary colors

### Color Usage Matrix

| Element Type | Default | Hover | Active | Disabled |
|--------------|---------|-------|--------|----------|
| **Primary Button** | bg: brand[9], text: white | bg: brand[6] | bg: brand[6] | bg: gray[3], text: gray[4] |
| **Secondary Button** | bg: white, border: gray[3] | bg: gray[0] | bg: gray[0] | bg: gray[0], text: gray[4] |
| **Text Link** | color: indigo[5] | underline | underline | color: gray[4] |
| **Nav Item** | color: gray[9] | bg: gray[0] | bg: rgba(236,50,43,0.1), color: brand[5] | - |
| **Card** | bg: white, border: gray[2] | - | - | - |
| **Input** | border: gray[2] | border: gray[2] | border: indigo[5] | bg: gray[0] |

---

## Typography

### Font Stack

```css
/* Inter - Modern, professional sans-serif */
font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
```

**Why Inter:**
- Modern, highly readable sans-serif designed for screens
- Professional appearance matching Linear, Stripe, Vercel
- Excellent legibility at all sizes
- Widely used in modern SaaS applications
- System fonts as fallback

### Type Scale

```css
/* Font Sizes */
--text-xs:     11px;    /* Section titles (uppercase), fine print */
--text-sm:     12px;    /* Metadata, timestamps, small labels */
--text-base:   13px;    /* Buttons, controls, select menus */
--text-md:     14px;    /* Body text, nav items, primary content */
--text-lg:     28px;    /* Metric values, key numbers */
--text-xl:     32px;    /* Page titles, main headings */
```

### Font Weights

```css
/* Font Weights */
--font-regular:   400;  /* Body text, descriptions */
--font-medium:    500;  /* Buttons, active nav, emphasis */
--font-semibold:  600;  /* Card titles, section headers, metric values */
--font-bold:      700;  /* Logo, rarely used */
```

### Typography Patterns

#### 1. Page Title
```css
.page-title {
    font-size: 32px;
    font-weight: 600;      /* Semibold for professional look */
    color: #30313d;
    margin-bottom: 24px;
    line-height: 1.2;
}
```

#### 2. Card Title
```css
.card-title {
    font-size: 14px;
    font-weight: 600;
    color: #30313d;
    line-height: 1.5;
}
```

#### 3. Metric Value
```css
.metric-value {
    font-size: 28px;
    font-weight: 600;      /* Heavy weight for emphasis */
    color: #30313d;
    line-height: 1.2;
    letter-spacing: -0.01em;  /* Tighter spacing for large numbers */
}
```

#### 4. Section Title (Sidebar)
```css
.nav-section-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    color: #87909f;
    letter-spacing: 0.5px;   /* Wider spacing for caps */
    line-height: 1.5;
}
```

#### 5. Body Text / Nav Items
```css
.nav-item {
    font-size: 14px;
    font-weight: 400;      /* Regular for non-active */
    color: #30313d;
    line-height: 1.5;
}

.nav-item.active {
    font-weight: 500;      /* Medium for active state */
    color: #667eea;
}
```

#### 6. Buttons
```css
.btn {
    font-size: 13px;
    font-weight: 400;      /* Regular weight keeps buttons light */
    line-height: 1.5;
}
```

#### 7. Small Labels / Metadata
```css
.footer-text, .metric-subtitle {
    font-size: 12px;
    font-weight: 400;
    color: #87909f;       /* Gray for de-emphasis */
    line-height: 1.5;
}
```

#### 8. Badge / Change Indicator
```css
.metric-change {
    font-size: 13px;
    font-weight: 500;      /* Medium for slight emphasis */
    color: #228403;
    line-height: 1;
}
```

### Line Height Rules

- **Headings** (page title, metrics): `1.2` - Tighter for visual impact
- **Body text** (nav, cards, buttons): `1.5` - Standard readable spacing
- **Small text** (metadata): `1.5` - Consistent with body
- **Single-line elements** (badges): `1` - Minimal spacing

### Letter Spacing

- **Default**: `0` (browser default)
- **Large numbers** (metrics): `-0.01em` to `-0.02em` - Slightly tighter
- **Uppercase labels**: `0.5px` - Wider for readability
- **Never use letter-spacing on body text**

### Typography Combinations

#### Primary Combination (Card with Metric)
```html
<h3 style="font: 600 14px/1.5">Gross volume</h3>
<div style="font: 600 28px/1.2">$2,217.50</div>
<p style="font: 400 12px/1.5; color: #87909f">$650.50 previous period</p>
```

#### Secondary Combination (Section Navigation)
```html
<h4 style="font: 600 11px/1.5; text-transform: uppercase; color: #87909f">SHORTCUTS</h4>
<a style="font: 400 14px/1.5; color: #30313d">Apps</a>
<a style="font: 500 14px/1.5; color: #667eea">Connect overview</a>  <!-- Active -->
```

---

## Spacing System

### Base Unit: 4px

All spacing follows a **4px base grid** for consistency and rhythm.

```css
/* Spacing Scale */
--space-1:  4px;      /* Tight spacing, inline gaps */
--space-2:  8px;      /* Small padding, icon margins */
--space-3:  12px;     /* Medium gaps, button padding */
--space-4:  16px;     /* Standard padding, card spacing */
--space-5:  20px;     /* Section padding, large gaps */
--space-6:  24px;     /* Card/component margins */
--space-8:  32px;     /* Page section spacing */
```

### Spacing Application

#### 1. Component Internal Padding
```css
/* Sidebar (Mantine AppShell.Navbar) */
.sidebar {
    padding: 12px 8px;          /* Compact: 12px vertical, 8px horizontal */
}

/* Card */
.card {
    padding: 20px;              /* space-5 */
}

/* Button */
.btn {
    padding: 6px 12px;          /* Asymmetric: tighter vertical */
}

/* Header */
.header {
    padding: 0 20px;            /* Horizontal only */
}

/* Nav item */
.nav-item {
    padding: 0 8px;             /* Horizontal only, 32px fixed height */
    height: 32px;
}
```

#### 2. Gaps Between Elements

```css
/* Navigation sections */
margin: 1px 0;                  /* Between nav items */
padding: 16px 8px 4px;          /* Section label spacing */

/* Card grid */
gap: 20px;                      /* Between cards */

/* Control groups in header */
gap: 12px;                      /* Between related controls */
gap: 16px;                      /* Between action buttons */

/* Payment breakdown items */
margin-bottom: 12px;            /* Between line items */
```

#### 3. Margin System

```css
/* Page elements */
.page-title {
    margin-bottom: 24px;        /* Large breathing room */
}

.controls {
    margin-bottom: 24px;        /* Standard section gap */
}

/* Section titles in sidebar */
.nav-section-title {
    padding: 16px 8px 4px;      /* Top, horizontal, bottom */
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
}

/* Metric components */
.metric-value {
    margin-bottom: 4px;         /* Tight coupling with subtitle */
}

.metric-subtitle {
    margin-bottom: 16px;        /* Before chart */
}

.chart {
    margin-bottom: 16px;        /* Before footer */
}
```

#### 4. Icon Spacing

```css
/* Icon next to text */
.nav-icon {
    margin-right: 12px;         /* Icon → Text gap */
}

/* Icon in button */
.btn svg {
    margin-left: 6px;           /* Text → Icon gap (smaller) */
    /* or */
    margin-right: 6px;          /* Icon → Text gap in button */
}

/* Info icon next to title */
.card-title svg {
    margin-left: 6px;           /* Tight coupling */
}
```

### Spacing Patterns by Context

#### Sidebar Navigation (Mantine AppShell.Navbar)
```text
├─ Container padding: 12px 8px
├─ Width: 240px (desktop), hidden on mobile (AppShell overlay)
├─ Logo area padding: 0 8px 12px (bottom gap)
├─ Section label padding: 16px 8px 4px
├─ Nav item height: 32px, padding: 0 8px, gap: 8px
├─ Nav item margin: 1px 0 (between items)
├─ Bottom section: border-top, padding-top: 8px, margin-top: 4px
└─ Mobile: collapsed via AppShell breakpoint='sm'
```

#### Card Component
```text
├─ Card padding: 20px (all sides)
├─ Header margin-bottom: 16px
├─ Metric margin-bottom: 8px
├─ Subtitle margin-bottom: 16px
├─ Chart margin-bottom: 16px
└─ Footer margin-top: 20px, padding-top: 16px
```

#### Header Bar
```text
├─ Container height: 60px
├─ Horizontal padding: 20px
├─ Control groups gap: 12px
└─ Icon buttons gap: 16px
```

### Responsive Spacing

For smaller screens, reduce spacing proportionally:

```css
/* Mobile adjustments (< 768px) */
@media (max-width: 768px) {
    .sidebar { padding: 16px; }        /* 20px → 16px */
    .card { padding: 16px; }           /* 20px → 16px */
    .content { padding: 20px; }        /* 32px → 20px */
    .grid { gap: 16px; }               /* 20px → 16px */
}
```

---

## Layout & Grid

### Overall Structure

```text
┌─────────────────────────────────────────────────┐
│  Header (60px fixed height)                     │
├──────────┬──────────────────────────────────────┤
│          │                                       │
│ Sidebar  │  Main Content                        │
│ (240px)  │  (Flex: 1)                           │
│          │                                       │
│  Fixed   │  ├─ Page Title                       │
│  Width   │  ├─ Controls Bar                     │
│          │  └─ Card Grid (3 columns)            │
│          │                                       │
└──────────┴──────────────────────────────────────┘
```

### Layout Specifications

```css
/* App Container */
.app {
    display: flex;
    height: 100vh;              /* Full viewport height */
}

/* Sidebar */
.sidebar {
    width: 240px;               /* Fixed width */
    flex-shrink: 0;             /* Don't shrink */
    overflow-y: auto;           /* Scroll if content overflows */
}

/* Main Content Wrapper */
.main-content {
    flex: 1;                    /* Take remaining space */
    display: flex;
    flex-direction: column;
    overflow: auto;             /* Enable scrolling */
}

/* Header */
.header {
    height: 60px;               /* Fixed height */
    flex-shrink: 0;             /* Don't shrink */
}

/* Content Area */
.content {
    flex: 1;                    /* Take remaining space */
    padding: 32px;              /* Consistent padding */
}
```

### Card Grid System

```css
/* 3-Column Grid */
.grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);  /* Equal columns */
    gap: 20px;                              /* Uniform gap */
}

/* Responsive Breakpoints */
@media (max-width: 1200px) {
    .grid {
        grid-template-columns: repeat(2, 1fr);  /* 2 columns */
    }
}

@media (max-width: 768px) {
    .grid {
        grid-template-columns: 1fr;  /* Single column */
    }

    /*
     * Sidebar hidden via Mantine AppShell:
     *   navbar={{ width: 240, breakpoint: 'sm', collapsed: { mobile: true } }}
     */
}
```

### Content Max-Width

```css
/* No max-width constraint - content fills available space */
/* Cards naturally constrain through grid system */
.content {
    max-width: none;  /* Full width usage */
}
```

---

## Component Styles

### Navigation Items

```css
.nav-item {
    display: flex;
    align-items: center;
    padding: 8px 12px;
    border-radius: 6px;
    cursor: pointer;
    color: #30313d;
    text-decoration: none;
    margin-bottom: 4px;
    transition: background 0.2s;
    font-size: 14px;
    font-weight: 400;
}

.nav-item:hover {
    background: #f6f8fa;
}

.nav-item.active {
    background: rgba(102, 126, 234, 0.1);
    color: #667eea;
    font-weight: 500;
}

.nav-icon {
    width: 18px;
    height: 18px;
    margin-right: 12px;
}
```

**States:**
- **Default**: Gray text, transparent background
- **Hover**: Light gray background (#f6f8fa)
- **Active**: Purple tinted background, purple text, medium weight

### Buttons

#### Primary Button (Icon Button)
```css
.icon-button.primary {
    width: 32px;
    height: 32px;
    border: none;
    background: #667eea;
    color: white;
    border-radius: 6px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.2s;
}

.icon-button.primary:hover {
    background: #5568d3;
}
```

#### Secondary Button
```css
.btn {
    padding: 6px 12px;
    border: 1px solid #d5dbe1;
    background: white;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    transition: all 0.2s;
}

.btn:hover {
    background: #f6f8fa;
}

.btn svg {
    width: 14px;
    height: 14px;
}
```

#### Small Button (Explore)
```css
.explore-btn {
    padding: 4px 10px;
    border: 1px solid #d5dbe1;
    background: white;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 4px;
}

.explore-btn svg {
    width: 12px;
    height: 12px;
}
```

**Button Size Scale:**
- **Large**: padding: 10px 16px, font-size: 14px
- **Medium**: padding: 6px 12px, font-size: 13px
- **Small**: padding: 4px 10px, font-size: 12px
- **Icon**: width/height: 32px, icon: 20px

### Cards

```css
.card {
    background: white;
    border: 1px solid #ebeef1;
    border-radius: 8px;
    padding: 20px;
}

.card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
}

.card-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 14px;
    font-weight: 600;
}

.card-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 20px;
    padding-top: 16px;
    border-top: 1px solid #ebeef1;
}
```

**Card Anatomy:**
1. **Border**: 1px solid #ebeef1 (subtle)
2. **Background**: Pure white
3. **Border radius**: 8px (friendly, modern)
4. **Padding**: 20px uniform
5. **Footer divider**: Top border only

### Input Fields

```css
.search-box {
    width: 400px;
    padding: 8px 12px 8px 36px;  /* Left padding for icon */
    border: 1px solid #ebeef1;
    border-radius: 6px;
    font-size: 14px;
    background: url("data:image/svg+xml,...") no-repeat 12px center;
}

.search-box::placeholder {
    color: #87909f;
}

.search-box:focus {
    outline: none;
    border-color: #667eea;
}
```

### Toggle Switch

```css
.toggle {
    width: 40px;
    height: 22px;
    background: #d5dbe1;      /* Default: gray */
    border-radius: 11px;       /* Pill shape */
    cursor: pointer;
    position: relative;
    transition: background 0.2s;
}

.toggle.active {
    background: #667eea;       /* Active: purple */
}

.toggle-handle {
    width: 18px;
    height: 18px;
    background: white;
    border-radius: 50%;
    position: absolute;
    top: 2px;
    left: 2px;
    transition: left 0.2s;
}

.toggle.active .toggle-handle {
    left: 20px;               /* Slide to right */
}
```

**Toggle Specifications:**
- Total width: 40px
- Total height: 22px
- Handle size: 18px
- Handle margin: 2px
- Handle travel: 18px (2px start → 20px end)

### Badges

```css
.metric-change {
    display: inline-block;
    background: #ecfed7;       /* Light green */
    color: #228403;            /* Dark green */
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 13px;
    font-weight: 500;
    margin-left: 8px;
}
```

**Badge Variants:**
```css
/* Success/Positive */
.badge-success {
    background: #ecfed7;
    color: #228403;
}

/* Warning */
.badge-warning {
    background: #fff4e6;
    color: #f97316;
}

/* Error */
.badge-error {
    background: #ffe7f2;
    color: #e11d48;
}

/* Info */
.badge-info {
    background: rgba(102, 126, 234, 0.1);
    color: #667eea;
}
```

### Dividers

```css
/* Horizontal Divider */
.divider {
    border: none;
    border-top: 1px solid #ebeef1;
    margin: 16px 0;
}

/* Footer Divider (built into component) */
.card-footer {
    border-top: 1px solid #ebeef1;
    padding-top: 16px;
    margin-top: 20px;
}

/* Sidebar Bottom Section */
.sidebar-footer {
    padding-top: 8px;
    border-top: 1px solid var(--mantine-color-gray-1);
    margin-top: 4px;
    flex-shrink: 0;
}
```

### Data Lists (Payment Breakdown)

```css
.payment-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
}

.payment-label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
}

.payment-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
}

.payment-value {
    font-weight: 600;
    font-size: 14px;
}
```

**Color-coded dots:**
- Purple (#7c3aed): Primary/success metrics
- Blue (#3b82f6): Secondary metrics
- Cyan (#06b6d4): Tertiary metrics
- Orange (#f97316): Warning metrics
- Red (#e11d48): Error/failed metrics

---

## Shadows & Elevation

### Philosophy
**Minimal shadows** - Rely on borders and background color changes for depth instead of heavy drop shadows.

```css
/* No box-shadow used on cards */
.card {
    border: 1px solid #ebeef1;  /* Border defines edges */
    background: white;          /* White on gray creates depth */
}

/* No box-shadow on buttons */
.btn {
    border: 1px solid #d5dbe1;  /* Border defines button */
}

/* Focus state - subtle outline */
.search-box:focus,
.btn:focus {
    outline: none;
    border-color: #667eea;      /* Change border instead of shadow */
}
```

### If Shadows Were Added (Optional Enhancement)

```css
/* Subtle elevation for cards */
.card {
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);  /* Barely visible */
}

.card:hover {
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);  /* Slightly elevated */
}

/* Focus shadow for inputs */
.search-box:focus {
    box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
}

/* Dropdown shadows */
.dropdown {
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
}
```

### Elevation Levels (If Using Shadows)

| Level | Usage | Box Shadow |
|-------|-------|------------|
| **0** | Flat elements | none |
| **1** | Cards (default) | 0 1px 3px rgba(0,0,0,0.04) |
| **2** | Buttons, cards (hover) | 0 2px 8px rgba(0,0,0,0.08) |
| **3** | Dropdowns, modals | 0 4px 16px rgba(0,0,0,0.12) |
| **4** | Tooltips, overlays | 0 8px 24px rgba(0,0,0,0.16) |

---

## Border Radius

```css
/* Border Radius Scale */
--radius-sm:  4px;      /* Small elements (badges, payment bar) */
--radius-md:  6px;      /* Buttons, inputs, nav items */
--radius-lg:  8px;      /* Cards */
--radius-xl:  12px;     /* Large containers */
--radius-full: 50%;     /* Circles (dots, toggle handle) */
--radius-pill: 999px;   /* Pills/toggle track */
```

### Application

```css
/* Logo */
.logo {
    border-radius: 4px;
}

/* Badge */
.metric-change {
    border-radius: 4px;
}

/* Payment bar */
.payment-bar {
    border-radius: 4px;
}

/* Buttons */
.btn,
.icon-button,
.explore-btn,
.search-box,
.nav-item {
    border-radius: 6px;
}

/* Cards */
.card {
    border-radius: 8px;
}

/* Dots */
.payment-dot {
    border-radius: 50%;
}

/* Toggle track */
.toggle {
    border-radius: 11px;  /* (height 22px / 2) = pill shape */
}

/* Toggle handle */
.toggle-handle {
    border-radius: 50%;
}
```

**Design Principle**: Smaller elements get smaller radius, larger elements get larger radius. Maintains visual hierarchy and proportion.

---

## Opacity & Transparency

### Opacity Values

```css
/* Common opacity values */
--opacity-0:   0;      /* Hidden */
--opacity-10:  0.1;    /* Active nav background */
--opacity-60:  0.6;    /* Disabled text */
--opacity-100: 1;      /* Default */
```

### Usage

```css
/* Active navigation background */
.nav-item.active {
    background: rgba(102, 126, 234, 0.1);  /* 10% opacity purple */
}

/* Disabled elements */
.btn:disabled {
    opacity: 0.6;
}

/* Hover overlay (if implemented) */
.card::before {
    opacity: 0;
    transition: opacity 0.2s;
}

.card:hover::before {
    opacity: 0.05;
}
```

### RGBA vs Opacity

**Use RGBA for:**
- Background colors with transparency
- Border colors with transparency
- Overlays and tints

**Use opacity property for:**
- Fading entire elements
- Disabled states
- Hover effects on groups

```css
/* RGBA - Better for colored backgrounds */
background: rgba(102, 126, 234, 0.1);

/* Opacity - Better for element state */
opacity: 0.6;
```

---

## Icons

### Icon System

**Source**: Inline SVG using Feather Icons style (24x24 viewBox)

```html
<!-- Standard icon size: 18px (nav items) -->
<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
     stroke="currentColor" stroke-width="2">
    <path d="..."/>
</svg>

<!-- Large icon size: 20px (header buttons) -->
<svg width="20" height="20" viewBox="0 0 24 24" fill="none"
     stroke="currentColor" stroke-width="2">
    <path d="..."/>
</svg>

<!-- Small icon size: 14px (buttons) -->
<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
     stroke="currentColor" stroke-width="2">
    <path d="..."/>
</svg>

<!-- Tiny icon size: 12px (small buttons) -->
<svg width="12" height="12" viewBox="0 0 24 24" fill="none"
     stroke="currentColor" stroke-width="2">
    <path d="..."/>
</svg>
```

### Icon Sizes

| Size | Usage | Dimensions |
|------|-------|------------|
| **Tiny** | Small buttons, inline text | 12px |
| **Small** | Buttons, badges | 14px |
| **Medium** | Navigation, cards | 16px |
| **Base** | Navigation, primary actions | 18px |
| **Large** | Header actions | 20px |
| **XL** | Feature illustrations | 24px |

### Icon Color Inheritance

```css
/* Icons inherit text color via currentColor */
svg {
    stroke: currentColor;  /* Automatically matches parent text color */
}

/* Example: Purple nav item = purple icon */
.nav-item.active {
    color: #667eea;
}

.nav-item.active svg {
    stroke: currentColor;  /* Becomes #667eea */
}
```

### Icon Stroke Weight

```svg
<!-- Standard stroke weight: 2 -->
stroke-width="2"

<!-- Thicker for emphasis (not used) -->
stroke-width="2.5"

<!-- Thinner for delicate icons (not used) -->
stroke-width="1.5"
```

**Consistency Rule**: All icons use `stroke-width="2"` for uniform visual weight.

### Common Icons

```html
<!-- Home -->
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
    <polyline points="9 22 9 12 15 12 15 22"/>
</svg>

<!-- Search -->
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <circle cx="11" cy="11" r="8"/>
    <path d="m21 21-4.35-4.35"/>
</svg>

<!-- Plus -->
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <line x1="12" y1="5" x2="12" y2="19"/>
    <line x1="5" y1="12" x2="19" y2="12"/>
</svg>

<!-- Chevron Down -->
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <polyline points="6 9 12 15 18 9"/>
</svg>

<!-- Info Circle -->
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <circle cx="12" cy="12" r="10"/>
    <line x1="12" y1="16" x2="12" y2="12"/>
    <line x1="12" y1="8" x2="12.01" y2="8"/>
</svg>

<!-- Eye -->
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
    <circle cx="12" cy="12" r="3"/>
</svg>
```

---

## Animations & Transitions

### Transition Duration

```css
/* Standard duration for all transitions */
--transition-fast: 0.15s;
--transition-base: 0.2s;
--transition-slow: 0.3s;
```

**Default**: `0.2s` for most interactions

### Easing Functions

```css
/* Use browser defaults */
--easing-default: ease;        /* Generic, works for most */
--easing-in: ease-in;          /* Accelerate */
--easing-out: ease-out;        /* Decelerate */
--easing-in-out: ease-in-out;  /* Smooth start and end */
```

**Default**: No easing function specified (browser uses `ease`)

### Common Transitions

```css
/* Background color change (hover states) */
transition: background 0.2s;

/* All properties (buttons) */
transition: all 0.2s;

/* Multiple properties */
transition: background 0.2s, border-color 0.2s;

/* Toggle handle position */
transition: left 0.2s;

/* Opacity fade */
transition: opacity 0.2s;
```

### Interactive State Transitions

#### 1. Navigation Hover
```css
.nav-item {
    transition: background 0.2s;
}

.nav-item:hover {
    background: #f6f8fa;
}
```

#### 2. Button Hover
```css
.btn {
    transition: all 0.2s;  /* Background and border */
}

.btn:hover {
    background: #f6f8fa;
}
```

#### 3. Toggle Switch
```css
.toggle {
    transition: background 0.2s;
}

.toggle-handle {
    transition: left 0.2s;
}
```

#### 4. Icon Button
```css
.icon-button {
    transition: background 0.2s;
}

.icon-button:hover {
    background: #f6f8fa;
}

.icon-button.primary {
    transition: background 0.2s;
}

.icon-button.primary:hover {
    background: #5568d3;
}
```

### No Animations

The current design **does not include**:
- Loading spinners
- Skeleton screens
- Page transitions
- Slide-in panels
- Animated charts
- Pulsing elements
- Bouncing effects

**Philosophy**: Keep it simple. Motion should be subtle and purposeful.

### If Adding Micro-Interactions

```css
/* Scale on click */
.btn:active {
    transform: scale(0.98);
    transition: transform 0.1s;
}

/* Fade in cards on load */
.card {
    animation: fadeIn 0.3s ease-out;
}

@keyframes fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
}

/* Pulse notification badge */
.notification-dot {
    animation: pulse 2s infinite;
}

@keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
}
```

---

## Interactive States

### State Priority

1. **Default** - Resting state
2. **Hover** - Mouse over
3. **Focus** - Keyboard navigation / clicked input
4. **Active** - Being clicked / selected
5. **Disabled** - Not interactive

### Navigation Item States

```css
/* Default */
.nav-item {
    color: #30313d;
    background: transparent;
    font-weight: 400;
}

/* Hover */
.nav-item:hover {
    background: #f6f8fa;
}

/* Active (selected page) */
.nav-item.active {
    background: rgba(102, 126, 234, 0.1);
    color: #667eea;
    font-weight: 500;
}

/* Active + Hover */
.nav-item.active:hover {
    background: rgba(102, 126, 234, 0.15);  /* Slightly darker */
}
```

### Button States

```css
/* Default */
.btn {
    background: white;
    border: 1px solid #d5dbe1;
    color: #30313d;
}

/* Hover */
.btn:hover {
    background: #f6f8fa;
}

/* Focus (keyboard navigation) */
.btn:focus {
    outline: none;
    border-color: #667eea;
}

/* Active (being clicked) */
.btn:active {
    background: #ebeef1;
}

/* Disabled */
.btn:disabled {
    background: #f6f8fa;
    color: #c0c8d2;
    border-color: #ebeef1;
    cursor: not-allowed;
}
```

### Input States

```css
/* Default */
.search-box {
    border: 1px solid #ebeef1;
    background: white;
}

/* Focus */
.search-box:focus {
    outline: none;
    border-color: #667eea;
}

/* Disabled */
.search-box:disabled {
    background: #f6f8fa;
    color: #c0c8d2;
    cursor: not-allowed;
}

/* Error (if implemented) */
.search-box.error {
    border-color: #e11d48;
}
```

### Link States

```css
/* Default */
.footer-link {
    color: #667eea;
    text-decoration: none;
}

/* Hover */
.footer-link:hover {
    text-decoration: underline;
}

/* Visited (not styled - same as default) */
.footer-link:visited {
    color: #667eea;
}

/* Focus */
.footer-link:focus {
    outline: 2px solid rgba(102, 126, 234, 0.3);
    outline-offset: 2px;
}
```

### Toggle States

```css
/* Default (off) */
.toggle {
    background: #d5dbe1;
}

.toggle-handle {
    left: 2px;
}

/* Active (on) */
.toggle.active {
    background: #667eea;
}

.toggle.active .toggle-handle {
    left: 20px;
}

/* Hover */
.toggle:hover {
    cursor: pointer;
}

/* Disabled */
.toggle:disabled {
    background: #ebeef1;
    cursor: not-allowed;
}
```

### State Color Matrix

| Element | Default | Hover | Active | Disabled |
|---------|---------|-------|--------|----------|
| **Nav background** | transparent | #f6f8fa | rgba(102,126,234,0.1) | - |
| **Nav text** | #30313d | #30313d | #667eea | - |
| **Button bg** | white | #f6f8fa | #ebeef1 | #f6f8fa |
| **Button border** | #d5dbe1 | #d5dbe1 | #d5dbe1 | #ebeef1 |
| **Button text** | #30313d | #30313d | #30313d | #c0c8d2 |
| **Primary btn bg** | #667eea | #5568d3 | #5568d3 | #d5dbe1 |
| **Input border** | #ebeef1 | #ebeef1 | #667eea | #ebeef1 |
| **Link text** | #667eea | #667eea | #667eea | #c0c8d2 |
| **Toggle bg** | #d5dbe1 | #d5dbe1 | #667eea | #ebeef1 |

---

## Data Visualization

### Chart Specifications

#### Line Chart
```css
.chart {
    height: 150px;
    position: relative;
}

.chart svg {
    width: 100%;
    height: 100%;
}
```

#### Chart Grid
```svg
<!-- Horizontal grid lines -->
<line x1="0" y1="120" x2="300" y2="120"
      stroke="#f0f0f0" stroke-width="1"/>
<line x1="0" y1="90" x2="300" y2="90"
      stroke="#f0f0f0" stroke-width="1"/>
<line x1="0" y1="60" x2="300" y2="60"
      stroke="#f0f0f0" stroke-width="1"/>
<line x1="0" y1="30" x2="300" y2="30"
      stroke="#f0f0f0" stroke-width="1"/>
```

**Grid specs:**
- Color: #f0f0f0 (very light gray)
- Width: 1px
- Spacing: Evenly distributed
- Vertical lines: Not used (cleaner look)

#### Chart Line
```svg
<polyline
    fill="none"
    stroke="#7c3aed"
    stroke-width="2"
    points="0,130 30,115 60,80 90,90 120,55 150,20 180,40 210,25 240,60 270,90 300,130"
/>
```

**Line specs:**
- Color: #7c3aed (purple)
- Width: 2px
- Style: Solid (no dashing)
- Fill: None (line only, no area fill)
- Points: Comma-separated x,y coordinates

#### Reference Line
```svg
<!-- Vertical dashed line for current/special date -->
<line x1="150" y1="0" x2="150" y2="150"
      stroke="#ddd" stroke-width="1" stroke-dasharray="3,3"/>
```

**Reference line specs:**
- Color: #ddd (light gray)
- Width: 1px
- Style: Dashed (3px dash, 3px gap)
- Purpose: Highlight specific data point

### Color-Coded Elements

#### Payment Dots
```css
.payment-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
}
```

**Colors:**
- Succeeded: `#7c3aed` (purple)
- Uncaptured: `#3b82f6` (blue)
- Refunded: `#06b6d4` (cyan)
- Blocked: `#f97316` (orange)
- Failed: `#e11d48` (red)

#### Progress Bar
```css
.payment-bar {
    height: 16px;
    background: #7c3aed;  /* Single color for 100% success */
    border-radius: 4px;
    margin-bottom: 24px;
}
```

**Multi-segment bar (if showing breakdown):**
```html
<div class="payment-bar">
    <div style="width: 90%; background: #7c3aed;"></div>
    <div style="width: 5%; background: #06b6d4;"></div>
    <div style="width: 5%; background: #e11d48;"></div>
</div>
```

### Tooltip (Not Implemented)

**If adding tooltips to charts:**
```css
.chart-tooltip {
    position: absolute;
    background: white;
    border: 1px solid #ebeef1;
    border-radius: 6px;
    padding: 8px 12px;
    font-size: 12px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    pointer-events: none;
}

.chart-tooltip-title {
    font-weight: 600;
    margin-bottom: 4px;
}

.chart-tooltip-value {
    font-size: 14px;
    font-weight: 600;
    color: #7c3aed;
}

.chart-tooltip-date {
    font-size: 11px;
    color: #87909f;
}
```

### Data Formatting

```javascript
// Currency
function formatCurrency(value) {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2
    }).format(value);
}
// Output: $2,217.50

// Percentage
function formatPercentage(value) {
    return `+${value}%`;
}
// Output: +241%

// Large numbers
function formatLargeNumber(value) {
    if (value >= 1000000) {
        return `${(value / 1000000).toFixed(1)}M`;
    }
    if (value >= 1000) {
        return `${(value / 1000).toFixed(1)}K`;
    }
    return value.toString();
}
// Output: 2.2K, 1.5M
```

---

## Accessibility

### Keyboard Navigation

```css
/* Visible focus indicator */
.btn:focus,
.nav-item:focus {
    outline: 2px solid rgba(102, 126, 234, 0.3);
    outline-offset: 2px;
}

/* Remove outline for mouse users (optional) */
.btn:focus:not(:focus-visible),
.nav-item:focus:not(:focus-visible) {
    outline: none;
}
```

### Color Contrast

**WCAG AA Compliance** (4.5:1 for normal text, 3:1 for large text)

✅ **Passing combinations:**
- #30313d on white (12.6:1)
- #87909f on white (4.7:1)
- #667eea on white (4.8:1)
- White on #667eea (4.8:1)

⚠️ **Borderline:**
- #c0c8d2 on white (3.1:1) - Only for disabled states

### Semantic HTML

```html
<!-- Use semantic elements -->
<nav aria-label="Main navigation">
    <a href="#" class="nav-item">Home</a>
</nav>

<main>
    <h1>Your overview</h1>
</main>

<!-- Buttons vs Links -->
<button>Add</button>          <!-- Action -->
<a href="#">View all</a>      <!-- Navigation -->

<!-- Icon-only buttons need labels -->
<button aria-label="Settings">
    <svg>...</svg>
</button>
```

### Screen Reader Support

```html
<!-- Informative icons -->
<svg aria-hidden="true">...</svg>  <!-- Decorative, hide from SR -->
<span class="sr-only">Info</span>  <!-- Text for SR only -->

<!-- Skip link -->
<a href="#main-content" class="skip-link">Skip to main content</a>

<!-- Dynamic content -->
<div role="status" aria-live="polite">
    Updated 4 minutes ago
</div>

<!-- Progress indicators -->
<div role="progressbar" aria-valuenow="75" aria-valuemin="0" aria-valuemax="100">
    <div style="width: 75%"></div>
</div>
```

### Screen Reader Only Class

```css
.sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
}
```

### Focus Management

```javascript
// Trap focus in modal
const modal = document.querySelector('.modal');
const focusableElements = modal.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled])'
);

const firstElement = focusableElements[0];
const lastElement = focusableElements[focusableElements.length - 1];

modal.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
        if (e.shiftKey && document.activeElement === firstElement) {
            lastElement.focus();
            e.preventDefault();
        } else if (!e.shiftKey && document.activeElement === lastElement) {
            firstElement.focus();
            e.preventDefault();
        }
    }
});
```

---

## Example Component Reference

### Complete Card Component

```html
<div class="card">
    <!-- Header -->
    <div class="card-header">
        <div class="card-title">
            Gross volume
            <svg class="info-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="16" x2="12" y2="12"/>
                <line x1="12" y1="8" x2="12.01" y2="8"/>
            </svg>
        </div>
        <button class="explore-btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                <circle cx="12" cy="12" r="3"/>
            </svg>
            Explore
        </button>
    </div>

    <!-- Metric -->
    <div style="margin-bottom: 8px;">
        <span class="metric-value">$2,217.50</span>
        <span class="metric-change">+241%</span>
    </div>
    <div class="metric-subtitle">$650.50 previous period</div>

    <!-- Chart -->
    <div class="chart">
        <svg viewBox="0 0 300 150" preserveAspectRatio="none">
            <!-- Grid lines -->
            <line x1="0" y1="120" x2="300" y2="120" stroke="#f0f0f0" stroke-width="1"/>
            <line x1="0" y1="90" x2="300" y2="90" stroke="#f0f0f0" stroke-width="1"/>
            <line x1="0" y1="60" x2="300" y2="60" stroke="#f0f0f0" stroke-width="1"/>
            <line x1="0" y1="30" x2="300" y2="30" stroke="#f0f0f0" stroke-width="1"/>

            <!-- Chart line -->
            <polyline fill="none" stroke="#7c3aed" stroke-width="2"
                      points="0,130 30,115 60,80 90,90 120,55 150,20 180,40 210,25 240,60 270,90 300,130"/>

            <!-- Reference line -->
            <line x1="150" y1="0" x2="150" y2="150" stroke="#ddd" stroke-width="1" stroke-dasharray="3,3"/>
        </svg>
    </div>

    <!-- Footer -->
    <div class="footer-text">Updated 4 minutes ago</div>
</div>
```

### Complete Button Group

```html
<div class="controls-left">
    <div class="control-group">
        <span class="control-label">Date range</span>
        <button class="btn">
            Nov 1, 2025 → Dec 14, 2025
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="6 9 12 15 18 9"/>
            </svg>
        </button>
    </div>

    <button class="btn">
        Daily
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9"/>
        </svg>
    </button>

    <button class="btn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="16" x2="12" y2="12"/>
            <line x1="12" y1="8" x2="12.01" y2="8"/>
        </svg>
        Compare
    </button>
</div>
```

### Complete Navigation Section

```html
<div>
    <div class="nav-section-title">Shortcuts</div>
    <a href="#" class="nav-item">
        <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="7" height="7"/>
            <rect x="14" y="3" width="7" height="7"/>
            <rect x="14" y="14" width="7" height="7"/>
            <rect x="3" y="14" width="7" height="7"/>
        </svg>
        Apps
    </a>
    <a href="#" class="nav-item active">
        <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
        </svg>
        Connect overview
    </a>
</div>
```

### Complete Payment List

```html
<div class="payment-bar"></div>

<div class="payment-item">
    <div class="payment-label">
        <div class="payment-dot" style="background: #7c3aed;"></div>
        Succeeded
    </div>
    <div class="payment-value">$2,217.50</div>
</div>

<div class="payment-item">
    <div class="payment-label">
        <div class="payment-dot" style="background: #3b82f6;"></div>
        Uncaptured
    </div>
    <div class="payment-value">$0.00</div>
</div>

<div class="card-footer">
    <span class="footer-text">Updated yesterday</span>
    <a href="#" class="footer-link">View all</a>
</div>
```

---

## Design Tokens

**All design tokens (colors, spacing, typography, etc.) are defined in:**

**`src/theme.ts`**

This file contains the complete Mantine theme configuration with:
- **Colors**: `theme.colors.brand`, `theme.colors.gray`, `theme.colors.accent`, `theme.colors.indigo`
- **Spacing**: `theme.spacing` (xs, sm, md, lg, xl)
- **Typography**: `theme.fontSizes`, `theme.lineHeights`
- **Radius**: `theme.radius` (xs, sm, md, lg, xl)
- **Shadows**: `theme.shadows` (xs, sm, md, lg, xl)

Use Mantine component props to access theme values:

```tsx
import { Box } from '@mantine/core';

<Box
  c="gray.9"        // Color
  bg="white"        // Background
  p="md"            // Padding
  radius="md"       // Border radius
  shadow="sm"       // Shadow
/>
```

---

## Responsive Design

### Breakpoints

```css
/* Mobile first approach */
:root {
    --breakpoint-sm: 640px;   /* Mobile landscape */
    --breakpoint-md: 768px;   /* Tablet portrait */
    --breakpoint-lg: 1024px;  /* Tablet landscape */
    --breakpoint-xl: 1280px;  /* Desktop */
}
```

### Mobile Adaptations

```css
/* Tablet and below */
@media (max-width: 1024px) {
    .grid {
        grid-template-columns: repeat(2, 1fr);
    }

    /* Sidebar stays 240px — Mantine AppShell handles it */
}

/* Mobile (Mantine 'sm' breakpoint = 768px) */
@media (max-width: 768px) {
    .grid {
        grid-template-columns: 1fr;
    }

    .content {
        padding: 20px;
    }

    .card {
        padding: 16px;
    }

    .page-title {
        font-size: 24px;
    }

    .metric-value {
        font-size: 24px;
    }

    /*
     * Sidebar is hidden on mobile via Mantine AppShell:
     *   navbar={{ width: 240, breakpoint: 'sm', collapsed: { mobile: true } }}
     * No CSS slide-in needed — AppShell handles collapse/overlay.
     */

    .header {
        padding: 0 16px;
    }

    .search-box {
        width: 100%;
        max-width: 300px;
    }
}

/* Small mobile */
@media (max-width: 480px) {
    .controls {
        flex-direction: column;
        align-items: flex-start;
    }

    .controls-left {
        flex-wrap: wrap;
    }

    .header-actions {
        gap: 8px;
    }

    .test-mode {
        display: none;  /* Hide on very small screens */
    }
}
```

---

## Best Practices

### 1. Consistency
- Use design tokens (CSS custom properties) throughout
- Maintain spacing rhythm (4px grid)
- Consistent border radius per element size
- Uniform transition durations

### 2. Performance
- Avoid expensive CSS properties (box-shadow, filter)
- Use `transform` for animations (GPU accelerated)
- Minimize repaints with `will-change` sparingly
- Optimize SVG paths

### 3. Maintainability
- Organize CSS by component
- Use BEM or similar naming convention
- Document custom properties
- Comment complex calculations

### 4. Accessibility
- Maintain 4.5:1 color contrast
- Provide focus indicators
- Use semantic HTML
- Support keyboard navigation
- Add ARIA labels where needed

### 5. Progressive Enhancement
- Works without JavaScript
- Graceful degradation
- Mobile-first responsive design
- Print-friendly styles

---

## Print Styles

```css
@media print {
    /* Hide navigation and controls */
    .sidebar,
    .header,
    .controls,
    .btn,
    .icon-button {
        display: none;
    }

    /* Expand main content */
    .main-content {
        width: 100%;
    }

    /* Optimize cards for printing */
    .grid {
        display: block;
    }

    .card {
        page-break-inside: avoid;
        margin-bottom: 20px;
        border: 1px solid #000;
    }

    /* High contrast for printing */
    body {
        background: white;
        color: black;
    }

    /* Remove backgrounds */
    .metric-change {
        background: transparent;
        border: 1px solid #000;
    }
}
```

---

## Dark Mode (Future Enhancement)

```css
/* Dark mode color tokens */
@media (prefers-color-scheme: dark) {
    :root {
        --color-bg-page: #1a1b25;
        --color-bg-surface: #30313d;
        --color-bg-hover: #414552;

        --color-text-primary: #ebeef1;
        --color-text-secondary: #c0c8d2;
        --color-text-disabled: #687385;

        --color-border: #414552;
        --color-border-strong: #545969;

        /* Keep primary colors the same */
        --color-primary: #7c73ff;  /* Slightly lighter for dark bg */
    }
}
```

---

This style guide provides a complete reference for the Stripe dashboard design system. Use it as a source of truth when building new components or extending the design.
