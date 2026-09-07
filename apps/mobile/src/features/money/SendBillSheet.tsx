/**
 * Send-the-bill Sheet (T-9.7 / CMON-6 — R-cmoney-25; §2.7 steps 2–3).
 * Amount (prefilled from the displayed balance, editable — parsed through
 * the shared ISO-4217 helper, Law #2) + optional note →
 * `POST /settle-requests` → the iOS share sheet with the composed message.
 *
 * LINK COMPOSITION (P-9 W2 ruling; the PR #32 [SR-4] split): the message
 * carries the client-composed `gogo://` deep link as PRIMARY — derived
 * from the SAME shared template (`settleRequestDeepLink`,
 * @gogo/shared/config/links) the server's https `link` is built from, so
 * the two forms cannot drift — with the wire's placeholder-https form
 * appended (dead until the P-14 domain purchase). Both links carry the two
 * UUIDs and NOTHING else (PR #32 security posture — no params).
 *
 * Copy affordance as share fallback (§2.7 step 3): after create, the link
 * can be copied to the clipboard; share can be re-invoked. The share sheet
 * failing/dismissing never orphans the request — the created state stays
 * up with both affordances.
 *
 * Q1's 409 arm (no positive debt on the DEFAULTED path) is defensive here
 * — this sheet always POSTs an explicit amount — but a stale balance can
 * still race a concurrent settlement, so the arm gets specific copy, not a
 * generic banner.
 */
import { parseMoneyToCents, settleRequestDeepLink, type SettleRequest } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { Share, StyleSheet, View } from "react-native";

import { ApiRequestError } from "@/auth";
import { AppText, Button, ErrorBanner, Input, Sheet } from "@/components";
import { useCreateSettleRequest } from "@/data/settlements";
import { triggerHaptic } from "@/theme/haptics";

import { moneyLabel } from "./money-format";
import { centsToAmountText } from "./settle-position";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    body: { gap: t.space[3], paddingBottom: t.space[2] },
  }),
);

/** §2.7 step 3 message — amount + trip name + gogo:// primary + https form. */
export function composeShareMessage(
  requesterName: string,
  tripName: string,
  request: SettleRequest,
): string {
  const amount = moneyLabel(request.amount_cents, request.currency);
  const deepLink = settleRequestDeepLink(request.trip_id, request.id);
  return `${requesterName} requests ${amount} for ${tripName} — settle up in GoGo: ${deepLink} (web: ${request.link})`;
}

export interface SendBillSheetProps {
  visible: boolean;
  tripId: string;
  tripName: string;
  /** Trip base currency (Q1 mints requests in it — R-money-13 convention). */
  currency: string;
  /** The debtor being billed (R-money-16). */
  debtorId: string;
  debtorName: string;
  /** The caller (requester) display name — share-message copy. */
  requesterName: string;
  /** Prefill: the displayed pairwise balance (§2.7 step 2). */
  defaultAmountCents: number;
  onDismiss(): void;
}

export function SendBillSheet({
  visible,
  tripId,
  tripName,
  currency,
  debtorId,
  debtorName,
  requesterName,
  defaultAmountCents,
  onDismiss,
}: SendBillSheetProps) {
  const s = useStyles();
  // Compose state snapshots at MOUNT (each open drafts ONE request):
  // owners mount this sheet per presentation (the ManualAddBookingSheet
  // remount idiom), so a re-open starts clean without a setState-in-effect.
  const [amountText, setAmountText] = useState(() =>
    defaultAmountCents > 0 ? centsToAmountText(defaultAmountCents, currency) : "",
  );
  const [note, setNote] = useState("");
  const [created, setCreated] = useState<SettleRequest | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createRequest = useCreateSettleRequest(tripId, {
    onMutationSuccess: (request) => {
      setCreated(request);
      setError(null);
      // §2.7 step 3: the share sheet opens on create success. Fire-and-
      // forget: a dismissed/failed share leaves the created state with the
      // re-share + copy affordances — the request itself already exists.
      void Share.share({ message: composeShareMessage(requesterName, tripName, request) }).catch(
        () => {
          // Sharing is optional sugar; the copy affordance remains.
        },
      );
    },
    onMutationError: (err) => {
      if (err instanceof ApiRequestError && err.status === 409) {
        // Q1 CONFLICT — the debt evaporated under us (settled elsewhere).
        setError(`Nothing to request — ${debtorName} doesn't owe you right now.`);
      } else {
        setError("Couldn't create the request. Please try again.");
      }
    },
  });

  const parsed = parseMoneyToCents(amountText, currency);
  const amountError = amountText.length > 0 && !parsed.ok ? parsed.error : undefined;
  const sendable = parsed.ok && parsed.cents > 0 && !createRequest.isPending;

  const send = () => {
    if (!parsed.ok || parsed.cents <= 0 || createRequest.isPending) return;
    const trimmed = note.trim();
    createRequest.mutate({
      from_user_id: debtorId,
      amount_cents: parsed.cents,
      ...(trimmed.length > 0 ? { note: trimmed } : {}),
    });
  };

  const copyLink = (request: SettleRequest) => {
    void Clipboard.setStringAsync(
      `${settleRequestDeepLink(request.trip_id, request.id)} (web: ${request.link})`,
    )
      .then(() => {
        setCopied(true);
        triggerHaptic("success");
      })
      .catch(() => {
        // Clipboard failure is non-blocking — re-share remains.
      });
  };

  return (
    <Sheet
      visible={visible}
      onDismiss={onDismiss}
      title="Request payment"
      testID="settle-sheet-request"
    >
      <View style={s.body}>
        {error !== null ? (
          <ErrorBanner message={error} testID="settle-sheet-request-error" />
        ) : null}
        {created === null ? (
          <>
            <AppText role="body" color="secondary">
              Request from {debtorName}
            </AppText>
            <Input
              label={`Amount (${currency})`}
              value={amountText}
              onChangeText={setAmountText}
              keyboardType="decimal-pad"
              autoCorrect={false}
              {...(amountError === undefined ? {} : { error: amountError })}
              testID="settle-sheet-request-input-amount"
            />
            <Input
              label="Note (optional)"
              value={note}
              onChangeText={setNote}
              testID="settle-sheet-request-input-note"
            />
            <Button
              title="Create request & share"
              fullWidth
              loading={createRequest.isPending}
              disabled={!sendable}
              onPress={send}
              testID="settle-sheet-request-send"
            />
          </>
        ) : (
          <>
            <AppText role="body" testID="settle-sheet-request-created">
              Requested {moneyLabel(created.amount_cents, created.currency)} from {debtorName}.
            </AppText>
            <Button
              title="Share again"
              variant="secondary"
              icon="share-outline"
              fullWidth
              onPress={() => {
                void Share.share({
                  message: composeShareMessage(requesterName, tripName, created),
                }).catch(() => {
                  // Optional sugar — copy remains.
                });
              }}
              testID="settle-sheet-request-share"
            />
            <Button
              title={copied ? "Copied" : "Copy link"}
              variant="ghost"
              icon={copied ? "checkmark-circle-outline" : "copy-outline"}
              fullWidth
              onPress={() => copyLink(created)}
              testID="settle-sheet-request-copy"
            />
          </>
        )}
      </View>
    </Sheet>
  );
}
