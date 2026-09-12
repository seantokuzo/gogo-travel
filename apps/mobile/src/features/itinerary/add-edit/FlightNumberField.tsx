/**
 * Flight-number field with in-form airline inference (B-9 client half).
 *
 * "NH204" → the lookup resolves All Nippon Airways and offers it as a
 * one-tap fill. The PR #50 rider is the load-bearing part: NO request fires
 * on input the SHARED `FlightNumberInputSchema` rejects, and none fires on
 * input the SHARED `parseFlightNumber` can't read either — both gates live
 * in `flightLookupKeyOf`, whose canonical key ("nh 204" / "NH-204" /
 * "nh0204" → "NH204") also collapses every spelling of one flight onto one
 * cache entry and one request.
 *
 * The inference is OFFERED, never auto-applied (interpretation, PR body):
 * auto-filling would clobber a carrier name the user typed, would refill
 * the instant they cleared it, and — because every detail write latches the
 * form's dirty guard — would arm the discard-confirm dialog on a booking
 * the user only looked at. One tap costs less than any of those.
 */
import { createStyles } from "@gogo/tokens/react";
import { StyleSheet, View } from "react-native";

import { Input, ListItem } from "@/components";
import { useFlightAirlineLookup } from "@/data";

export interface FlightNumberFieldProps {
  label: string;
  value: string;
  onChangeText(value: string): void;
  /** The airline field's current text — the suggestion hides once it matches. */
  airlineText: string;
  /** One-tap fill of the resolved airline name. */
  onUseAirline(name: string): void;
  /** B-20 designator traits (uppercase transform is applied by the caller). */
  autoCapitalize: "none" | "characters" | undefined;
  autoCorrect: boolean | undefined;
  maxLength: number;
  error?: string;
  /** B-26: schema-derived required marker (passthrough to `Input`). */
  required?: boolean;
  /** Required (R-ds-20). */
  testID: string;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    container: { gap: t.space[1] },
    suggestion: {
      borderWidth: 1,
      borderColor: t.color.border.subtle,
      borderRadius: t.radius.md,
      backgroundColor: t.color.bg.surface,
    },
  }),
);

export function FlightNumberField({
  label,
  value,
  onChangeText,
  airlineText,
  onUseAirline,
  autoCapitalize,
  autoCorrect,
  maxLength,
  error,
  required,
  testID,
}: FlightNumberFieldProps) {
  const s = useStyles();
  // Gated inside the hook by FlightNumberInputSchema + parseFlightNumber —
  // `enabled: false` until BOTH accept, so no keystroke becomes a request.
  const lookup = useFlightAirlineLookup(value);
  const airline = lookup.data?.airline ?? null;
  // A lookup miss is a soft 200 (`{ flight, airline: null }`), so there is
  // no error surface here on purpose: an unknown designator must never turn
  // a half-typed flight number into a red field.
  const suggest =
    airline !== null && airlineText.trim().toLowerCase() !== airline.name.toLowerCase();

  return (
    <View style={s.container}>
      <Input
        label={label}
        value={value}
        onChangeText={onChangeText}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        maxLength={maxLength}
        error={error}
        required={required}
        testID={testID}
      />
      {suggest && airline !== null ? (
        <View style={s.suggestion}>
          <ListItem
            title={`Use ${airline.name}`}
            subtitle={`${airline.iata} — from the flight number`}
            onPress={() => onUseAirline(airline.name)}
            testID={`${testID}-airline-suggestion`}
          />
        </View>
      ) : null}
    </View>
  );
}
