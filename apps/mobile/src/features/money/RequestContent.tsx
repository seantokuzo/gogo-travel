/**
 * Settle-request recipient screen content (T-9.7 / CMON-6 — R-cmoney-26/27;
 * §2.7 step 4), mounted by `money/request/[requestId]` — the R-nav-13
 * deep-link target (`/t/<tripId>/request/<requestId>`, auth stash-resume
 * upstream per R-nav-14; the `[tripId]` layout's membership guard is the
 * R-cmoney-27 members-only door).
 *
 * Views by the caller's seat on the Q2 document:
 * - DEBTOR (`from_user_id`): requester + trip + amount headline, note, the
 *   SAME rail machinery as the settle screen (RailList inline — rails from
 *   the requester's member-visible handles, R-cmoney-31) and
 *   mark-as-settled; paying through this screen links the settlement
 *   (`request_id` on S1 — R-money-18), flipping the request for both
 *   parties. Rail taps stash WITH `requestId` so the R-cmoney-21 return
 *   prompt's confirm also rides the linkage.
 * - CREDITOR (`to_user_id` = creator): own-request view — status line +
 *   cancel via ConfirmDialog (Q3; §2.7 step 5's cancel affordance — the
 *   balances-row annotation surface stays seam-only pending the flagged
 *   spec gap: no settle-request LIST endpoint exists).
 * - OTHER MEMBER: read-only summary (S1's party rule would 403 an
 *   uninvolved recorder — no actions rendered).
 *
 * `settled` / `cancelled` / derived-`resolved` render the resolved state —
 * no pay buttons (R-cmoney-26); who-settled-when comes from the S2 lookup
 * when the linked settlement sits in the first page (best-effort by
 * construction — beyond it the copy degrades to the generic resolved
 * line). Unknown id / non-member → the SAME 404 (indistinguishable,
 * R-money-25) → EmptyState with a path back to the money tab.
 *
 * The S1 409 arm (raced settle/cancel) gets SPECIFIC copy + a detail
 * refetch (the data hook refreshes on error) — never a generic banner.
 */
import type { SettleRequestDetail, TripWithRole } from "@gogo/shared";
import { createStyles, useTheme } from "@gogo/tokens/react";
import * as Clipboard from "expo-clipboard";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { ApiRequestError, useSessionStore } from "@/auth";
import {
  AppText,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  PageHeader,
  Skeleton,
} from "@/components";
import { useTripMembers } from "@/data";
import {
  useCancelSettleRequest,
  useCreateSettlement,
  useSettleRequestDetail,
  useTripSettlements,
} from "@/data/settlements";
import { triggerHaptic } from "@/theme/haptics";

import { MarkSettledSheet, type MarkSettledConfirm } from "./MarkSettledSheet";
import { moneyLabel } from "./money-format";
import { buildRails, railAmountText } from "./rails";
import { RailList, type OpenableRail, type ZelleRail } from "./RailList";
import {
  clearSettleReturnRecord,
  recordSettleDeeplinkOut,
  type SettleReturnRecord,
} from "./settle-return-store";
import { SettleReturnSheet } from "./SettleReturnSheet";
import { useSettleReturnPrompt } from "./useSettleReturnPrompt";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.color.bg.screen },
    body: { padding: t.space[4], gap: t.space[3] },
    state: { flex: 1, justifyContent: "center" },
    skeleton: { padding: t.space[4], gap: t.space[3] },
  }),
);

export interface RequestContentProps {
  trip: TripWithRole;
  requestId: string;
}

export function RequestContent({ trip, requestId }: RequestContentProps) {
  const s = useStyles();
  const { theme } = useTheme();
  const router = useRouter();
  const me = useSessionStore((state) => state.user);
  const detail = useSettleRequestDetail(trip.id, requestId);
  const members = useTripMembers(trip.id);
  // Only fetch the who-settled-when lookup when there is a linked
  // settlement to name (best-effort resolved copy — module doc).
  const settlements = useTripSettlements(trip.id, {
    enabled: typeof detail.data?.settlement_id === "string",
  });
  const returnPrompt = useSettleReturnPrompt(trip.id);

  const [sheet, setSheet] = useState<"none" | "mark-settled">("none");
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [railError, setRailError] = useState<string | null>(null);
  const [zelleCopied, setZelleCopied] = useState(false);
  const [settleError, setSettleError] = useState<string | null>(null);
  const [returnError, setReturnError] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const callerId = me?.id ?? "";

  const paySettlement = useCreateSettlement(trip.id, {
    onMutationSuccess: () => {
      triggerHaptic("success");
      setSettleError(null);
      setSheet("none");
    },
    onMutationError: (err) => {
      setSettleError(
        err instanceof ApiRequestError && err.status === 409
          ? "This request was already settled or cancelled — the screen has been refreshed."
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
      setReturnError(
        err instanceof ApiRequestError && err.status === 409
          ? "This request was already settled or cancelled — the payment wasn't recorded through it."
          : "Couldn't record the settlement. Please try again.",
      );
    },
  });
  const cancelRequest = useCancelSettleRequest(trip.id, {
    onMutationSuccess: () => {
      setCancelError(null);
    },
    onMutationError: (err) => {
      setCancelError(
        err instanceof ApiRequestError && err.status === 409
          ? "This request already moved — it was settled or cancelled elsewhere."
          : "Couldn't cancel the request. Please try again.",
      );
    },
  });

  const backToMoney = () => {
    // Same-tab stack (the request route lives INSIDE money) — a plain
    // replace is safe; cross-tab jumps are the forbidden class.
    router.replace({ pathname: "/[tripId]/money", params: { tripId: trip.id } });
  };

  // DATA-FIRST precedence (R1 — SettleContent's order is the precedent):
  // the error/404 states render only when there is NO cached document. With
  // data present, a failed background refetch keeps the rendered screen —
  // never blanks it into a banner.
  if (detail.data === undefined) {
    if (detail.isError) {
      const notFound = detail.error instanceof ApiRequestError && detail.error.status === 404;
      return (
        <View style={s.screen} testID="settle-request-screen">
          <PageHeader title="Settle request" leading="back" testID="settle-request-header" />
          <View style={s.state}>
            {notFound ? (
              // Unknown id / non-member — indistinguishable by design
              // (R-money-25); the registry's "missing request" row.
              <EmptyState
                icon="help-circle-outline"
                title="This request isn't available"
                body="It may have been removed, or the link is wrong."
                action={{
                  label: "Back to money",
                  onPress: backToMoney,
                  testID: "settle-request-button-back",
                }}
                testID="settle-request-empty"
              />
            ) : (
              <ErrorBanner
                message="Couldn't load the request."
                onRetry={() => void detail.refetch()}
                testID="settle-request-error"
              />
            )}
          </View>
          {!notFound ? (
            <View style={s.body}>
              <Button
                title="Back to money"
                variant="ghost"
                fullWidth
                onPress={backToMoney}
                testID="settle-request-button-back"
              />
            </View>
          ) : null}
        </View>
      );
    }

    return (
      <View style={s.screen} testID="settle-request-screen">
        <PageHeader title="Settle request" leading="back" testID="settle-request-header" />
        <View style={s.skeleton} testID="settle-request-loading">
          <Skeleton variant="rect" height={88} />
          <Skeleton variant="rect" height={56} />
          <Skeleton variant="rect" height={44} />
        </View>
      </View>
    );
  }

  const request: SettleRequestDetail = detail.data;
  const requester = request.requester;
  const amountLabel = moneyLabel(request.amount_cents, request.currency);
  const seat =
    callerId === request.from_user_id
      ? "debtor"
      : callerId === request.to_user_id
        ? "creditor"
        : "observer";
  const open = request.status === "open" && !request.resolved;

  const nameFor = (userId: string): string => {
    if (userId === callerId) return "You";
    if (userId === requester.id) return requester.display_name;
    return (
      members.data?.items.find((m) => m.user.id === userId)?.user.display_name ?? "Former member"
    );
  };

  // Who settled, when (R-cmoney-26 resolved copy) — S2 first-page lookup.
  const linkedSettlement =
    request.settlement_id === null
      ? undefined
      : settlements.data?.items.find((row) => row.id === request.settlement_id);
  const resolvedLine =
    request.status === "cancelled"
      ? "This request was cancelled."
      : linkedSettlement !== undefined
        ? `Settled by ${nameFor(linkedSettlement.created_by)} on ${new Date(linkedSettlement.settled_at).toLocaleDateString()}.`
        : request.status === "settled"
          ? "This request has been settled."
          : "Already settled up — this debt was cleared another way.";

  const rails = buildRails(requester, {
    currency: request.currency,
    amountCents: request.amount_cents,
    tripName: trip.name,
  });

  const openRail = (rail: OpenableRail) => {
    // Stash BEFORE the URL opens — WITH the requestId, so the return
    // prompt's confirm rides the R-money-18 linkage. Store stamps the tap.
    recordSettleDeeplinkOut({
      tripId: trip.id,
      counterpartyId: request.to_user_id,
      method: rail.kind,
      amountCents: request.amount_cents,
      requestId: request.id,
    });
    const openUrl = async (): Promise<void> => {
      let url: string;
      if (rail.kind === "venmo") {
        const canOpen = await Linking.canOpenURL(rail.appUrl).catch(() => false);
        url = canOpen ? rail.appUrl : rail.webUrl;
      } else {
        url = rail.url;
      }
      await Linking.openURL(url);
    };
    openUrl()
      .then(() => setRailError(null))
      .catch(() => {
        clearSettleReturnRecord();
        setRailError("Couldn't open the payment app — try another option.");
      });
  };

  const copyZelle = (rail: ZelleRail) => {
    void Clipboard.setStringAsync(rail.handle)
      .then(() => {
        setZelleCopied(true);
        triggerHaptic("success");
      })
      .catch(() => setRailError("Couldn't copy the handle."));
  };

  const payThrough = (input: MarkSettledConfirm) => {
    setSettleError(null);
    paySettlement.mutate({
      from_user_id: request.from_user_id,
      to_user_id: request.to_user_id,
      amount_cents: input.amount_cents,
      currency: request.currency,
      method: input.method,
      request_id: request.id,
      ...(input.note !== undefined ? { note: input.note } : {}),
    });
  };

  const confirmReturn = (record: SettleReturnRecord) => {
    setReturnError(null);
    returnConfirm.mutate({
      from_user_id: callerId,
      to_user_id: record.counterpartyId,
      amount_cents: record.amountCents,
      currency: request.currency,
      method: record.method,
      ...(record.requestId !== undefined ? { request_id: record.requestId } : {}),
    });
  };

  return (
    <View style={s.screen} testID="settle-request-screen">
      <PageHeader
        title="Settle request"
        subtitle={trip.name}
        leading="back"
        testID="settle-request-header"
      />
      <ScrollView contentContainerStyle={s.body}>
        <Card testID="settle-request-headline">
          <AppText role="heading">
            {seat === "creditor"
              ? `You requested ${amountLabel} from ${nameFor(request.from_user_id)}`
              : `${requester.display_name} requests ${amountLabel}`}
          </AppText>
          {request.note !== null ? (
            <AppText role="body" color="secondary">
              {request.note}
            </AppText>
          ) : null}
        </Card>

        {!open ? (
          // Resolved state (R-cmoney-26): no pay buttons.
          <Card testID="settle-request-resolved">
            <AppText role="body" style={{ color: theme.color.status.success.fg }}>
              {resolvedLine}
            </AppText>
          </Card>
        ) : seat === "debtor" ? (
          <>
            {settleError !== null ? (
              <ErrorBanner message={settleError} testID="settle-request-settle-error" />
            ) : null}
            <RailList
              rails={rails}
              counterpartyName={requester.display_name}
              amountLabel={`${request.currency} ${railAmountText(request.amount_cents, request.currency)}`}
              railError={railError}
              zelleCopied={zelleCopied}
              onOpenRail={openRail}
              onCopyZelle={copyZelle}
              onMarkSettled={() => setSheet("mark-settled")}
              testIDBase="settle-request"
            />
          </>
        ) : seat === "creditor" ? (
          <>
            {cancelError !== null ? (
              <ErrorBanner message={cancelError} testID="settle-request-cancel-error" />
            ) : null}
            <AppText role="body" color="secondary">
              Waiting for {nameFor(request.from_user_id)} to settle up.
            </AppText>
            <Button
              title="Cancel request"
              variant="destructive"
              fullWidth
              loading={cancelRequest.isPending}
              onPress={() => setCancelConfirm(true)}
              testID="settle-request-button-cancel"
            />
          </>
        ) : (
          // Uninvolved member: read-only (the S1 party rule would 403).
          <AppText role="body" color="secondary" testID="settle-request-observer">
            Waiting for {nameFor(request.from_user_id)} to settle up with{" "}
            {nameFor(request.to_user_id)}.
          </AppText>
        )}
      </ScrollView>

      {/* Mounted per presentation (remount idiom) — prefill at mount. */}
      {sheet === "mark-settled" ? (
        <MarkSettledSheet
          visible
          currency={request.currency}
          defaultAmountCents={request.amount_cents}
          pending={paySettlement.isPending}
          errorMessage={settleError}
          onConfirm={payThrough}
          onDismiss={() => {
            if (!paySettlement.isPending) {
              setSettleError(null);
              setSheet("none");
            }
          }}
          testIDBase="settle-request"
        />
      ) : null}
      <ConfirmDialog
        visible={cancelConfirm}
        title="Cancel this request?"
        body={`The link you shared will show it as cancelled. ${nameFor(request.from_user_id)} still owes whatever the balances say.`}
        confirmLabel="Cancel request"
        cancelLabel="Keep it"
        destructive
        onConfirm={() => {
          setCancelConfirm(false);
          cancelRequest.mutate({ requestId: request.id });
        }}
        onCancel={() => setCancelConfirm(false)}
        testID="settle-request-dialog-cancel"
      />
      <SettleReturnSheet
        record={returnPrompt.record}
        counterpartyName={
          returnPrompt.record !== null ? nameFor(returnPrompt.record.counterpartyId) : ""
        }
        amountLabel={
          returnPrompt.record !== null
            ? moneyLabel(returnPrompt.record.amountCents, request.currency)
            : moneyLabel(0, request.currency)
        }
        pending={returnConfirm.isPending}
        errorMessage={returnError}
        onConfirm={confirmReturn}
        onDismiss={() => {
          setReturnError(null);
          returnPrompt.dismiss();
        }}
        testIDBase="settle-request"
      />
    </View>
  );
}
