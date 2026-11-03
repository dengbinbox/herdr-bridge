// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MarkdownPreview, safeMarkdownLink } from "./MarkdownPreview";
import { AgentStatus, ProgramIcon, programIdentity } from "./Icons";
afterEach(cleanup);
it("renders GFM headings, lists, tasks, tables, code and emphasis as React elements", () => {
  const { container } = render(
    <MarkdownPreview
      text={
        '# Project\n\n**Strong** and ~~old~~\n\n- [x] ready\n- [ ] later\n\n| Name | Value |\n| --- | --- |\n| one | two |\n\n```ts\nconst x = "<script>";\n```\n\n> quoted'
      }
    />,
  );
  expect(screen.getByRole("heading", { name: "Project" })).toBeTruthy();
  expect(screen.getByRole("table")).toBeTruthy();
  expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  expect(container.querySelector("strong")?.textContent).toBe("Strong");
  expect(container.querySelector("del")?.textContent).toBe("old");
  expect(container.querySelector("pre code")?.textContent).toContain(
    "<script>",
  );
  expect(container.querySelector("blockquote")?.textContent).toContain(
    "quoted",
  );
});
it("does not execute embedded HTML, unsafe URLs, or automatically fetch images", () => {
  const { container } = render(
    <MarkdownPreview
      text={
        "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert%281%29)\n\n![remote](https://example.com/tracker.png)\n\n[safe](https://example.com)"
      }
    />,
  );
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("[onerror]")).toBeNull();
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.getByRole("link", { name: "safe" }).getAttribute("rel")).toBe(
    "noopener noreferrer",
  );
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,a",
    "//evil.test",
    "https://x.test\n",
    "file:///secret",
    "\\server\\x",
  ])
    expect(safeMarkdownLink(url)).toBeNull();
});
it("routes relative Markdown links through the selected machine file callback", () => {
  const file = vi.fn();
  render(<MarkdownPreview text={"[Guide](./docs/guide.md)"} onFile={file} />);
  fireEvent.click(screen.getByRole("button", { name: "Guide" }));
  expect(file).toHaveBeenCalledWith("./docs/guide.md");
});
it("uses reported program identity, with a generic icon for unknown agents and a trailing spinner", () => {
  const record = {
    address: "t1",
    state: "live",
    rows: 24,
    cols: 80,
    status: { state: "working", app: "claude-code" },
  };
  expect(programIdentity(record).id).toBe("claude");
  render(
    <>
      <ProgramIcon record={record} />
      <AgentStatus state="working" />
    </>,
  );
  expect(screen.getByRole("img", { name: "Claude Code" })).toBeTruthy();
  expect(
    screen.getByRole("img", { name: "Working" }).querySelector("svg"),
  ).toBeTruthy();
  expect(
    programIdentity({ ...record, status: { state: "working", app: "unknown" } })
      .id,
  ).toBe("agent");
});
