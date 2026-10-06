// Not in PwaRuntime: a "use client" module's exports reach a server component as client references, not strings.

/** The worker's URL: a new build gets a new one, so the browser installs it (see SW_SCRIPT for the first register). */
export const SW_URL = `/sw.js?v=${process.env.NEXT_PUBLIC_BUILD_ID ?? "0"}`

/**
 * Registers the worker from <head>, on load, before React hydrates: the worker is ready sooner, and checkers that look
 * for `serviceWorker.register` in the page (PWABuilder) find it. PwaRuntime registers the same URL again, which only
 * returns the existing registration, to watch it for updates.
 */
export const SW_SCRIPT = `if("serviceWorker"in navigator)addEventListener("load",function(){navigator.serviceWorker.register("${SW_URL}")})`
