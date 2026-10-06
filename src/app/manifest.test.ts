import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "./manifest";

const onDisk = (src: string) => existsSync(join(process.cwd(), "public", src.split("?")[0]));

describe("web app manifest", () => {
  const m = manifest();

  it("is installable and keeps one identity", () => {
    expect(m).toMatchObject({ id: "/", scope: "/", start_url: "/", display: "standalone", display_override: ["standalone"], orientation: "portrait", dir: "ltr" });
  });

  it("splits the launch-screen icon (any) from the maskable one, and every file exists", () => {
    const by = (purpose: string) => m.icons!.filter((i) => i.purpose === purpose);
    expect(by("any").map((i) => i.sizes).sort()).toEqual(["192x192", "512x512"]);
    expect(by("maskable").map((i) => i.sizes).sort()).toEqual(["192x192", "512x512"]);
    expect(new Set(m.icons!.map((i) => i.src)).size).toBe(m.icons!.length);
    for (const i of m.icons!) expect(onDisk(i.src), i.src).toBe(true);
  });

  it("shortcuts point at real routes with icons, screenshots exist", () => {
    expect(m.shortcuts!.map((s) => s.url)).toEqual(["/journal?checkin=1", "/recovery", "/sleep"]);
    for (const s of m.shortcuts!) for (const i of s.icons!) expect(onDisk(i.src), i.src).toBe(true);
    for (const s of m.screenshots!) expect(onDisk(s.src), s.src).toBe(true);
  });
});
