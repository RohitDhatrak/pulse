"use client"

import * as React from "react"
import { toast } from "sonner"
import "@/lib/install" // registers the install-prompt listener as early as the bundle runs
import { SW_URL } from "@/lib/sw"


/**
 * Everything PWA that isn't a screen, mounted once in the root layout (signed out too):
 * - registers the service worker (production only: in dev it would cache stale code); a new build gets a new
 *   script URL, so the browser installs it, and the user is asked before the page swaps to it;
 * - says so when the connection drops or returns;
 * - turns "Failed to find Server Action" (an open app calling a newer server) into a reload prompt.
 */
export function PwaRuntime() {
  React.useEffect(() => {
    const reload = (id: string) =>
      toast("New version available", { id, duration: Infinity, action: { label: "Reload", onClick: () => location.reload() } })

    const onRejection = (e: PromiseRejectionEvent) => {
      if (String(e.reason?.message ?? e.reason).includes("Failed to find Server Action")) reload("stale-build")
    }
    addEventListener("unhandledrejection", onRejection)

    const offline = () => toast.error("You’re offline", { id: "offline", description: "Changes to your check-in are kept and sent later.", duration: Infinity })
    const online = () => toast.dismiss("offline")
    if (!navigator.onLine) offline()
    addEventListener("offline", offline)
    addEventListener("online", online)

    let off = () => {}
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      let asked = false
      navigator.serviceWorker.register(SW_URL).then((reg) => {
        const offer = (w: ServiceWorker) =>
          toast("New version available", {
            id: "sw-update",
            duration: Infinity,
            action: {
              label: "Reload",
              onClick: () => {
                asked = true
                w.postMessage("SKIP_WAITING")
              },
            },
          })
        // Already waiting (found in an earlier visit), or found now: offer it once it is installed.
        if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting)
        reg.addEventListener("updatefound", () => {
          const w = reg.installing
          w?.addEventListener("statechange", () => {
            if (w.state === "installed" && navigator.serviceWorker.controller) offer(w)
          })
        })
      })
      // The new worker took over: load the new build's pages, but only because the user asked for it.
      const onController = () => asked && location.reload()
      navigator.serviceWorker.addEventListener("controllerchange", onController)
      off = () => navigator.serviceWorker.removeEventListener("controllerchange", onController)
    }
    return () => {
      removeEventListener("unhandledrejection", onRejection)
      removeEventListener("offline", offline)
      removeEventListener("online", online)
      off()
    }
  }, [])
  return null
}
