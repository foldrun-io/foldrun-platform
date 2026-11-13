---
name: modern-website
description: Build a modern, high-end website or web app — picks the framework (Astro for content sites, Next.js for apps, when the person has not said), the current stack, design and motion, and the checks a launch-ready site passes. Use for any request to make, redesign or extend a website, landing page, marketing site, blog, docs site, store front or web app.
license: FSL-1.1-ALv2
metadata:
  maintainer: foldrun
  checked: "2026-11-13"
---

# Building a modern website

What good looks like: a site a design-led agency would ship. Fast on a
phone, readable, accessible, every asset bundled, nothing broken, and a
look of its own rather than a template's.

## 1. Choose the framework

Use what the person named. When they named nothing:

| The site is mostly… | Use | Why |
|---|---|---|
| content: a landing page, marketing site, portfolio, blog, docs, a brochure for a business | **Astro** | ships no JavaScript by default, islands where interaction is needed, content collections for posts and pages |
| an application: accounts, dashboards, a store with carts and checkout, forms that save, anything per-user | **Next.js** (App Router) | React server components, route handlers, server actions, middleware |

Mixed? A marketing site with a small app part is still Astro (an island or
an endpoint); an app with a few marketing pages is still Next.js. Never
both in one project. Versions and the rest of the stack are in
`references/stack.md`: read it before you install anything.

## 2. Look things up, do not remember them

Frameworks change every few months. Before you write config or call an API
you have not used in this run, ask the `docs` tool:

```
docs action=get library=astro query="content collections with the glob loader" version=7
docs action=get library=next.js query="generateMetadata and opengraph-image" version=16
docs action=get library=tailwindcss query="v4 @theme tokens and dark mode"
```

When `docs` has nothing, read the project's own docs with `web
action=fetch`. Use `web action=search` to find a library for a need ("a
headless carousel for React"), then check its licence, last release and
weekly downloads before adding it.

## 3. Start the project

- Astro: `npm create astro@latest <dir> -- --template minimal --typescript strict --install --no-git --yes`
- Next.js: `npx create-next-app@latest <dir> --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm --yes`

Then add Tailwind v4 to Astro (`npx astro add tailwind --yes`), and the
pieces from `references/stack.md` the site needs. Commit the lockfile.

## 4. Design

- **Decide the look first**, in three lines you write down: the mood, the
  type pair, the colour palette (one accent, neutrals, a dark variant).
  Put them in CSS variables / Tailwind `@theme` tokens; components read
  tokens, never raw hex.
- **Type**: a real type scale (`clamp()` for fluid sizes), 60-75
  characters a line, generous line height. Self-host every font
  (Fontsource packages, Astro's Fonts API, `next/font`): no font CDN link.
- **Layout**: mobile first, a 4/8 px spacing scale, a max content width,
  real whitespace. One idea per section on a landing page: hero, proof,
  features, social proof, call to action, footer.
- **Images**: modern formats (AVIF/WebP) through Astro's `<Image>` or
  `next/image`, explicit width and height, `alt` on every one, lazy below
  the fold. Photos the person did not supply: say they are placeholders.
- **Motion**: small and purposeful — entrance on scroll, hover states, a
  smooth page transition. `motion` (React) or CSS; GSAP for timelines;
  Lenis only when the design calls for smooth scrolling. Always honour
  `prefers-reduced-motion`. A video or animated hero: the `motion-video`
  skill and the `video` tool render one.
- **Persian, Arabic or any right-to-left language**: `dir="rtl"` and `lang`
  on `<html>`, logical CSS properties (`margin-inline-start`, `ps-4`),
  mirrored icons where direction matters, Vazirmatn
  (`@fontsource-variable/vazirmatn`) unless the person chose another.
  Persian numerals and dates through `Intl` with `fa-IR`.

## 5. Every asset is bundled

No `<script src="https://cdn…">`, no Google Fonts `<link>`, no icon font
from a CDN, no image hot-linked from another site. Everything comes from
npm at build time or sits in the project's `public/`. A site that loads
from a third-party host breaks wherever that host is slow or blocked, and
leaks its visitors to it.

## 6. Finish to the bar

Before you say it is done, run every check in `references/quality.md`:
the build, types, lint, the pages in a real browser at phone and desktop
width (`web action=browse` with `mode=screenshot` and `vitals`/`a11y`),
links, metadata and Open Graph, a 404 page, favicons, `robots.txt` and a
sitemap. Report what you checked and what you could not.

## 7. Deploying

Deploying is the host's business: follow the skill for the host the
workspace deploys to (`cloudhost-deploy` for cloudhost). Without one, leave
a project that builds with `npm run build` and say where its output is.
