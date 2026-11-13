# The stack, as of 13 Nov 2026

Versions are the npm `latest` on that day; install with `@latest` and let
the lockfile pin what you got. Ask `docs` for anything you are about to
configure. Licence noted where it is not MIT/ISC/Apache.

## Frameworks

| Package | Version | Use |
|---|---|---|
| `astro` | 7.x | content sites; content collections, Fonts API (fonts downloaded at build), `<Image>`, View Transitions, islands (`client:visible`, `client:idle`, `client:only`) |
| `next` | 16.x | apps; App Router, server components, route handlers, server actions, `next/font` (downloaded at build: no request to a font host from the browser), `next/image` |
| `react` / `react-dom` | 19.x | with Next.js, and for Astro islands (`npx astro add react`) |

## Styling and components

| Package | Version | Use |
|---|---|---|
| `tailwindcss` | 4.x | configured in CSS (`@import "tailwindcss"; @theme { … }`), no `tailwind.config.js` |
| `shadcn` (CLI) | 4.x | copies accessible components into the project (`npx shadcn@latest init`, `add button dialog …`); they are yours to restyle. Works with Next.js and Astro + React |
| `lucide-react` / `@lucide/astro` | latest | icons, tree-shaken |
| `@iconify/react` | 6.x | very large icon sets — bundle the icon data (`@iconify-json/<set>`), never the online API |
| `clsx`, `tailwind-merge` | latest | class names |

## Motion and 3D

| Package | Version | Use |
|---|---|---|
| `motion` | 14.x | React and vanilla animation, scroll-linked effects, layout animation |
| `gsap` | 3.x | timelines, ScrollTrigger, SplitText. **Licence:** GSAP's own "standard no-charge" licence, free for commercial sites; not for building a no-code animation tool that competes with Webflow |
| `lenis` | 1.x | smooth scrolling, only when the design needs it |
| `three` / `@react-three/fiber` / `@react-three/drei` | 0.18x / 9.x | 3D; load lazily, give a static fallback |
| `remotion` | 4.0.x | rendered video and animated heroes — the `video` tool. **Licence:** a Company License from 4 people |

## Content, data and forms

| Package | Version | Use |
|---|---|---|
| Astro content collections | built in | posts, pages, products as Markdown/MDX with a schema |
| `@astrojs/mdx` / `@next/mdx` | latest | MDX |
| `zod` | 4.x | validate every form and API input, on the server too |
| `react-hook-form` | latest | forms in React |

## Fonts

| Package | Use |
|---|---|
| `@fontsource-variable/<family>` | self-hosted variable fonts (Inter, Geist, …) |
| `@fontsource-variable/vazirmatn` | Persian (OFL-1.1) |
| Astro Fonts API / `next/font` | either downloads at build; no browser request to a font host |

## Images

| Package | Use |
|---|---|
| `sharp` | image processing (Astro and Next.js use it) |
| Astro `<Image>` / `<Picture>`, `next/image` | AVIF/WebP, sizes, lazy loading |

Stock photos: download them into `public/` with their credit. Pexels allows
downloads (credit the photographer). Unsplash's API terms require hot-linking
their URLs, which this skill forbids — use it only by downloading under the
Unsplash licence page, not the API.

## Checks

| Package | Use |
|---|---|
| `@playwright/test` | browser tests of the key paths |
| `axe-core` (MPL-2.0) / `@axe-core/playwright` | accessibility in tests |
| `@lhci/cli` | Lighthouse CI budgets |
| `eslint`, `prettier`, `typescript` | as each framework's starter sets them up |

## Agent helpers worth knowing

- `npx shadcn@latest` — search and add from any registry listed in
  `components.json` (`npx shadcn@latest search`, `view`, `add`).
- Magic UI and Aceternity publish animated components in shadcn's format.
  **Aceternity's licence forbids redistributing its source or selling
  templates made from it** — fine inside one customer's site, never in a
  template or starter you hand to others.
