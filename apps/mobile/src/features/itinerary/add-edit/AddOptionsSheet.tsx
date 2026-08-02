/**
 * FAB → add Sheet (T-7.6 / IT-7 — R-itin-18): the 10-option picker; a
 * selection routes to the `itinerary-item-new` modal with the type preset.
 *
 * Sheet-tax posture (STATE "T-7.8 landmine"): the DS Sheet stays
 * hit-testable through its ~200ms exit — a selection acts ONCE per
 * presentation (late taps on the exiting sheet no-op), re-armed each time
 * the sheet is shown.
 */
import { useEffect, useRef } from "react";
import { ScrollView } from "react-native";

import { Sheet } from "@/components";

import { AddOptionList } from "./AddOptionList";
import type { AddOptionId } from "./form-model";

export interface AddOptionsSheetProps {
  visible: boolean;
  onDismiss(): void;
  /** Fires once per presentation; the host routes and dismisses. */
  onSelect(option: AddOptionId): void;
}

export function AddOptionsSheet({ visible, onDismiss, onSelect }: AddOptionsSheetProps) {
  const actedRef = useRef(false);

  // Re-arm the one-action gate on every presentation.
  useEffect(() => {
    if (visible) actedRef.current = false;
  }, [visible]);

  return (
    <Sheet
      visible={visible}
      onDismiss={onDismiss}
      title="Add to itinerary"
      testID="itinerary-add-sheet"
    >
      <ScrollView>
        <AddOptionList
          onSelect={(option) => {
            if (actedRef.current) return;
            actedRef.current = true;
            onSelect(option);
          }}
        />
      </ScrollView>
    </Sheet>
  );
}
