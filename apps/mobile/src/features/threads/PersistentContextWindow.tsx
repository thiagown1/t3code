import {
  presentContextWindow,
  type ContextCompactionRecord,
  type ContextWindowSnapshot,
} from "@t3tools/shared/contextWindow";
import { Alert, Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { formatContextWindowAlert } from "./PersistentContextWindow.logic";

export function PersistentContextWindow(props: {
  readonly usage: ContextWindowSnapshot | null;
  readonly unavailableMessage?: string | null;
  readonly modelDisplayName?: string | null | undefined;
  readonly providerDisplayName?: string | null | undefined;
  readonly compactions?: ReadonlyArray<ContextCompactionRecord> | undefined;
  readonly manualCompactionAvailable?: boolean | undefined;
}) {
  if (props.usage === null) {
    if (!props.unavailableMessage) return null;
    return (
      <View className="mx-4 mb-2 flex-row items-center gap-2 rounded-xl border border-warning/30 bg-card px-3 py-2">
        <SymbolView
          name="gauge.with.dots.needle.67percent"
          size={14}
          tintColorClassName="accent-warning-foreground"
          type="monochrome"
        />
        <View className="min-w-0 flex-1 flex-row items-center gap-1.5">
          <Text className="shrink font-medium text-xs text-foreground" numberOfLines={1}>
            Context
          </Text>
          <Text className="text-xs text-foreground-muted">·</Text>
          <Text className="shrink text-xs text-warning" numberOfLines={1}>
            {props.unavailableMessage}
          </Text>
        </View>
      </View>
    );
  }

  const presentation = presentContextWindow(props.usage);
  return (
    <Pressable
      accessibilityLabel="Open context window details"
      accessibilityRole="button"
      onPress={() =>
        Alert.alert(
          "Context window",
          formatContextWindowAlert({
            usage: props.usage!,
            modelDisplayName: props.modelDisplayName,
            providerDisplayName: props.providerDisplayName,
            compactions: props.compactions,
            manualCompactionAvailable: props.manualCompactionAvailable,
          }),
        )
      }
      className="mx-4 mb-2 flex-row items-center gap-2 rounded-xl border border-border-subtle bg-card px-3 py-2 active:opacity-70"
    >
      <SymbolView
        name="gauge.with.dots.needle.67percent"
        size={14}
        tintColorClassName="accent-icon-muted"
        type="monochrome"
      />
      <View className="min-w-0 flex-1 flex-row items-center gap-1.5">
        <Text className="shrink font-medium text-xs text-foreground" numberOfLines={1}>
          Context
        </Text>
        <Text className="text-xs text-foreground-muted">·</Text>
        <Text className="shrink text-xs text-foreground-muted" numberOfLines={1}>
          {presentation.compactValue}
        </Text>
      </View>
    </Pressable>
  );
}
