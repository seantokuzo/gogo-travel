/**
 * R-ds-20 type-level enforcement (DS-7..9 required test: "Every interactive
 * component throws type error without `testID`").
 *
 * Never rendered and never run by jest — `tsc --noEmit` is the test runner:
 * each `@ts-expect-error` line FAILS the typecheck if the omission it guards
 * ever stops being a type error (i.e. if `testID` becomes optional).
 */
import { Button } from "./Button";
import { Card } from "./Card";
import { ConfirmDialog } from "./ConfirmDialog";
import { EmptyState } from "./EmptyState";
import { ErrorBanner } from "./ErrorBanner";
import { Input } from "./Input";
import { ListItem } from "./ListItem";
import { PageHeader } from "./PageHeader";
import { SegmentedControl } from "./SegmentedControl";
import { Sheet } from "./Sheet";

const noop = () => undefined;

export const invalidWithoutTestID = [
  // @ts-expect-error — Button requires testID (R-ds-20)
  <Button key="button" title="x" onPress={noop} />,

  // @ts-expect-error — pressable Card requires testID (R-ds-20)
  <Card key="card" onPress={noop} />,

  // @ts-expect-error — Input requires testID (R-ds-20)
  <Input key="input" label="x" value="" onChangeText={noop} />,

  // @ts-expect-error — ErrorBanner requires testID (R-ds-20)
  <ErrorBanner key="banner" message="x" />,

  // prettier-ignore
  // @ts-expect-error — ConfirmDialog requires testID (R-ds-20)
  <ConfirmDialog key="dialog" visible title="x" confirmLabel="x" onConfirm={noop} onCancel={noop} />,

  // @ts-expect-error — SegmentedControl requires testID (R-ds-20)
  <SegmentedControl key="segmented" segments={[]} selectedKey="a" onChange={noop} />,

  // @ts-expect-error — Sheet requires testID (R-ds-20)
  <Sheet key="sheet" visible onDismiss={noop} />,

  // @ts-expect-error — pressable ListItem requires testID (R-ds-20)
  <ListItem key="list-item" title="x" onPress={noop} />,

  // @ts-expect-error — EmptyState action requires its own testID (R-ds-20)
  <EmptyState key="empty" icon="add" title="x" action={{ label: "x", onPress: noop }} />,

  // @ts-expect-error — PageHeader requires testID (nav §2.7 rule 1, T-4.4 R1)
  <PageHeader key="header-no-id" title="x" />,

  // prettier-ignore
  // @ts-expect-error — PageHeader trailing actions require testID (R-ds-20)
  <PageHeader key="header" title="x" testID="hdr" trailing={[{ icon: "add", label: "x", onPress: noop }]} />,
];

// Non-pressable Card / ListItem keep testID OPTIONAL — compile-time proof the
// discriminated union only demands it when interactive.
export const validWithoutTestID = [
  <Card key="static-card" />,
  <ListItem key="static-list-item" title="x" />,
];
