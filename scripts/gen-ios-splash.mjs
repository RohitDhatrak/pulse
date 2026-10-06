// iOS launch screens (apple-touch-startup-image) for every iPhone and iPad, portrait and landscape, light and dark,
// made by pwa-asset-generator from scripts/pwa/lockup-{light,dark}.svg. Run: node scripts/gen-ios-splash.mjs
// Writes the images to public/splash and their <link> media queries to src/app/launch-screens.json (read by layout.tsx).
// Needs the network once: pnpm dlx fetches the generator and it fetches a headless Chrome.
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const VERSION = "8.1.7"
// The lockup is 32% of the screen's short side (124 pt of a 393 pt iPhone), on the page ground of each scheme.
const PADDING = "0 calc(50vw - 16vmin)"
const SCHEMES = [
  { name: "light", background: "#f6f8f9", flags: [] },
  { name: "dark", background: "#101518", flags: ["--dark-mode"] },
]

const tmp = mkdtempSync(join(tmpdir(), "pulse-splash-"))
rmSync("public/splash", { recursive: true, force: true })
const screens = []
for (const s of SCHEMES) {
  const index = join(tmp, `${s.name}.html`)
  writeFileSync(index, "<!doctype html><html><head></head><body></body></html>")
  execFileSync(
    "pnpm",
    ["dlx", `pwa-asset-generator@${VERSION}`, `scripts/pwa/lockup-${s.name}.svg`, "public/splash", "--splash-only", ...s.flags,
      "--background", s.background, "--padding", PADDING, "--type", "png", "--index", index, "--path-override", "/splash", "--log", "false"],
    { stdio: "inherit" },
  )
  for (const [, url, media] of readFileSync(index, "utf8").matchAll(/<link rel="apple-touch-startup-image" href="([^"]+)" media="([^"]+)">/g))
    // Light first with no colour scheme, then dark with (prefers-color-scheme: dark): the order iOS needs to pick the dark
    // image in dark mode (pwa-asset-generator issue #51). A light set that names its scheme kept iOS on light.
    screens.push({ url, media })
}
rmSync(tmp, { recursive: true, force: true })
writeFileSync("src/app/launch-screens.json", JSON.stringify(screens, null, 2) + "\n")
console.log(`${screens.length} launch screens`)
