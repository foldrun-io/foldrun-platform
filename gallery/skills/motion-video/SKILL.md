---
name: motion-video
description: Make motion graphics and short videos as React code with Remotion and the `video` tool — product intros, animated heroes for a website, social clips, explainer scenes, title cards, data animations, in Persian or English. Use when asked for a video, an animation to export, a reel, a GIF, or a looping hero background.
license: FSL-1.1-ALv2
metadata:
  maintainer: foldrun
  checked: "2026-11-13"
---

# Motion video with Remotion

A Remotion video is a React component drawn once per frame. You write the
scenes; the `video` tool installs, bundles and renders them.

## The loop

1. `video action=new project=workspace/storage/video/<name>` — a working
   project with one composition (`intro`, 1920x1080, 30 fps, 5 s).
2. Plan the video before code: its length, the scenes and how long each
   holds (in frames: seconds × fps), the type, the palette, the motion
   style. Write the plan as a comment at the top of `src/Root.tsx`.
3. Write scenes in `src/` — one component per scene, put in order with
   `<Series>` or `<Sequence from={…} durationInFrames={…}>`.
4. `video action=still … frame=<n>` at the key moments of every scene, and
   **look at each PNG** (Read it). Fix, repeat. Stills are seconds; renders
   are minutes.
5. `video action=render …` once the stills are right. `props=` changes the
   text and colours without touching code; `codec=vp9` for a web hero
   (WebM), `gif` for a short loop, `h264` (default) for everything else.

## Rules a frame must keep

- **Everything from `useCurrentFrame()`.** Animate with `interpolate()`
  (always with `extrapolateLeft/Right: "clamp"`) and `spring()`. Never CSS
  transitions or animations, `setTimeout`, `Date.now()` or `Math.random()`
  (use `random(seed)` from `remotion`). Frames render out of order and in
  parallel: the same frame must always draw the same picture.
- **Every asset is local.** Images, fonts, audio and video go in `public/`
  and load with `staticFile("logo.svg")`. Fonts from npm (`@fontsource-
  variable/<family>`) or `@remotion/fonts` with a file in `public/`. Nothing
  is fetched from the internet at render time.
- `<Img>`, `<Video>` (or `<OffthreadVideo>`), `<Audio>` from `remotion`,
  never the plain tags — they wait for the asset before the frame is taken.
- Data an animation needs: `calculateMetadata` on the `<Composition>`, or
  props — not a `fetch` inside a component.

## Making it look expensive

- **Easing**: springs (`damping` 12-20) for things that arrive; `Easing.
  bezier(0.16, 1, 0.3, 1)` for slides; nothing moves linearly except time.
- **Stagger**: delay each element of a group by 3-6 frames.
- **Hold**: let a finished state sit for at least 1 s before the next scene.
- **Type**: big, few words per screen, one weight contrast. Persian text
  `dir="rtl"`, Vazirmatn (already in the template).
- **Depth**: soft shadows, a subtle gradient or grain, motion blur
  (`@remotion/motion-blur`) on fast moves — sparingly: blur and shadows
  render slowly on a machine with no GPU.
- **Sound**: `<Audio src={staticFile("music.mp3")} volume={…}>` with a fade
  out at the end; only audio the person supplied or that is licensed for it.
- Sizes: 1920x1080 landscape, 1080x1920 for reels and stories, 1080x1080
  square. One `<Composition>` per size, sharing the same scene components.

## Video on a website

For a hero or background: render `codec=vp9` (WebM) and `codec=h264` (MP4
fallback) at the size it is shown, keep it under ~3 MB, put both in the
site's `public/`, and use `<video autoplay muted loop playsinline
poster="…">` with a still as the poster. Honour `prefers-reduced-motion`
(show the poster). For an interactive animation in a React page, the
`@remotion/player` component plays a composition live (a Company License
covers embedding it).

## Licence

Remotion is free for individuals and companies of up to three people.
Above that the account's owner needs a Remotion Company License
(remotion.pro/license) before using renders commercially. Say so when
handing over a video for a company.

## When stuck

`docs action=get library=remotion query="<what you are doing>"` for the
current API. Remotion's own agent skills (`npx skills add
remotion-dev/skills`) go further on specific effects.
