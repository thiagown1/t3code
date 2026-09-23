import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({ default: mermaid }));

import { MAX_MERMAID_SOURCE_LENGTH, MermaidDiagram } from "./MermaidDiagram";

describe("MermaidDiagram", () => {
  beforeEach(() => {
    mermaid.initialize.mockReset();
    mermaid.render.mockReset();
  });

  it("renders an untrusted flowchart with the strict Mermaid policy", async () => {
    mermaid.render.mockResolvedValue({ svg: '<svg aria-label="Members export"></svg>' });
    let renderer: ReactTestRenderer | undefined;

    try {
      await act(async () => {
        renderer = create(
          <MermaidDiagram
            source={"flowchart LR\n  groups_list --> members_dialog"}
            appearance="dark"
            fallback={<pre>source fallback</pre>}
          />,
        );
      });

      expect(mermaid.initialize).toHaveBeenCalledWith(
        expect.objectContaining({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          maxTextSize: MAX_MERMAID_SOURCE_LENGTH,
          layout: "dagre",
        }),
      );
      expect(mermaid.render).toHaveBeenCalledWith(
        expect.stringMatching(/^t3-mermaid-/u),
        "flowchart LR\n  groups_list --> members_dialog",
      );
      const rendered = renderer!.root.findByProps({ "data-mermaid-state": "rendered" });
      expect(rendered.props.dangerouslySetInnerHTML).toEqual({
        __html: '<svg aria-label="Members export"></svg>',
      });
      expect(renderer!.root.findAllByType("pre")).toHaveLength(0);
    } finally {
      await act(async () => renderer?.unmount());
    }
  });

  it("shows the original source when Mermaid rejects invalid syntax", async () => {
    mermaid.render.mockRejectedValue(new Error("Parse error"));
    let renderer: ReactTestRenderer | undefined;

    try {
      await act(async () => {
        renderer = create(
          <MermaidDiagram
            source="flowchart this is invalid"
            appearance="light"
            fallback={<pre>flowchart this is invalid</pre>}
          />,
        );
      });

      expect(renderer!.root.findByProps({ "data-mermaid-state": "failed" })).toBeDefined();
      expect(renderer!.root.findByType("pre").children.join("")).toBe("flowchart this is invalid");
    } finally {
      await act(async () => renderer?.unmount());
    }
  });

  it("refuses oversized diagrams before loading the renderer", async () => {
    let renderer: ReactTestRenderer | undefined;

    try {
      await act(async () => {
        renderer = create(
          <MermaidDiagram
            source={`flowchart LR\n${"A-->B\n".repeat(MAX_MERMAID_SOURCE_LENGTH)}`}
            appearance="dark"
            fallback={<pre>oversized source</pre>}
          />,
        );
      });

      expect(mermaid.initialize).not.toHaveBeenCalled();
      expect(mermaid.render).not.toHaveBeenCalled();
      expect(renderer!.root.findByProps({ "data-mermaid-state": "failed" })).toBeDefined();
      expect(renderer!.root.findByType("pre").children.join("")).toBe("oversized source");
    } finally {
      await act(async () => renderer?.unmount());
    }
  });
});
