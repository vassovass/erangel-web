import { defineConfig } from 'vite';

// Dev-server config for the characters lane's review page ONLY.
//
// Several visual streams edit this working tree at the same time. A stock vite
// dev server watches the whole repo, so another lane saving src/ui/minimap.ts
// pushes a full-reload to my page — and a full reload lands mid-run, destroys
// puppeteer's execution context and kills the capture. That is not theoretical:
// it killed two consecutive cycle-4 runs, twelve seconds apart, on files this
// lane does not own and never imports.
//
// Turning HMR off is enough and is all that is turned off. The WATCHER has to
// stay: vite invalidates its module graph from watcher events, so muting the
// watcher as well (the obvious first move) makes the server serve stale
// modules forever and a capture silently re-shoots the previous cycle's build —
// which it did here, producing a byte-identical metrics run after a real code
// change. hmr:false stops the client reload; the watcher still invalidates.
export default defineConfig({
  server: { hmr: false },
  build: { target: 'es2022' },
});
