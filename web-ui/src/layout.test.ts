import { expect, it } from "vitest";
import { readLayout } from "./layout";
it("rejects invalid stored layouts before they reach the panel renderer", () => {
  const base = {
    tabs: [{ id: "remote/t1", observe: true }],
    split: true,
    active: "remote/t1",
    sizes: [100],
  };
  expect(readLayout(base)).toEqual(base);
  for (const value of [
    null,
    {},
    { ...base, sizes: ["bad"] },
    { ...base, sizes: [Infinity] },
    { ...base, tabs: [...base.tabs, ...base.tabs] },
    { ...base, split: "false" },
  ])
    expect(readLayout(value)).toBeNull();
});
it("restores remote terminal addresses and a valid active tab", () => {
  expect(
    readLayout({
      tabs: [{ id: "remote/t1", observe: true }],
      split: false,
      active: "deleted",
    }),
  ).toEqual({
    tabs: [{ id: "remote/t1", observe: true }],
    split: false,
    active: "remote/t1",
    sizes: [],
  });
});
