import { expect, test } from "@playwright/test";
import launchScreens from "../src/app/launch-screens.json" with { type: "json" };

// The installable-app pieces must work signed out: install starts from /login, and the worker is fetched before any session.
test.use({ storageState: { cookies: [], origins: [] } });

test("the manifest, icons, worker, offline page and launch screens are served without a session", async ({ request }) => {
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest).toMatchObject({ id: "/", name: "Pulse", display: "standalone", orientation: "portrait" });
  for (const icon of [...manifest.icons, ...manifest.shortcuts.flatMap((s: { icons: { src: string }[] }) => s.icons)])
    expect((await request.get(icon.src)).ok(), icon.src).toBe(true);

  const sw = await request.get("/sw.js");
  expect(sw.ok()).toBe(true);
  expect(sw.headers()["cache-control"]).toContain("no-cache"); // an update must always be able to arrive
  expect(await (await request.get("/offline.html")).text()).toContain("You’re offline");

  // Every launch screen the layout links exists (one per iPhone and iPad, both orientations, both schemes).
  expect(launchScreens.length).toBeGreaterThan(40);
  for (const s of launchScreens) expect((await request.head(s.url)).ok(), s.url).toBe(true);
});

test("the login page links the iOS launch screens", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator('link[rel="apple-touch-startup-image"]')).toHaveCount(launchScreens.length);
});

test("with the worker installed, a page load while offline shows the offline page", async ({ page, context }) => {
  test.skip(!process.env.E2E_PROD, "the worker registers only in a production build");
  await page.goto("/login");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // now controlled by the worker
  await context.setOffline(true);
  await page.goto("/login").catch(() => {});
  await expect(page.getByRole("heading", { name: "You’re offline" })).toBeVisible();
});
