// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const save = vi.fn();
vi.mock("@/server/actions/journal", () => ({ saveJournalEntry: (...a: unknown[]) => save(...a) }));
const { enqueue, flushQueue, queued } = await import("./offline-queue");

beforeEach(() => {
  localStorage.clear();
  save.mockReset();
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
});

describe("offline check-in queue", () => {
  it("keeps the newest answer per (day, tag)", () => {
    enqueue(1, [{ day: "2026-10-01", tag: "alcohol", value: true }]);
    enqueue(1, [{ day: "2026-10-01", tag: "alcohol", value: false }, { day: "2026-10-01", tag: "caffeine", value: true }]);
    expect(queued(1)).toBe(2);
  });

  it("sends everything and empties; a server rejection is dropped, not retried", async () => {
    enqueue(1, [{ day: "2026-10-01", tag: "a", value: true }, { day: "2026-10-01", tag: "b", value: null }]);
    save.mockResolvedValueOnce({ ok: true, data: undefined }).mockResolvedValueOnce({ ok: false, error: "Unknown tag: b" });
    expect(await flushQueue(1)).toBe(1);
    expect(queued(1)).toBe(0);
  });

  it("a network failure or a signed-out session keeps the rest", async () => {
    enqueue(1, [{ day: "2026-10-01", tag: "a", value: true }, { day: "2026-10-01", tag: "b", value: true }]);
    save.mockRejectedValueOnce(new Error("network"));
    expect(await flushQueue(1)).toBe(0);
    expect(queued(1)).toBe(2);
    save.mockResolvedValueOnce({ ok: false, error: "Signed out. Sign in again." });
    await flushQueue(1);
    expect(queued(1)).toBe(2);
  });

  it("only replays the queue of the account that made it", async () => {
    enqueue(1, [{ day: "2026-10-01", tag: "alcohol", value: true }]);
    save.mockResolvedValue({ ok: true, data: undefined });
    expect(await flushQueue(2)).toBe(0);
    expect(save).not.toHaveBeenCalled();
    expect(queued(1)).toBe(1);
  });

  it("drops the old shared queue, whose owner is unknown", async () => {
    localStorage.setItem("pulse:journal-queue", JSON.stringify([{ day: "2026-10-01", tag: "a", value: true }]));
    await flushQueue(1);
    expect(localStorage.getItem("pulse:journal-queue")).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it("does nothing while offline", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    enqueue(1, [{ day: "2026-10-01", tag: "a", value: true }]);
    expect(await flushQueue(1)).toBe(0);
    expect(save).not.toHaveBeenCalled();
  });
});
