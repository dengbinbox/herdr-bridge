import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "./uuid";

afterEach(() => vi.unstubAllGlobals());

it("uses native randomUUID when available", () => {
  const native = vi.fn(() => "native-uuid");
  vi.stubGlobal("crypto", { randomUUID: native });
  expect(randomUUID()).toBe("native-uuid");
  expect(native).toHaveBeenCalledOnce();
});

it("generates distinct v4 UUIDs on HTTP without randomUUID", () => {
  const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  vi.stubGlobal("crypto", { getRandomValues });
  const ids = Array.from({ length: 100 }, () => randomUUID());
  for (const id of ids)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(new Set(ids).size).toBe(ids.length);
});
