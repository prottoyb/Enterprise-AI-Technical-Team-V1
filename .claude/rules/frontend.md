---
paths:
  - "**/*.css"
  - "**/*.scss"
  - "**/*.sass"
  - "**/*.less"
  - "**/*.jsx"
  - "**/*.tsx"
  - "**/*.vue"
  - "**/*.svelte"
  - "**/*.html"
  - "**/*.erb"
  - "**/*.cshtml"
  - "**/*.razor"
  - "**/*.xaml"
  - "**/*.dart"
  - "**/*.swift"
  - "**/components/**"
  - "**/pages/**"
  - "**/views/**"
  - "**/screens/**"
  - "**/layouts/**"
  - "**/styles/**"
  - "**/templates/**"
---

# Frontend and UI Standards

## Behaviour

Every data-driven view handles loading, empty, error and success states. Forms validate on the
client for UX and on the server for trust. Disable double submission, and show clear feedback
after an action. Frontend permission checks are cosmetic: the server decides.

## Accessibility (minimum bar)

- Semantic elements; a label or accessible name on every control; meaningful `alt` text.
- Full keyboard operation with a visible focus indicator.
- WCAG AA contrast (4.5:1 for text, 3:1 for large text and UI components).
- Touch targets of at least 24×24 px.
- Respect `prefers-reduced-motion`.

## Consistency

Use the project's design system, tokens and components. Don't introduce one-off colours, spacing
or new component libraries. Match the existing visual language unless the task is a redesign
(`ui-significant`, which means the product designer writes the specification first).

## Verification

A UI change is verified by seeing it rendered, not by reading code:

- For web apps, use `.claude/tools/ui-capture.mjs` (the `ui-review` skill), or an available
  browser tool, at mobile and desktop widths.
- For native or mobile apps, use the platform's simulator screenshots when available.

If nothing can render it, report the visual result as **Not verified**.
