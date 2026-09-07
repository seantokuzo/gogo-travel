/**
 * Add/edit expense form (T-9.6 / CMON-3 — client money spec R-cmoney-7..12,
 * §2.4; the BookingForm family pattern).
 *
 * - Amount is TEXT parsed by the SHARED minor-unit parser against the form's
 *   currency (Law #2 — integer string math; JPY gets the plain number pad,
 *   the B-20/CapInput parity), currency defaults `trip.base_currency`
 *   (P-9 ruling ① 2026-08-25) as an uppercase 3-letter code field (B-20
 *   traits; carries the §2.8 `picker-currency` id).
 * - Split editor per R-cmoney-9 (SplitEditor + evaluateSplit — the shared
 *   `computeShares` drives preview AND gating); participants default to ALL
 *   current members (R-cmoney-7), payer defaults to the caller, date to
 *   today.
 * - Multi-currency (R-cmoney-10): currency ≠ base reveals the FX section —
 *   rate auto-fetched from OUR `GET /fx/rate` when online and not manually
 *   overridden (override always wins; offline/FX-failure requires manual
 *   rate before save); the base amount is DERIVED read-only (BigInt
 *   half-up ∈ the server's floor/ceil consistency window — deriving rather
 *   than free-typing makes an inconsistent R-money-6 pair unrepresentable).
 * - Booking link (R-cmoney-11): trip bookings in a Sheet; selection
 *   prefills amount/description/category via the shared §2.3 mapping
 *   (prefills editable, link removable).
 * - Edit (R-cmoney-12): all fields prefilled, split opens in `exact` with
 *   current shares (+ "Split equally" hint when detectable); submits a
 *   CHANGED-FIELDS-ONLY PATCH — amount⇒shares coupling honored, and
 *   untouched legacy fields naming ex-members ride through by omission
 *   (R-money-5 validates incoming ids only). A changed split that still
 *   contains a former member is save-blocked with visible copy (the server
 *   would reject it — R-ib-24 posture: never render a guaranteed-400 save).
 * - Save is DISABLED until amount > 0, description present, and the split
 *   is valid (R-cmoney-7 — the disabled STATE is pinned, not a vacuous
 *   disabled press); a valid press still re-parses through the shared wire
 *   schema before mutating (`ExpenseCreateSchema`/`ExpenseUpdateSchema`).
 */
import {
  CurrencyCodeSchema,
  ExpenseCreateSchema,
  ExpenseUpdateSchema,
  FxRateSchema,
  minorUnitDigits,
  parseMoneyToCents,
  type Expense,
  type ExpenseCategory,
  type ExpenseCreate,
  type ExpenseUpdate,
  type ISODate,
  type MemberListItem,
  type TripWithRole,
} from "@gogo/shared";
import { createStyles, useTheme } from "@gogo/tokens/react";
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { ApiRequestError } from "@/auth";
import { AppText, Button, ErrorBanner, Icon, Input, ListItem, Sheet } from "@/components";
import {
  useCreateExpense,
  useFxRate,
  useTripBookings,
  useTripOffline,
  useUpdateExpense,
} from "@/data";
import { DateField } from "@/features/trips";
import { localTodayISO } from "@/navigation/trip-defaults";

import { moneyLabel } from "../money-format";
import {
  bookingPrefill,
  deriveBaseAmountCents,
  editSeedFromExpense,
  emptySplitState,
  evaluateSplit,
  EXPENSE_CATEGORY_LABELS,
  EXPENSE_CATEGORY_OPTIONS,
  sameShareSets,
  type SplitFormState,
} from "./expense-form-model";
import { SplitEditor, type SplitParticipantRow } from "./SplitEditor";

export interface ExpenseFormProps {
  trip: TripWithRole;
  members: MemberListItem[];
  callerId: string;
  /** Present ⇒ edit mode (`?expenseId=`). */
  expense?: Expense;
  onDirty(): void;
  onSaved(): void;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    form: { gap: t.space[4] },
    row: { flexDirection: "row", gap: t.space[3] },
    rowItem: { flex: 1 },
    section: { gap: t.space[2] },
    chipsRow: { flexDirection: "row", flexWrap: "wrap", gap: t.space[2] },
    chip: {
      borderRadius: t.radius.full,
      borderWidth: 1,
      borderColor: t.color.border.subtle,
      paddingHorizontal: t.space[3],
      minHeight: t.touchTarget,
      justifyContent: "center",
    },
    chipOn: {
      borderColor: t.color.primary.solid,
      backgroundColor: t.color.bg.inset,
    },
    pickerField: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      minHeight: t.touchTarget,
      borderRadius: t.radius.md,
      borderWidth: 1,
      borderColor: t.color.border.subtle,
      paddingHorizontal: t.space[3],
    },
  }),
);

export function ExpenseForm({
  trip,
  members,
  callerId,
  expense,
  onDirty,
  onSaved,
}: ExpenseFormProps) {
  const s = useStyles();
  const { theme } = useTheme();
  const editing = expense !== undefined;
  const [seed] = useState(() => (expense !== undefined ? editSeedFromExpense(expense) : null));

  const [description, setDescription] = useState(seed?.description ?? "");
  const [amountText, setAmountText] = useState(seed?.amountText ?? "");
  const [currencyText, setCurrencyText] = useState(seed?.currencyText ?? trip.base_currency);
  const [category, setCategory] = useState<ExpenseCategory>(seed?.category ?? "other");
  const [payerId, setPayerId] = useState(seed?.payerId ?? callerId);
  const [spentAt, setSpentAt] = useState<ISODate>(seed?.spentAt ?? localTodayISO());
  const [split, setSplit] = useState<SplitFormState>(
    () => seed?.split ?? emptySplitState(members.map((m) => m.user.id)),
  );
  const [fxRateText, setFxRateText] = useState(seed?.fxRateText ?? "");
  /** Manual override latch (R-cmoney-10) — a stored edit rate counts as one. */
  const [fxRateTouched, setFxRateTouched] = useState(seed !== null && seed.fxRateText !== "");
  const [bookingId, setBookingId] = useState<string | null>(seed?.bookingId ?? null);
  const [payerOpen, setPayerOpen] = useState(false);
  const [bookingOpen, setBookingOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const offline = useTripOffline(trip.id);
  const bookings = useTripBookings(trip.id);

  const create = useCreateExpense(trip.id, {
    onMutationSuccess: () => onSaved(),
    onMutationError: () => setFormError("Couldn't save the expense. Try again."),
  });
  const update = useUpdateExpense(trip.id, {
    onMutationSuccess: () => onSaved(),
    onMutationError: (err) =>
      setFormError(
        err instanceof ApiRequestError && err.status === 409
          ? "This expense was deleted — it can't be edited anymore."
          : "Couldn't save the changes. Try again.",
      ),
  });
  const pending = create.isPending || update.isPending;

  const touch = <T,>(setter: (value: T) => void) => {
    return (value: T): void => {
      onDirty();
      setter(value);
    };
  };

  // -------------------------------------------------------------------------
  // Derived money state (all through the shared helpers — Law #2)
  // -------------------------------------------------------------------------
  const normalizedCurrency = currencyText.trim().toUpperCase();
  const currencyValid = CurrencyCodeSchema.safeParse(normalizedCurrency).success;
  const amountParse =
    amountText.trim() === "" ? null : parseMoneyToCents(amountText, normalizedCurrency);
  const amountCents = amountParse !== null && amountParse.ok ? amountParse.cents : null;
  const needsFx = currencyValid && normalizedCurrency !== trip.base_currency;

  // R-cmoney-10: auto-fetch when online; manual override (or a stored edit
  // rate) wins — the query stays disabled once touched, and the DISPLAYED
  // rate is DERIVED (untouched → the fetched string verbatim; touched → the
  // user's text), so no state ever needs syncing from an effect.
  const fx = useFxRate(normalizedCurrency, trip.base_currency, {
    enabled: needsFx && !offline && !fxRateTouched,
  });
  const effectiveRateText = fxRateTouched ? fxRateText : (fx.data?.rate ?? fxRateText);
  const trimmedRate = effectiveRateText.trim();
  const fxRateValid = FxRateSchema.safeParse(trimmedRate).success;
  const baseCents =
    needsFx && amountCents !== null && fxRateValid
      ? deriveBaseAmountCents(amountCents, trimmedRate, normalizedCurrency, trip.base_currency)
      : null;

  const evaluation = evaluateSplit(amountCents, normalizedCurrency, split);

  // -------------------------------------------------------------------------
  // Roster + legacy participants (ex-members render, removable only)
  // -------------------------------------------------------------------------
  const rosterIds = new Set(members.map((m) => m.user.id));
  const names = new Map(members.map((m) => [m.user.id, m.user.display_name]));
  const nameFor = (userId: string): string => {
    if (userId === callerId) return "You";
    return names.get(userId) ?? "Former member";
  };
  const splitRows: SplitParticipantRow[] = [
    ...members.map((m) => ({
      userId: m.user.id,
      name: nameFor(m.user.id),
      active: split.participants.includes(m.user.id),
      former: false,
    })),
    ...split.participants
      .filter((id) => !rosterIds.has(id))
      .map((id) => ({ userId: id, name: nameFor(id), active: true, former: true })),
  ];

  const amountChanged = editing ? amountCents !== expense.amount_cents : true;
  const sharesChanged =
    !editing || !evaluation.ok ? true : !sameShareSets(evaluation.shares, expense.shares);
  const needSendShares = !editing || amountChanged || sharesChanged;
  const activeFormer = split.participants.filter((id) => !rosterIds.has(id));
  /** A CHANGED split naming an ex-member is a guaranteed server 400 (R-money-5). */
  const formerBlocked = editing && needSendShares && activeFormer.length > 0;

  // -------------------------------------------------------------------------
  // Save gating (R-cmoney-7: disabled until amount > 0, description present,
  // split valid — plus the wire's own preconditions)
  // -------------------------------------------------------------------------
  const valid =
    description.trim() !== "" &&
    amountCents !== null &&
    amountCents > 0 &&
    currencyValid &&
    evaluation.ok &&
    !formerBlocked &&
    (!needsFx || (fxRateValid && baseCents !== null));

  const save = (): void => {
    if (pending || !valid || !evaluation.ok || amountCents === null) return;
    setFormError(null);

    if (!editing) {
      const candidate: ExpenseCreate = {
        description: description.trim(),
        category,
        paid_by: payerId,
        amount_cents: amountCents,
        currency: normalizedCurrency,
        spent_at: spentAt,
        shares: evaluation.shares,
        ...(needsFx && baseCents !== null
          ? { fx_rate: trimmedRate, base_amount_cents: baseCents }
          : {}),
        ...(bookingId !== null ? { booking_id: bookingId } : {}),
      };
      const parsed = ExpenseCreateSchema.safeParse(candidate);
      if (!parsed.success) {
        setFormError("The expense doesn't validate — check the fields.");
        return;
      }
      create.mutate(parsed.data);
      return;
    }

    // CHANGED-FIELDS-ONLY PATCH (module doc): amount ⇒ shares coupling; a
    // currency move back to base clears the stored FX pair explicitly.
    const currencyChanged = normalizedCurrency !== expense.currency;
    const rateChanged = trimmedRate !== (expense.fx_rate ?? "");
    const candidate: ExpenseUpdate = {
      ...(description.trim() !== expense.description ? { description: description.trim() } : {}),
      ...(category !== expense.category ? { category } : {}),
      ...(payerId !== expense.paid_by ? { paid_by: payerId } : {}),
      ...(spentAt !== expense.spent_at ? { spent_at: spentAt } : {}),
      ...(currencyChanged ? { currency: normalizedCurrency } : {}),
      ...(bookingId !== expense.booking_id ? { booking_id: bookingId } : {}),
      ...(amountChanged ? { amount_cents: amountCents } : {}),
      ...(needSendShares ? { shares: evaluation.shares } : {}),
      ...(needsFx && baseCents !== null && (currencyChanged || rateChanged || amountChanged)
        ? { fx_rate: trimmedRate, base_amount_cents: baseCents }
        : {}),
      ...(!needsFx && expense.fx_rate !== null
        ? { fx_rate: null, base_amount_cents: null }
        : {}),
    };
    if (Object.keys(candidate).length === 0) {
      onSaved();
      return;
    }
    const parsed = ExpenseUpdateSchema.safeParse(candidate);
    if (!parsed.success) {
      setFormError("The changes don't validate — check the fields.");
      return;
    }
    update.mutate({ expenseId: expense.id, input: parsed.data });
  };

  const linkedBooking = bookings.data?.items.find((b) => b.id === bookingId);

  return (
    <View style={s.form}>
      {formError !== null ? (
        <ErrorBanner
          message={formError}
          onDismiss={() => setFormError(null)}
          testID="expense-new-error"
        />
      ) : null}

      <Input
        label="Description"
        value={description}
        onChangeText={touch(setDescription)}
        placeholder="e.g. Dinner at Menya"
        maxLength={200}
        testID="expense-new-input-description"
      />

      <View style={s.row}>
        <View style={s.rowItem}>
          <Input
            label="Amount"
            value={amountText}
            onChangeText={touch(setAmountText)}
            placeholder="89.99"
            // B-20/CapInput parity: zero-decimal currencies get the plain
            // number pad — the decimal key only ever produces a parse error.
            keyboardType={minorUnitDigits(normalizedCurrency) === 0 ? "number-pad" : "decimal-pad"}
            maxLength={13}
            helper="Whole amount — stored as exact cents."
            {...(amountParse !== null && !amountParse.ok ? { error: amountParse.error } : {})}
            testID="expense-new-input-amount"
          />
        </View>
        <View style={s.rowItem}>
          <Input
            label="Currency"
            value={currencyText}
            // B-20: ISO-4217 codes are uppercase — normalize as-you-type.
            // A currency change invalidates any manual rate override (a EUR
            // rate is meaningless for GBP) — drop the latch and the text so
            // the fetch for the new pair prefills cleanly.
            onChangeText={(value) => {
              onDirty();
              setFxRateTouched(false);
              setFxRateText("");
              setCurrencyText(value.toUpperCase());
            }}
            placeholder={trip.base_currency}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={3}
            {...(currencyText.trim() !== "" && !currencyValid
              ? { error: "3-letter code, like USD." }
              : {})}
            testID="expense-new-picker-currency"
          />
        </View>
      </View>

      {needsFx ? (
        <View style={s.section}>
          <Input
            label={`Rate (${normalizedCurrency} → ${trip.base_currency})`}
            value={effectiveRateText}
            onChangeText={(value) => {
              onDirty();
              setFxRateTouched(true);
              setFxRateText(value);
            }}
            placeholder="1.0"
            keyboardType="decimal-pad"
            maxLength={19}
            helper={
              offline || fx.isError
                ? "Couldn't fetch a rate — enter it manually."
                : "Fetched automatically — you can override it."
            }
            {...(trimmedRate !== "" && !fxRateValid
              ? { error: "A positive decimal rate, like 0.0067." }
              : {})}
            testID="expense-new-input-fx-rate"
          />
          <Input
            label={`Amount in ${trip.base_currency}`}
            value={baseCents !== null ? moneyLabel(baseCents, trip.base_currency) : ""}
            onChangeText={() => undefined}
            editable={false}
            helper="Converted at the rate above — balances use this."
            testID="expense-new-input-base-amount"
          />
        </View>
      ) : null}

      <View style={s.section}>
        <AppText role="caption" color="secondary">
          Category
        </AppText>
        <View style={s.chipsRow} testID="expense-new-picker-category">
          {EXPENSE_CATEGORY_OPTIONS.map((option) => (
            <Pressable
              key={option}
              style={[s.chip, category === option && s.chipOn]}
              onPress={() => touch(setCategory)(option)}
              accessibilityRole="radio"
              accessibilityState={{ selected: category === option }}
              accessibilityLabel={`Category ${EXPENSE_CATEGORY_LABELS[option]}`}
              testID={`expense-new-picker-category-${option}`}
            >
              <AppText role="caption">{EXPENSE_CATEGORY_LABELS[option]}</AppText>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={s.row}>
        <View style={s.rowItem}>
          <View style={s.section}>
            <AppText role="caption" color="secondary">
              Paid by
            </AppText>
            <Pressable
              style={s.pickerField}
              onPress={() => setPayerOpen(true)}
              accessibilityRole="button"
              accessibilityLabel={`Paid by ${nameFor(payerId)}`}
              testID="expense-new-picker-payer"
            >
              <AppText role="body">{nameFor(payerId)}</AppText>
              <Icon name="chevron-down" size={16} color={theme.color.text.muted} />
            </Pressable>
          </View>
        </View>
        <View style={s.rowItem}>
          <DateField
            label="Date"
            value={spentAt}
            contextDate={trip.start_date}
            onSelect={(date) => {
              // PR #49 R1: a same-value Done commit must not arm the guard.
              if (date === spentAt) return;
              touch(setSpentAt)(date);
            }}
            testID="expense-new-input-date"
          />
        </View>
      </View>

      <View style={s.section}>
        <AppText role="caption" color="secondary">
          Split
        </AppText>
        <SplitEditor
          currency={normalizedCurrency}
          rows={splitRows}
          split={split}
          evaluation={evaluation}
          equallySplitHint={seed?.equallySplit === true}
          nameFor={nameFor}
          onChange={(next) => {
            onDirty();
            setSplit(next);
          }}
        />
        {formerBlocked ? (
          <AppText
            role="caption"
            accessibilityLiveRegion="polite"
            testID="expense-new-split-former-blocked"
          >
            {"A changed split can't keep former members — remove them, or leave the split as it was."}
          </AppText>
        ) : null}
      </View>

      <Button
        title={linkedBooking !== undefined ? `Booking: ${linkedBooking.title}` : "Link a booking"}
        variant="ghost"
        onPress={() => setBookingOpen(true)}
        testID="expense-new-button-booking-link"
      />

      <Button
        title={editing ? "Save changes" : "Save"}
        onPress={save}
        loading={pending}
        disabled={!valid}
        fullWidth
        testID="expense-new-button-save"
      />

      <Sheet
        visible={payerOpen}
        onDismiss={() => setPayerOpen(false)}
        title="Who paid?"
        testID="expense-new-sheet-payer"
      >
        {members.map((member) => (
          <ListItem
            key={member.user.id}
            title={nameFor(member.user.id)}
            {...(member.user.id === payerId
              ? {
                  trailing: (
                    <Icon name="checkmark" size={18} color={theme.color.primary.solid} />
                  ),
                }
              : {})}
            onPress={() => {
              touch(setPayerId)(member.user.id);
              setPayerOpen(false);
            }}
            testID={`expense-new-sheet-payer-${member.user.id}`}
          />
        ))}
      </Sheet>

      <Sheet
        visible={bookingOpen}
        onDismiss={() => setBookingOpen(false)}
        title="Link a booking"
        testID="expense-new-sheet-booking"
      >
        {bookingId !== null ? (
          <ListItem
            title="Remove the link"
            onPress={() => {
              touch(setBookingId)(null);
              setBookingOpen(false);
            }}
            testID="expense-new-sheet-booking-remove"
          />
        ) : null}
        {(bookings.data?.items ?? []).map((booking) => (
          <ListItem
            key={booking.id}
            title={booking.title}
            {...(booking.price_cents !== null && booking.currency !== null
              ? { subtitle: moneyLabel(booking.price_cents, booking.currency) }
              : {})}
            onPress={() => {
              // R-cmoney-11: prefill amount/description/category (§2.3
              // mapping) — prefills editable, currency rides with the price.
              onDirty();
              const prefill = bookingPrefill(booking);
              setBookingId(booking.id);
              setDescription(prefill.description);
              setCategory(prefill.category);
              if (prefill.amountText !== null && prefill.currencyText !== null) {
                setAmountText(prefill.amountText);
                setCurrencyText(prefill.currencyText);
              }
              setBookingOpen(false);
            }}
            testID={`expense-new-sheet-booking-${booking.id}`}
          />
        ))}
        {bookings.data !== undefined && bookings.data.items.length === 0 ? (
          <AppText role="caption" color="secondary">
            No bookings on this trip yet.
          </AppText>
        ) : null}
      </Sheet>
    </View>
  );
}
