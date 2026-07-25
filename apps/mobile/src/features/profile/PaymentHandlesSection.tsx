/**
 * PaymentHandlesSection (T-5.8) — the settle-up spine editor via
 * `updatePaymentHandles`. Wire semantics (auth spec §3.4.2): absent = untouched,
 * `null` = clear. So a field left empty that HAD a value clears it; a field left
 * empty that was already empty is omitted. Normalization ('@'/'$' stripping,
 * charset) is server-side — the client sends raw-ish values.
 *
 * zellePairRule (enforced in-form): a Zelle handle requires a display name in
 * the same payload, so Save is blocked until the display name is filled.
 */
import { type PaymentHandlesUpdate, type User } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { Button, ErrorBanner, Input } from "@/components";
import { usePaymentHandlesUpdate } from "@/data";

import { Section } from "./Section";

/** Empty now → clear if it had a value (null), else untouched (undefined). */
function diffField(current: string, original: string | null): string | null | undefined {
  const trimmed = current.trim();
  if (trimmed.length > 0) return trimmed;
  return original !== null ? null : undefined;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    form: { gap: t.space[3] },
  }),
);

export function PaymentHandlesSection({ user }: { user: User }) {
  const s = useStyles();
  const [venmo, setVenmo] = useState(user.venmo_username ?? "");
  const [cashtag, setCashtag] = useState(user.cashtag ?? "");
  const [paypalme, setPaypalme] = useState(user.paypalme_username ?? "");
  const [zelle, setZelle] = useState(user.zelle_handle ?? "");
  const [zelleName, setZelleName] = useState(user.zelle_display_name ?? "");
  const updateHandles = usePaymentHandlesUpdate();

  const zelleSet = zelle.trim().length > 0;
  const zelleNameMissing = zelleSet && zelleName.trim().length === 0;

  const onSave = () => {
    if (zelleNameMissing) return;
    const payload: PaymentHandlesUpdate = {};

    const v = diffField(venmo, user.venmo_username);
    if (v !== undefined) payload.venmo_username = v;
    const c = diffField(cashtag, user.cashtag);
    if (c !== undefined) payload.cashtag = c;
    const p = diffField(paypalme, user.paypalme_username);
    if (p !== undefined) payload.paypalme_username = p;

    if (zelleSet) {
      payload.zelle_handle = zelle.trim();
      payload.zelle_display_name = zelleName.trim();
    } else if (user.zelle_handle !== null) {
      payload.zelle_handle = null;
      payload.zelle_display_name = null;
    }

    updateHandles.mutate(payload);
  };

  return (
    <Section title="Payment handles" testID="profile-section-handles">
      <View style={s.form}>
        {updateHandles.isError ? (
          <ErrorBanner
            message="Couldn't save your handles. Please try again."
            onDismiss={() => updateHandles.reset()}
            testID="profile-handles-error"
          />
        ) : null}
        <Input
          label="Venmo"
          value={venmo}
          onChangeText={setVenmo}
          placeholder="@username"
          testID="profile-input-venmo"
        />
        <Input
          label="Cash App"
          value={cashtag}
          onChangeText={setCashtag}
          placeholder="$cashtag"
          testID="profile-input-cashtag"
        />
        <Input
          label="PayPal.me"
          value={paypalme}
          onChangeText={setPaypalme}
          placeholder="username"
          testID="profile-input-paypalme"
        />
        <Input
          label="Zelle (email or phone)"
          value={zelle}
          onChangeText={setZelle}
          placeholder="you@example.com"
          keyboardType="email-address"
          testID="profile-input-zelle"
        />
        <Input
          label="Zelle display name"
          value={zelleName}
          onChangeText={setZelleName}
          error={zelleNameMissing ? "Required when a Zelle handle is set." : undefined}
          testID="profile-input-zelle-name"
        />
        <Button
          title="Save handles"
          onPress={onSave}
          loading={updateHandles.isPending}
          disabled={zelleNameMissing}
          testID="profile-button-save-handles"
        />
      </View>
    </Section>
  );
}
