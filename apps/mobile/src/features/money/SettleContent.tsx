/**
 * Settle screen content (T-9.7 / CMON-5 — R-cmoney-14..24; §2.6), mounted
 * by `money/settle/[memberId]` (push off balances rows/chips, §2.6 step 1).
 *
 * - Headline = the caller's pairwise position vs the counterparty
 *   (R-cmoney-14), amount field prefilled to the FULL owed amount and
 *   editable — parsed through the shared ISO-4217 helper (Law #2), values
 *   above the owed amount warn without blocking (partial settles legal).
 * - DEBTOR view: "Settle up" opens the handoff Sheet — RailList (one
 *   button per counterparty handle, Zelle copy row, USD gating) with
 *   "Mark as settled" always last (R-cmoney-20).
 * - CREDITOR view (R-cmoney-23): rails replaced by "Request payment"
 *   (SendBillSheet — §2.7) and "Mark as settled" (records money received:
 *   from = counterparty, to = caller; either party may record,
 *   R-money-12).
 * - SETTLED pair: headline "all settled up"; mark-as-settled stays
 *   available (R-cmoney-20 unconditional) framed as caller → counterparty.
 * - Rail tap: stash the pending record BEFORE `Linking.openURL`
 *   (settle-return-store; the R-itin-22 order); Venmo prefers the app
 *   scheme behind `canOpenURL` and falls back to the probed web URL either
 *   way (R-cmoney-16 — a throwing/false probe is the fallback arm, which
 *   also covers Android's missing `<queries>` manifest without a crash);
 *   an open failure clears the stash and surfaces a NON-BLOCKING error —
 *   the screen stays fully usable (R-cmoney-22).
 * - Return prompt (R-cmoney-21): useSettleReturnPrompt presents the
 *   "Did you complete the payment?" Sheet once within 30 minutes; confirm
 *   posts the STASHED method/amount (+ request_id when the tap came from a
 *   request screen — R-money-18); the S1 409 on that arm gets SPECIFIC
 *   copy (the request moved), never a generic banner.
 *
 * Counterparties missing from the live roster (ex-members, T-9.3 [I-2])
 * label "Former member" and render zero rails (handles come from the
 * member-visible roster ONLY — R-cmoney-31); mark-as-settled still works
 * (the party rule binds the CALLER's membership, not the counterparty's).
 */
import { parseMoneyToCents, type TripWithRole, type UserProfile } from "@gogo/shared";
import { createStyles, useTheme } from "@gogo/tokens/react";
import * as Clipboard from "expo-clipboard";
import * as Linking from "expo-linking";
import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { ApiRequestError, useSessionStore } from "@/auth";
import { AppText, Button, Card, ErrorBanner, Input, PageHeader, Skeleton } from "@/components";
import { useTripBalances, useTripMembers, useTripOffline } from "@/data";
import { useCreateSettlement } from "@/data/settlements";
import { triggerHaptic } from "@/theme/haptics";

import { MarkSettledSheet, type MarkSettledConfirm } from "./MarkSettledSheet";
import { moneyLabel } from "./money-format";
import { buildRails, railAmountText, type Rail } from "./rails";
import type { OpenableRail, ZelleRail } from "./RailList";
import { SendBillSheet } from "./SendBillSheet";
import { SettleHandoffSheet } from "./SettleHandoffSheet";
import { centsToAmountText, pairwiseNet } from "./settle-position";
import {
  clearSettleReturnRecord,
  recordSettleDeeplinkOut,
  type SettleReturnRecord,
} from "./settle-return-store";
import { SettleReturnSheet } from "./SettleReturnSheet";
import { useSettleReturnPrompt } from "./useSettleReturnPrompt";

const NO_HANDLES: Pick<
  UserProfile,
  "venmo_username" | "cashtag" | "paypalme_username" | "zelle_handle" | "zelle_display_name"
> = {
  venmo_username: null,
  cashtag: null,
  paypalme_username: null,
  zelle_handle: null,
  zelle_display_name: null,
};

const useStyles = createStyles((t) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.color.bg.screen },
    body: { padding: t.space[4], gap: t.space[3] },
    banner: { paddingHorizontal: t.space[4], paddingTop: t.space[2] },
    skeleton: { padding: t.space[4], gap: t.space[3] },
  }),
);

type SheetState = "none" | "handoff" | "mark-settled" | "send-bill";

export interface SettleContentProps {
  trip: TripWithRole;
  memberId: string;
}

export function SettleContent({ trip, memberId }: SettleContentProps) {
  const s = useStyles();
  const { theme } = useTheme();
  const me = useSessionStore((state) => state.user);
  const balances = useTripBalances(trip.id);
  const members = useTripMembers(trip.id);
  const offline = useTripOffline(trip.id);
  const returnPrompt = useSettleReturnPrompt(trip.id);

  const [sheet, setSheet] = useState<SheetState>("none");
  /** null = untouched → prefill tracks the live owed amount (R-cmoney-14). */
  const [editedAmount, setEditedAmount] = useState<string | null>(null);
  const [railError, setRailError] = useState<string | null>(null);
  const [zelleCopied, setZelleCopied] = useState(false);
  const [settleError, setSettleError] = useState<string | null>(null);
  const [returnError, setReturnError] = useState<string | null>(null);

  const callerId = me?.id ?? "";
  const currency = trip.base_currency;

  // TWO mutation instances on purpose (the T-6.8/T-6.9 per-call-drop
  // landmine — banner side effects ride the HOOK-level seam, which fires
  // for every settled call): one for the mark-as-settled sheet, one for
  // the return-prompt confirm — each with its own error surface.
  const markSettled = useCreateSettlement(trip.id, {
    onMutationSuccess: () => {
      triggerHaptic("success");
      setSettleError(null);
      setSheet("none");
    },
    onMutationError: (err) => {
      setSettleError(
        err instanceof ApiRequestError && err.status === 400
          ? "That settlement isn't valid — check the amount."
          : "Couldn't record the settlement. Please try again.",
      );
    },
  });
  const returnConfirm = useCreateSettlement(trip.id, {
    onMutationSuccess: () => {
      triggerHaptic("success");
      setReturnError(null);
      returnPrompt.dismiss();
    },
    onMutationError: (err) => {
      // The 409 arm is SPECIFIC (server state machine, R-money-18): the
      // linked request moved — settled or cancelled elsewhere.
      setReturnError(
        err instanceof ApiRequestError && err.status === 409
          ? "That request was already settled or cancelled, so it can't be paid through anymore."
          : "Couldn't record the settlement. Please try again.",
      );
    },
  });

  const settled = balances.data !== undefined && members.data !== undefined;
  const failed = balances.isError || members.isError;
  const retry = () => {
    if (balances.isError) void balances.refetch();
    if (members.isError) void members.refetch();
  };

  const member = members.data?.items.find((m) => m.user.id === memberId);
  const name = member?.user.display_name ?? "Former member";

  if (!settled) {
    return (
      <View style={s.screen} testID="settle-screen">
        <PageHeader title="Settle up" leading="back" testID="settle-header" />
        {failed ? (
          <View style={s.banner}>
            <ErrorBanner
              message={
                offline
                  ? "You're offline and this trip's balances aren't cached yet."
                  : "Couldn't load the balances."
              }
              onRetry={retry}
              testID="settle-error"
            />
          </View>
        ) : (
          <View style={s.skeleton} testID="settle-loading">
            <Skeleton variant="rect" height={88} />
            <Skeleton variant="rect" height={56} />
            <Skeleton variant="rect" height={44} />
          </View>
        )}
      </View>
    );
  }

  // Signed pairwise position: + = counterparty owes the caller.
  const net = pairwiseNet(balances.data, callerId, memberId);
  const owed = Math.abs(net);
  const view = net < 0 ? "debtor" : net > 0 ? "creditor" : "even";

  const amountText = editedAmount ?? (owed > 0 ? centsToAmountText(owed, currency) : "");
  const parsed = parseMoneyToCents(amountText, currency);
  const amountCents = parsed.ok ? parsed.cents : 0;
  const amountError = amountText.length > 0 && !parsed.ok ? parsed.error : undefined;
  // Non-blocking over-payment warning (R-cmoney-14) — never gates actions.
  const overWarning =
    parsed.ok && owed > 0 && parsed.cents > owed
      ? `More than the ${moneyLabel(owed, currency)} owed — recording more is allowed.`
      : undefined;

  const rails: Rail[] = buildRails(member?.user ?? NO_HANDLES, {
    currency,
    amountCents: amountCents > 0 ? amountCents : owed,
    tripName: trip.name,
  });

  const headline =
    view === "debtor"
      ? `You owe ${name} ${moneyLabel(owed, currency)}`
      : view === "creditor"
        ? `${name} owes you ${moneyLabel(owed, currency)}`
        : `You're all settled up with ${name}`;
  const headlineColor =
    view === "debtor"
      ? theme.color.status.danger.fg
      : view === "creditor"
        ? theme.color.status.success.fg
        : theme.color.text.secondary;

  const openRail = (rail: OpenableRail) => {
    // Stash BEFORE the URL opens (R-itin-22 order): the record IS the
    // return prompt's data; an open failure rolls it back below. The
    // store stamps the tap instant.
    recordSettleDeeplinkOut({
      tripId: trip.id,
      counterpartyId: memberId,
      method: rail.kind,
      amountCents: amountCents > 0 ? amountCents : owed,
    });
    const open = async (): Promise<void> => {
      let url: string;
      if (rail.kind === "venmo") {
        // R-cmoney-16: app scheme when installed, probed web URL otherwise;
        // a throwing canOpenURL (Android missing <queries>) is the web arm.
        const canOpen = await Linking.canOpenURL(rail.appUrl).catch(() => false);
        url = canOpen ? rail.appUrl : rail.webUrl;
      } else {
        url = rail.url;
      }
      await Linking.openURL(url);
    };
    open()
      .then(() => {
        setRailError(null);
        setSheet("none");
      })
      .catch(() => {
        // R-cmoney-22: non-blocking; the stash rolls back so no phantom
        // return prompt fires for a payment that never started.
        clearSettleReturnRecord();
        setRailError("Couldn't open the payment app — try another option.");
      });
  };

  const copyZelle = (rail: ZelleRail) => {
    void Clipboard.setStringAsync(rail.handle)
      .then(() => {
        // R-cmoney-19: clipboard + confirmation + haptic. The DS has no
        // toast (R-ds-17 posture) — the button's "Copied" state is the
        // visible confirmation.
        setZelleCopied(true);
        triggerHaptic("success");
      })
      .catch(() => {
        setRailError("Couldn't copy the handle.");
      });
  };

  const recordSettlement = (input: MarkSettledConfirm, direction: "pay" | "receive") => {
    setSettleError(null);
    markSettled.mutate({
      from_user_id: direction === "pay" ? callerId : memberId,
      to_user_id: direction === "pay" ? memberId : callerId,
      amount_cents: input.amount_cents,
      currency,
      method: input.method,
      ...(input.note !== undefined ? { note: input.note } : {}),
    });
  };

  const confirmReturn = (record: SettleReturnRecord) => {
    setReturnError(null);
    returnConfirm.mutate({
      from_user_id: callerId,
      to_user_id: record.counterpartyId,
      amount_cents: record.amountCents,
      currency,
      method: record.method,
      ...(record.requestId !== undefined ? { request_id: record.requestId } : {}),
    });
  };

  return (
    <View style={s.screen} testID="settle-screen">
      <PageHeader title="Settle up" subtitle={trip.name} leading="back" testID="settle-header" />
      {offline ? (
        <View style={s.banner}>
          <ErrorBanner
            tone="warning"
            message="You're offline — showing your last synced balances."
            testID="settle-banner-offline"
          />
        </View>
      ) : null}
      <ScrollView contentContainerStyle={s.body}>
        <Card testID="settle-headline">
          <AppText role="heading" style={{ color: headlineColor }}>
            {headline}
          </AppText>
        </Card>
        <Input
          label={`Amount (${currency})`}
          value={amountText}
          onChangeText={(text) => setEditedAmount(text)}
          keyboardType="decimal-pad"
          autoCorrect={false}
          {...(amountError !== undefined
            ? { error: amountError }
            : overWarning !== undefined
              ? { helper: overWarning }
              : {})}
          testID="settle-input-amount"
        />
        {railError !== null && sheet === "none" ? (
          <ErrorBanner message={railError} testID="settle-rail-error" />
        ) : null}
        {view === "creditor" ? (
          <>
            {/* R-cmoney-23: rails replaced by request + received-record. */}
            <Button
              title="Request payment"
              icon="paper-plane-outline"
              fullWidth
              disabled={!parsed.ok || amountCents <= 0}
              onPress={() => setSheet("send-bill")}
              testID="settle-button-request"
            />
            <Button
              title="Mark as settled"
              variant="secondary"
              fullWidth
              onPress={() => setSheet("mark-settled")}
              testID="settle-button-mark-settled"
            />
          </>
        ) : (
          <Button
            title="Settle up"
            icon="swap-horizontal"
            fullWidth
            disabled={!parsed.ok || amountCents <= 0}
            onPress={() => {
              setRailError(null);
              setZelleCopied(false);
              setSheet("handoff");
            }}
            testID="settle-button-settle-up"
          />
        )}
      </ScrollView>

      <SettleHandoffSheet
        visible={sheet === "handoff"}
        rails={rails}
        counterpartyName={name}
        amountLabel={`${currency} ${railAmountText(amountCents > 0 ? amountCents : owed, currency)}`}
        railError={railError}
        zelleCopied={zelleCopied}
        onOpenRail={openRail}
        onCopyZelle={copyZelle}
        onMarkSettled={() => setSheet("mark-settled")}
        onDismiss={() => setSheet("none")}
        testIDBase="settle"
      />
      {/* Stateful sheets mount per presentation (ManualAddBookingSheet
          remount idiom) — prefill snapshots at mount, no reset effects. */}
      {sheet === "mark-settled" ? (
        <MarkSettledSheet
          visible
          currency={currency}
          defaultAmountCents={amountCents > 0 ? amountCents : owed}
          pending={markSettled.isPending}
          errorMessage={settleError}
          onConfirm={(input) => recordSettlement(input, view === "creditor" ? "receive" : "pay")}
          onDismiss={() => {
            if (!markSettled.isPending) {
              setSettleError(null);
              setSheet("none");
            }
          }}
          testIDBase="settle"
        />
      ) : null}
      {sheet === "send-bill" ? (
        <SendBillSheet
          visible
          tripId={trip.id}
          tripName={trip.name}
          currency={currency}
          debtorId={memberId}
          debtorName={name}
          requesterName={me?.display_name ?? "A trip member"}
          defaultAmountCents={amountCents > 0 ? amountCents : owed}
          onDismiss={() => setSheet("none")}
        />
      ) : null}
      <SettleReturnSheet
        record={returnPrompt.record}
        counterpartyName={
          returnPrompt.record !== null
            ? (members.data?.items.find((m) => m.user.id === returnPrompt.record?.counterpartyId)
                ?.user.display_name ?? "Former member")
            : name
        }
        amountLabel={
          returnPrompt.record !== null
            ? moneyLabel(returnPrompt.record.amountCents, currency)
            : moneyLabel(0, currency)
        }
        pending={returnConfirm.isPending}
        errorMessage={returnError}
        onConfirm={confirmReturn}
        onDismiss={() => {
          setReturnError(null);
          returnPrompt.dismiss();
        }}
        testIDBase="settle"
      />
    </View>
  );
}
