/**
 * First-run onboarding (navigation.spec §2.2/§ Resolved questions Gate 2;
 * R-nav-2). A linear wizard: display name (REQUIRED) → home currency → travel
 * style (multi-select) → payment handles. Everything after the name is
 * skippable; skipping all still finishes.
 *
 * On finish: PATCH prefs via `updateMe` (prefs is a WHOLE-OBJECT replace — the
 * full UserPrefs, no partial merge) + PATCH handles via `updatePaymentHandles`
 * (only when a handle was entered), then `completeOnboarding()` releases the
 * auth gate → the resume branch lands on the trip list.
 *
 * DEFERRED (not built here): the avatar step (needs object storage, P-12) and
 * the notification-priming step (needs push infra). Both are editable/available
 * later; the spec's ordering is otherwise honored.
 */
import {
  DisplayNameSchema,
  type CurrencyCode,
  type PaymentHandlesUpdate,
  type TravelStyle,
  type UserPrefs,
} from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useCallback, useMemo, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from "react-native";

import { useSessionStore } from "@/auth";
import { AppText, Button, ErrorBanner, Input, PageHeader } from "@/components";
import { usePaymentHandlesUpdate, useUpdateMe } from "@/data";
import {
  COMMON_CURRENCIES,
  SelectChip,
  TRAVEL_STYLE_OPTIONS,
  travelStyleLabel,
} from "@/features/onboarding";

const STEP_COUNT = 4;

const STEP_META = [
  {
    title: "What should we call you?",
    body: "Your display name is how travel companions see you.",
  },
  { title: "Home currency", body: "Budgets and estimates show in this currency. Optional." },
  { title: "Travel style", body: "Pick what fits — it tunes AI suggestions. Optional." },
  { title: "Payment handles", body: "For settling up with companions. Optional, editable later." },
] as const;

const useStyles = createStyles((t) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.color.bg.screen },
    flex: { flex: 1 },
    body: { padding: t.space[4], gap: t.space[4] },
    intro: { gap: t.space[1] },
    fields: { gap: t.space[3] },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: t.space[2] },
    footer: {
      flexDirection: "row",
      alignItems: "center",
      gap: t.space[2],
      padding: t.space[4],
      borderTopWidth: 1,
      borderTopColor: t.color.border.subtle,
    },
    footerSpacer: { flex: 1 },
  }),
);

export default function OnboardingScreen() {
  const s = useStyles();

  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [homeCurrency, setHomeCurrency] = useState<CurrencyCode | null>(null);
  const [styles, setStyles] = useState<TravelStyle[]>([]);
  const [venmo, setVenmo] = useState("");
  const [cashtag, setCashtag] = useState("");
  const [paypalme, setPaypalme] = useState("");
  const [zelle, setZelle] = useState("");
  const [zelleName, setZelleName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const updateMe = useUpdateMe();
  const updateHandles = usePaymentHandlesUpdate();
  const submitting = updateMe.isPending || updateHandles.isPending;

  const nameValid = useMemo(() => DisplayNameSchema.safeParse(name).success, [name]);
  const nameError =
    name.trim().length > 0 && !nameValid ? "1–50 characters, no control characters." : undefined;

  const zelleSet = zelle.trim().length > 0;
  const zelleNameMissing = zelleSet && zelleName.trim().length === 0;

  const next = useCallback(() => setStep((v) => Math.min(STEP_COUNT - 1, v + 1)), []);
  const back = useCallback(() => setStep((v) => Math.max(0, v - 1)), []);

  const toggleCurrency = useCallback(
    (c: CurrencyCode) => setHomeCurrency((prev) => (prev === c ? null : c)),
    [],
  );
  const toggleStyle = useCallback(
    (st: TravelStyle) =>
      setStyles((prev) => (prev.includes(st) ? prev.filter((x) => x !== st) : [...prev, st])),
    [],
  );

  const finish = useCallback(async () => {
    if (zelleNameMissing) return;
    setError(null);

    // Whole-object prefs replace (auth spec §3.4.2): start from the current
    // prefs and overlay onboarding selections — never a partial merge.
    const basePrefs = useSessionStore.getState().user?.prefs ?? {};
    const prefs: UserPrefs = { ...basePrefs };
    if (homeCurrency) prefs.home_currency = homeCurrency;
    if (styles.length > 0) prefs.travel_style = styles;

    const handles: PaymentHandlesUpdate = {};
    if (venmo.trim()) handles.venmo_username = venmo.trim();
    if (cashtag.trim()) handles.cashtag = cashtag.trim();
    if (paypalme.trim()) handles.paypalme_username = paypalme.trim();
    if (zelleSet) {
      handles.zelle_handle = zelle.trim();
      handles.zelle_display_name = zelleName.trim();
    }
    const hasHandles = Object.keys(handles).length > 0;

    try {
      await updateMe.mutateAsync({ display_name: name.trim(), prefs });
      if (hasHandles) await updateHandles.mutateAsync(handles);
      useSessionStore.getState().completeOnboarding();
    } catch {
      setError("Couldn't save your profile. Please try again.");
    }
  }, [
    zelleNameMissing,
    zelleSet,
    homeCurrency,
    styles,
    venmo,
    cashtag,
    paypalme,
    zelle,
    zelleName,
    name,
    updateMe,
    updateHandles,
  ]);

  const meta = STEP_META[step];

  return (
    <View style={s.screen} testID="onboarding-screen">
      <PageHeader
        title="Welcome"
        subtitle={`Step ${step + 1} of ${STEP_COUNT}`}
        testID="onboarding-header"
      />
      <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          {error !== null ? (
            <ErrorBanner
              message={error}
              onDismiss={() => setError(null)}
              testID="onboarding-error"
            />
          ) : null}

          <View style={s.intro}>
            <AppText role="title" accessibilityRole="header">
              {meta.title}
            </AppText>
            <AppText color="secondary">{meta.body}</AppText>
          </View>

          {step === 0 ? (
            <Input
              label="Display name"
              value={name}
              onChangeText={setName}
              placeholder="Your name"
              error={nameError}
              autoComplete="name"
              returnKeyType="done"
              testID="onboarding-input-name"
            />
          ) : null}

          {step === 1 ? (
            <View style={s.chips}>
              {COMMON_CURRENCIES.map((c) => (
                <SelectChip
                  key={c}
                  label={c}
                  selected={homeCurrency === c}
                  onPress={() => toggleCurrency(c)}
                  testID={`onboarding-currency-${c}`}
                />
              ))}
            </View>
          ) : null}

          {step === 2 ? (
            <View style={s.chips}>
              {TRAVEL_STYLE_OPTIONS.map((st) => (
                <SelectChip
                  key={st}
                  label={travelStyleLabel(st)}
                  selected={styles.includes(st)}
                  onPress={() => toggleStyle(st)}
                  testID={`onboarding-style-${st}`}
                />
              ))}
            </View>
          ) : null}

          {step === 3 ? (
            <View style={s.fields}>
              <Input
                label="Venmo"
                value={venmo}
                onChangeText={setVenmo}
                placeholder="@username"
                testID="onboarding-input-venmo"
              />
              <Input
                label="Cash App"
                value={cashtag}
                onChangeText={setCashtag}
                placeholder="$cashtag"
                testID="onboarding-input-cashtag"
              />
              <Input
                label="PayPal.me"
                value={paypalme}
                onChangeText={setPaypalme}
                placeholder="username"
                testID="onboarding-input-paypalme"
              />
              <Input
                label="Zelle (email or phone)"
                value={zelle}
                onChangeText={setZelle}
                placeholder="you@example.com"
                keyboardType="email-address"
                testID="onboarding-input-zelle"
              />
              <Input
                label="Zelle display name"
                value={zelleName}
                onChangeText={setZelleName}
                placeholder="Name on the account"
                error={zelleNameMissing ? "Required when a Zelle handle is set." : undefined}
                testID="onboarding-input-zelle-name"
              />
            </View>
          ) : null}
        </ScrollView>

        <View style={s.footer}>
          {step > 0 ? (
            <Button
              title="Back"
              variant="ghost"
              onPress={back}
              disabled={submitting}
              testID="onboarding-button-back"
            />
          ) : null}
          <View style={s.footerSpacer} />
          {step > 0 && step < STEP_COUNT - 1 ? (
            <Button title="Skip" variant="ghost" onPress={next} testID="onboarding-button-skip" />
          ) : null}
          {step < STEP_COUNT - 1 ? (
            <Button
              title="Continue"
              onPress={next}
              disabled={step === 0 && !nameValid}
              testID="onboarding-button-continue"
            />
          ) : (
            <Button
              title="Finish"
              onPress={() => void finish()}
              loading={submitting}
              disabled={zelleNameMissing}
              testID="onboarding-button-finish"
            />
          )}
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
