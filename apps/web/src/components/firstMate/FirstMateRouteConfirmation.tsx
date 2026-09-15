import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type { FirstMateTopic, FirstMateTopicId } from "@t3tools/contracts";
import { CornerDownRightIcon, XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import type { FirstMateSupervisorRoutingFailure } from "./FirstMateSupervisorRouting.logic";

export interface FirstMateRouteConfirmationRequest {
  readonly reason: FirstMateSupervisorRoutingFailure;
  readonly candidateTopicIds: ReadonlyArray<FirstMateTopicId>;
  readonly message: string;
}

interface FirstMateRouteConfirmationProps {
  readonly project: EnvironmentProject;
  readonly request: FirstMateRouteConfirmationRequest;
  readonly confirmingTopicId: FirstMateTopicId | null;
  readonly onConfirm: (topic: FirstMateTopic) => void;
  readonly onDismiss: () => void;
}

const promptCopy: Record<
  FirstMateSupervisorRoutingFailure,
  { readonly title: string; readonly description: string }
> = {
  "no-selected-topic": {
    title: "Where should this message go?",
    description: "Choose one topic. The message is still in the composer.",
  },
  "selected-topic-not-found": {
    title: "Choose a current topic",
    description: "The previously selected topic is no longer available.",
  },
  "mentioned-topic-not-found": {
    title: "Topic mention not found",
    description: "Fix the @topic mention or choose a current topic.",
  },
  "multiple-topic-mentions": {
    title: "Choose one destination",
    description: "A supervisor message can be routed to only one topic.",
  },
  "topic-not-delegated": {
    title: "This topic has no linked thread",
    description: "Link a worker thread before routing this message.",
  },
  "topic-is-supervisor": {
    title: "This topic points back here",
    description: "Link the topic to a worker thread instead of the supervisor.",
  },
  "composer-context-not-supported": {
    title: "Open the topic to send this context",
    description: "FirstMate routing currently sends text only. Attachments remain in this draft.",
  },
  "destination-thread-not-found": {
    title: "Destination thread unavailable",
    description: "The linked worker thread is missing or archived. Nothing was sent.",
  },
};

function canConfirm(reason: FirstMateSupervisorRoutingFailure, topic: FirstMateTopic): boolean {
  return (
    topic.threadId !== null &&
    reason !== "composer-context-not-supported" &&
    reason !== "topic-not-delegated" &&
    reason !== "topic-is-supervisor" &&
    reason !== "destination-thread-not-found"
  );
}

export function FirstMateRouteConfirmation({
  project,
  request,
  confirmingTopicId,
  onConfirm,
  onDismiss,
}: FirstMateRouteConfirmationProps) {
  const workspace = project.firstMate;
  if (workspace === null || workspace === undefined) return null;

  const requestedIds = new Set(request.candidateTopicIds);
  const candidates = workspace.topics.filter(
    (topic) => requestedIds.size === 0 || requestedIds.has(topic.id),
  );
  const copy = promptCopy[request.reason];

  return (
    <section
      aria-label="FirstMate routing confirmation"
      aria-live="polite"
      className="mb-2 rounded-xl border border-sky-500/25 bg-background/95 p-2.5 shadow-sm backdrop-blur"
      data-testid="firstmate-route-confirmation"
    >
      <div className="flex items-start gap-2">
        <CornerDownRightIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-sky-500" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-foreground">{copy.title}</p>
          <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{copy.description}</p>
        </div>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Dismiss FirstMate routing confirmation"
          onClick={onDismiss}
          className="shrink-0"
        >
          <XIcon aria-hidden className="size-3.5" />
        </Button>
      </div>
      {candidates.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5 pl-6">
          {candidates.map((topic) => {
            const enabled = canConfirm(request.reason, topic);
            return (
              <Button
                key={topic.id}
                type="button"
                size="xs"
                variant="outline"
                disabled={!enabled || confirmingTopicId !== null}
                onClick={() => onConfirm(topic)}
                className={cn("max-w-full", enabled && "active:scale-[0.97]")}
              >
                <span className="truncate">
                  {confirmingTopicId === topic.id ? "Routing…" : topic.title}
                </span>
              </Button>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
