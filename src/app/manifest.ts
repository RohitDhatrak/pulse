import type { MetadataRoute } from "next";

const shot = (name: string, sizes: string, form_factor: "narrow" | "wide", label: string) => ({
  src: `/screenshots/${name}.webp`,
  sizes,
  type: "image/webp",
  form_factor,
  label,
});

// Icon URLs carry ?v=: Android's install service and the launcher cache icons by URL, so a changed picture needs a new one. Bump it with the pictures.
const V = "6";
const icon = (file: string, size: number, purpose: "any" | "maskable") => ({ src: `/icons/${file}.png?v=${V}`, sizes: `${size}x${size}`, type: "image/png", purpose });
// Glyphs in deep brand tones on transparent: Android draws shortcut icons on the launcher's own grey disc, not as adaptive icons.
const shortcutIcons = (name: string) => [icon(`shortcut-${name}`, 192, "any")];

// Open to signed-out visitors (src/proxy.ts skips files with an extension), so install works from /login.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    // Short on purpose: Android draws the name under the icon on its launch screen, in the system font.
    name: "Pulse",
    short_name: "Pulse",
    description: "Recovery, strain and sleep from your Fitbit Air.",
    lang: "en",
    dir: "ltr",
    categories: ["health", "fitness", "lifestyle"],
    start_url: "/",
    scope: "/",
    display: "standalone",
    // Standalone first wherever display_override is read, before falling back to display.
    display_override: ["standalone"],
    orientation: "portrait",
    // A second launch (a shortcut, a notification) reuses the open window instead of stacking another.
    launch_handler: { client_mode: "navigate-existing" },
    // The launch screen on Android is this colour with the "any" icon centred, so the two must match.
    background_color: "#101518",
    // Matches viewport.themeColor (layout.tsx), the top of the page ground, so the installed app's bar never changes colour on load.
    theme_color: "#1d2529",
    icons: [
      // Mark only. "maskable" keeps it inside the 80% safe zone; Android 12+ draws both the home-screen icon and its launch screen from it.
      icon("icon-192", 192, "any"),
      icon("icon-512", 512, "any"),
      icon("icon-maskable-192", 192, "maskable"),
      icon("icon-maskable-512", 512, "maskable"),
    ],
    shortcuts: [
      { name: "Check in", short_name: "Check in", url: "/journal?checkin=1", icons: shortcutIcons("checkin") },
      { name: "Recovery", url: "/recovery", icons: shortcutIcons("recovery") },
      { name: "Sleep", url: "/sleep", icons: shortcutIcons("sleep") },
    ],
    screenshots: [
      shot("phone-home", "720x1309", "narrow", "Home: recovery, strain and sleep"),
      shot("phone-recovery", "720x1332", "narrow", "Recovery"),
      shot("phone-sleep", "720x1391", "narrow", "Sleep"),
      shot("laptop-home", "1600x1074", "wide", "Home on a laptop"),
    ],
  };
}
