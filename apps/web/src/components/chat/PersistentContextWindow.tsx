import {
  presentContextWindow,
  type ContextCompactionRecord,
  type ContextWindowSnapshot,
} from "~/lib/contextWindow";
import { CircleGaugeIcon } from "lucide-react";

import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerBanner } from "./ComposerBanner";
import { ContextWindowDetails } from "./ContextWindowMeter";
import { composerFloatingLayerProps } from "./composerEventScope";

export function PersistentContextWindow(props: {
  readonly usage: ContextWindowSnapshot | null;
  readonly unavailableMessage?: string | null;
  readonly modelDisplayName?: string | null | undefined;
  readonly providerDisplayName?: string | null | undefined;
  readonly compactions?: ReadonlyArray<ContextCompactionRecord> | undefined;
  readonly onCompact?: (() => void) | undefined;
  readonly compactDisabled?: boolean | undefined;
  readonly compactDisabledReason?: string | null | undefined;
}) {
  if (props.usage === null) {
    if (!props.unavailableMessage) return null;
    return (
      <ComposerBanner.Attachment>
        <ComposerBanner.Root variant="warning" data-testid="persistent-context-window">
          <ComposerBanner.Row>
            <ComposerBanner.Icon>
              <CircleGaugeIcon />
            </ComposerBanner.Icon>
            <ComposerBanner.Content className="overflow-hidden">
              <span className="font-medium text-foreground">Context</span>
              <ComposerBanner.Separator />
              <span className="truncate text-warning">{props.unavailableMessage}</span>
            </ComposerBanner.Content>
          </ComposerBanner.Row>
        </ComposerBanner.Root>
      </ComposerBanner.Attachment>
    );
  }

  const presentation = presentContextWindow(props.usage);
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root data-testid="persistent-context-window">
        <Popover>
          <PopoverTrigger
            render={
              <ComposerBanner.Row
                render={<button type="button" aria-label="Open context window details" />}
              >
                <ComposerBanner.Icon>
                  <CircleGaugeIcon />
                </ComposerBanner.Icon>
                <ComposerBanner.Content className="overflow-hidden">
                  <span className="font-medium text-foreground">Context</span>
                  <ComposerBanner.Separator />
                  <span className="truncate tabular-nums text-muted-foreground">
                    {presentation.compactValue}
                  </span>
                </ComposerBanner.Content>
              </ComposerBanner.Row>
            }
          />
          <PopoverPopup
            {...composerFloatingLayerProps}
            side="top"
            align="end"
            viewportClassName="p-0"
            className="w-80 max-w-none text-left whitespace-normal"
          >
            <ContextWindowDetails
              usage={props.usage}
              modelDisplayName={props.modelDisplayName}
              providerDisplayName={props.providerDisplayName}
              compactions={props.compactions}
              onCompact={props.onCompact}
              compactDisabled={props.compactDisabled}
              compactDisabledReason={props.compactDisabledReason}
            />
          </PopoverPopup>
        </Popover>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
