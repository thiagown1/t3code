import { useEffect, useId, useState, type ReactNode } from "react";

export const MAX_MERMAID_SOURCE_LENGTH = 50_000;

type MermaidDiagramState =
  | { readonly status: "pending"; readonly source: null; readonly appearance: null }
  | {
      readonly status: "rendered";
      readonly source: string;
      readonly appearance: "light" | "dark";
      readonly svg: string;
    }
  | {
      readonly status: "failed";
      readonly source: string;
      readonly appearance: "light" | "dark";
    };

/**
 * Mermaid is intentionally loaded only for authored Mermaid fences. Pull request text is
 * untrusted, so links and HTML stay disabled and malformed or oversized input falls back to the
 * original code block instead of breaking the rest of the description.
 */
export function MermaidDiagram({
  source,
  appearance,
  fallback,
}: {
  readonly source: string;
  readonly appearance: "light" | "dark";
  readonly fallback: ReactNode;
}) {
  const reactId = useId();
  const renderId = `t3-mermaid-${reactId.replaceAll(/[^a-zA-Z0-9_-]/gu, "")}`;
  const [settledState, setSettledState] = useState<MermaidDiagramState>({
    status: "pending",
    source: null,
    appearance: null,
  });
  const state: MermaidDiagramState =
    source.length > MAX_MERMAID_SOURCE_LENGTH
      ? { status: "failed", source, appearance }
      : settledState.source === source && settledState.appearance === appearance
        ? settledState
        : { status: "pending", source: null, appearance: null };

  useEffect(() => {
    let active = true;

    if (source.length > MAX_MERMAID_SOURCE_LENGTH) {
      return () => {
        active = false;
      };
    }

    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          maxTextSize: MAX_MERMAID_SOURCE_LENGTH,
          maxEdges: 500,
          layout: "dagre",
          theme: appearance === "dark" ? "dark" : "default",
        });
        const { svg } = await mermaid.render(renderId, source);
        if (active && svg.trim().length > 0) {
          setSettledState({ status: "rendered", source, appearance, svg });
        } else if (active) {
          setSettledState({ status: "failed", source, appearance });
        }
      })
      .catch(() => {
        if (active) setSettledState({ status: "failed", source, appearance });
      });

    return () => {
      active = false;
    };
  }, [appearance, renderId, source]);

  if (state.status === "failed") {
    return (
      <div data-mermaid-state="failed">
        <p className="px-3 pt-2 text-xs text-muted-foreground" role="status">
          This Mermaid diagram could not be rendered. Showing its source instead.
        </p>
        {fallback}
      </div>
    );
  }

  if (state.status === "pending") {
    return (
      <div
        className="my-[0.65rem] min-h-24 rounded-[var(--radius)] border border-border/70 bg-secondary/40 p-4 text-xs text-muted-foreground"
        data-mermaid-state="pending"
        role="status"
      >
        Rendering Mermaid diagram…
      </div>
    );
  }

  return (
    <div
      className="my-[0.65rem] overflow-x-auto rounded-[var(--radius)] border border-border/70 bg-secondary/40 p-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
      data-mermaid-state="rendered"
      aria-label="Mermaid diagram"
      dangerouslySetInnerHTML={{ __html: state.svg }}
    />
  );
}
