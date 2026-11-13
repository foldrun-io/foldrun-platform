# The launch bar

Run each. A site is done when every line passes, or you said which did not
and why.

## Builds

- [ ] `npm run build` exits 0 with no warnings you did not read.
- [ ] Types: `npx astro check` (Astro) or `npx tsc --noEmit` (Next.js).
- [ ] Lint passes (`npm run lint` where the starter set it up).
- [ ] No secret, key or token in the source; config reads them from the
      environment.

## In a real browser

Serve the build (`npm run preview` / `npm run start`) and open it with
`web action=browse`:

- [ ] Every page at 390 px and 1440 px wide (`device=` or `viewport`), as a
      screenshot you looked at: nothing overflows, nothing overlaps, text
      is readable.
- [ ] `vitals`: LCP under 2.5 s, CLS under 0.1, no long main-thread task on
      load.
- [ ] `a11y`: no serious or critical axe violation; headings in order; every
      control reachable by keyboard with a visible focus ring; colour
      contrast at least 4.5:1 for body text.
- [ ] `console`: no errors.
- [ ] Every internal link answers 200; the 404 page renders for a made-up
      path.
- [ ] Nothing requested from a host other than the site's own (the network
      log in browse): fonts, scripts, images, icons all bundled.

## Metadata

- [ ] `<title>` and `<meta name="description">` per page, `lang` (and `dir`
      for RTL) on `<html>`, a canonical URL.
- [ ] Open Graph and Twitter card tags with a 1200x630 image.
- [ ] Favicons (`favicon.svg`, `apple-touch-icon.png`), a web manifest for an app.
- [ ] `robots.txt` and `sitemap.xml` (`@astrojs/sitemap`, Next.js `sitemap.ts`).
- [ ] Structured data (JSON-LD) where it applies: Organization,
      LocalBusiness, Product, Article, FAQ.

## Content

- [ ] No lorem ipsum. Placeholder copy or images the person must replace
      are listed in your answer.
- [ ] Forms validate on the server, show errors next to the field, and say
      what happens after sending.
- [ ] `prefers-reduced-motion` turns non-essential motion off.
