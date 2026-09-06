/**
 * Inline budget-cap input (T-9.5 / R-cmoney-2 — §2.2 "cap (tap → inline
 * cents input, editor+)"). The §2.8 inventory pins the INPUT testIDs
 * (`money-input-cap-total`, `money-input-cap-{category}`), so the field IS
 * the tap target — always inline for editor+; viewers get plain text at the
 * call site and never mount this.
 *
 * Commit path (end-editing — keyboard "done" AND tap-away both land there):
 * text parses through the SHARED ISO-4217 parser ONLY (R-cmoney-8, Law #2 —
 * string math, zero-decimal aware, so a fractional yen is a visible parse
 * error, never a silent 100× corruption); empty clears the cap (`null`, G2);
 * an unchanged value commits nothing (no no-op PUTs on blur); commits are
 * gated while one is in flight (`pending` — both `editable={false}` and a
 * handler guard, so the gate holds even where `editable` can't reach, e.g.
 * a queued end-editing event).
 *
 * Server truth wins: when the cached cap changes (our PUT's response or a
 * teammate's edit landing via refetch), the draft resets to it.
 */
import { centsToMoneyText, minorUnitDigits, parseMoneyToCents } from "@gogo/shared";
import { useEffect, useRef, useState } from "react";

import { Input } from "@/components";

export interface CapInputProps {
  label: string;
  currency: string;
  /** The cached server cap — `null` = no cap. */
  capCents: number | null;
  /** A commit is in flight — block further commits (visible via Input state). */
  pending: boolean;
  /** §2.8 testID (`money-input-cap-total` / `money-input-cap-{category}`). */
  testID: string;
  onCommit(capCents: number | null): void;
}

function draftFor(capCents: number | null, currency: string): string {
  return capCents === null ? "" : centsToMoneyText(capCents, currency, { omitZeroMinor: true });
}

export function CapInput({ label, currency, capCents, pending, testID, onCommit }: CapInputProps) {
  const [text, setText] = useState(() => draftFor(capCents, currency));
  const [error, setError] = useState<string | undefined>(undefined);

  // Reset the draft when the SERVER value moves (PUT response / refetch).
  // Ref-compared, not effect-on-mount: a re-render with an unchanged cap
  // must never clobber mid-edit text.
  const lastServer = useRef(capCents);
  useEffect(() => {
    if (lastServer.current === capCents) return;
    lastServer.current = capCents;
    setText(draftFor(capCents, currency));
    setError(undefined);
  }, [capCents, currency]);

  const commit = () => {
    if (pending) return;
    const trimmed = text.trim();
    if (trimmed === "") {
      setError(undefined);
      if (capCents !== null) onCommit(null);
      return;
    }
    const parsed = parseMoneyToCents(trimmed, currency);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(undefined);
    if (parsed.cents !== capCents) onCommit(parsed.cents);
  };

  return (
    <Input
      label={label}
      value={text}
      onChangeText={(next) => {
        setText(next);
        if (error !== undefined) setError(undefined);
      }}
      placeholder="No cap"
      {...(error === undefined ? {} : { error })}
      keyboardType={minorUnitDigits(currency) === 0 ? "number-pad" : "decimal-pad"}
      returnKeyType="done"
      onEndEditing={commit}
      editable={!pending}
      testID={testID}
    />
  );
}
