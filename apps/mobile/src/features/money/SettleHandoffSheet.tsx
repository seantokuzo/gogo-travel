/**
 * Payment-handle handoff Sheet (T-9.7 — §2.6 step 3, nav §2.6 "settle
 * handoff options"): the settle screen's presentation of the ONE rail
 * machinery (RailList — its module doc owns the R-cmoney-15..24 behavior;
 * the request screen renders the same list inline per R-cmoney-26).
 */
import { Sheet } from "@/components";

import { RailList, type RailListProps } from "./RailList";

export interface SettleHandoffSheetProps extends RailListProps {
  visible: boolean;
  onDismiss(): void;
}

export function SettleHandoffSheet({ visible, onDismiss, ...rails }: SettleHandoffSheetProps) {
  return (
    <Sheet
      visible={visible}
      onDismiss={onDismiss}
      title="Settle up"
      testID={`${rails.testIDBase}-sheet-handoff`}
    >
      <RailList {...rails} />
    </Sheet>
  );
}
