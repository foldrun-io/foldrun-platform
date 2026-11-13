---
transport: script
name: video
run: run.mjs
# Rendering runs a headless browser and an encoder for minutes: no clock
# shorter than half an hour, and a large sandbox (`size: large`) is advised.
timeout: 1800
# What the program reaches: the npm registry for the project's packages
# (on the trusted list already) and Remotion's browser download (remotion.media).
network: [registry.npmjs.org, remotion.media]
runtime:
  # The libraries Remotion's headless browser needs on Debian
  # (remotion.dev/docs/miscellaneous/linux-dependencies, 13 Nov 2026).
  system: [libnss3, libdbus-1-3, libatk1.0-0, libgbm-dev, libasound2, libxrandr2, libxkbcommon-dev, libxfixes3, libxcomposite1, libxdamage1, libatk-bridge2.0-0, libpango-1.0-0, libcairo2, libcups2]
description: >
  Motion graphics and video written as React code (Remotion), rendered to a
  file. action= picks one.
  new: start a project from foldrun's template — a title card with a logo
  reveal, Persian and English text, 1920x1080 at 30 fps — for you to edit.
  compositions: the videos a project defines, with size, frame rate and length.
  still: one frame as a PNG — check a design before rendering it all.
  render: the whole video (or frames=) to MP4, WebM, GIF or ProRes, with
  props= for the composition's input.
  Write the scenes in the project's src/; this tool installs, bundles and
  renders them. Rendering is CPU-bound: preview with still first.
args:
  action: "new | compositions | still | render"
  project: "The project folder (default workspace/storage/video). new creates it; the others read it"
  composition: "(still, render) The composition's id, as compositions lists it. Unset: the project's only one"
  props: "(compositions, still, render) Optional — the composition's input props, as a JSON object: {\"title\": \"Salam\"}"
  frame: "(still) Which frame, from 0 (default 0)"
  frames: "(render) Optional — a range to render, 0-89, or one frame"
  codec: "(render) h264 (MP4, default) | h265 | vp8 | vp9 (WebM) | gif | prores"
  out: "(still, render) Optional — the file to write. Default: out/<composition>.<ext> in the project"
  scale: "(still, render) Optional — 0.5 renders at half size, 2 at double (default 1)"
  concurrency: "(render) Optional — frames rendered at once (default: half the CPUs)"
---

Video as code. A project is a small React app whose components draw one
frame at a time from `useCurrentFrame()`; the tool bundles it and renders
every frame in a headless browser, then encodes them.

```
video action=new project=workspace/storage/video/launch
# edit workspace/storage/video/launch/src/Intro.tsx, then:
video action=still project=workspace/storage/video/launch frame=45
video action=render project=workspace/storage/video/launch props={"title":"Launch day"}
```

The first call in a project installs its packages (a minute or two) and
Remotion's browser; later calls reuse them. Animate with `interpolate()` and
`spring()` from `remotion`, never CSS transitions or `setTimeout` — a frame
must look the same however often it is rendered. Put images, fonts and
audio in `public/` and load them with `staticFile()`; nothing is fetched
from the internet at render time. The `motion-video` skill has the rest.

**Licence.** Remotion is free for individuals and companies of up to three
people; a larger company that renders with it needs a Remotion Company
License (remotion.pro/license). The account whose agents render is the
licensee — foldrun runs the code, it does not license Remotion to you.
