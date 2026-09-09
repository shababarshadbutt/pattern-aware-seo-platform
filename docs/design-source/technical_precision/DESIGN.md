---
name: Technical Precision
colors:
  surface: '#13121b'
  surface-dim: '#13121b'
  surface-bright: '#393842'
  surface-container-lowest: '#0e0d16'
  surface-container-low: '#1b1b24'
  surface-container: '#1f1f28'
  surface-container-high: '#2a2933'
  surface-container-highest: '#35343e'
  on-surface: '#e4e1ee'
  on-surface-variant: '#c7c4d8'
  inverse-surface: '#e4e1ee'
  inverse-on-surface: '#302f39'
  outline: '#918fa1'
  outline-variant: '#464555'
  surface-tint: '#c3c0ff'
  primary: '#c3c0ff'
  on-primary: '#1d00a5'
  primary-container: '#4f46e5'
  on-primary-container: '#dad7ff'
  inverse-primary: '#4d44e3'
  secondary: '#c3c0ff'
  on-secondary: '#2a276a'
  secondary-container: '#413f82'
  on-secondary-container: '#b0aef9'
  tertiary: '#ffb695'
  on-tertiary: '#571f00'
  tertiary-container: '#a44100'
  on-tertiary-container: '#ffd2be'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#e2dfff'
  primary-fixed-dim: '#c3c0ff'
  on-primary-fixed: '#0f0069'
  on-primary-fixed-variant: '#3323cc'
  secondary-fixed: '#e2dfff'
  secondary-fixed-dim: '#c3c0ff'
  on-secondary-fixed: '#140f54'
  on-secondary-fixed-variant: '#413f82'
  tertiary-fixed: '#ffdbcc'
  tertiary-fixed-dim: '#ffb695'
  on-tertiary-fixed: '#351000'
  on-tertiary-fixed-variant: '#7b2f00'
  background: '#13121b'
  on-background: '#e4e1ee'
  surface-variant: '#35343e'
typography:
  display-sm:
    fontFamily: Geist
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.02em
  headline-sm:
    fontFamily: Geist
    fontSize: 18px
    fontWeight: '600'
    lineHeight: 24px
    letterSpacing: -0.01em
  body-md:
    fontFamily: Geist
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-sm:
    fontFamily: Geist
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
  data-mono:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: '450'
    lineHeight: 16px
  label-xs:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 12px
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 4px
  container-margin: 24px
  gutter: 12px
  component-padding-x: 12px
  component-padding-y: 6px
---

## Brand & Style

This design system is engineered for high-performance SEO workflows where data density and technical clarity are paramount. The brand personality is **intelligent, technical, and precise**, favoring a "tool-first" aesthetic that prioritizes information over decoration.

The visual direction draws from **modern developer tools and professional financial terminals**. It utilizes a **Minimalist-Technical** style, characterized by structural rigidity, thin borders, and a restricted color palette. The interface must feel exceptionally fast and responsive, evoking a sense of sophisticated control for power users who manage complex data sets.

## Colors

The color strategy uses a **Deep Charcoal (#09090B)** foundation to reduce eye strain during long-term data analysis. **Deep Indigo (#4F46E5)** is the primary action color, used sparingly to signify intent and progression.

Background surfaces utilize subtle shifts in luminosity to create hierarchy rather than shadows. 
- **Surface Primary:** #09090B (Main background)
- **Surface Secondary:** #18181B (Sidebars, cards, headers)
- **Surface Tertiary:** #27272A (Input fields, hover states)

Semantic colors are highly saturated to ensure instant recognizability against the dark background, essential for monitoring SEO health metrics.

## Typography

Typography is divided into two functional roles: **System UI** and **Technical Data**. 

**Geist** is used for all UI controls, navigation, and instructional text, providing a clean, neutral canvas. **JetBrains Mono** is reserved for URLs, status codes, numerical metrics, and code snippets. 

To maintain high density, the base font size is set to 14px for body text and 13px for data tables. Tabular numerals must be enabled in the monospace font to ensure vertical alignment of numbers in audit reports.

## Layout & Spacing

The layout follows a **Strict Fluid Grid** model that maximizes screen real estate. It uses a 4px baseline grid to ensure mathematical precision in element alignment.

- **Desktop:** 12-column grid, 12px gutters, 24px outer margins.
- **Sidebars:** Fixed width at 240px to maximize the central data workspace.
- **Density:** Elements are tightly packed with minimal vertical padding (6px for standard rows) to allow as much data as possible to be visible above the fold.

Layout transitions between modules should be instant. Reflow logic for tablet devices prioritizes the "Data Table" view, collapsing secondary sidebars into icon-only rails.

## Elevation & Depth

This design system eschews shadows in favor of **Tonal Layering and 1px Borders**. 

Depth is communicated through brightness: background layers are darkest, while active or floating elements (like tooltips) are slightly lighter. 
- **Borders:** 1px solid #27272A is the standard separator.
- **Active State:** Use a 1px #4F46E5 border to indicate focus or selection.
- **Modals:** Use a subtle 10% white border rather than a heavy shadow to define the edge against the dark backdrop.

## Shapes

The shape language is **geometric and sharp**. A low corner radius of 4px is applied to all buttons, inputs, and card containers. This "Soft" (Level 1) setting provides a hint of modernity while maintaining the rigid, professional feel of an engineering tool. Larger components like main content areas may use 6px (rounded-lg) for very subtle distinction.

## Components

### Buttons
- **Primary:** Solid #4F46E5 background, white text, 4px radius.
- **Secondary:** Transparent background, 1px #27272A border, Geist Medium.
- **Ghost:** No background or border, used for utility actions in dense tables.

### Data Tables
Tables are the core component of the platform.
- **Header:** Background #18181B, uppercase 11px JetBrains Mono labels.
- **Rows:** 1px bottom border only. Hover state changes background to #18181B.
- **Cells:** Vertical alignment centered. Use monospace for all SEO metrics (DA, DR, Volume).

### Input Fields
- **Default:** Background #09090B, 1px #27272A border.
- **Focus:** 1px #4F46E5 border with 0px glow/shadow.
- **Density:** Compact height (32px) for standard forms.

### Status Badges (Chips)
- Small, rectangular with 2px radius. 
- Use semantic colors for background (10% opacity) and text (100% opacity). Example: "Healthy" uses #10B981 text on a dark green-tinted background.

### Navigation
- **Top Bar:** 48px height, fixed, containing breadcrumbs and global search.
- **Sidebar:** Darker than main content (#09090B), using 13px Geist for links with 16px icons.