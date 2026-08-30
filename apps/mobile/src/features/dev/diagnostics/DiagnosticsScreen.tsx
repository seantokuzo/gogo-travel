/**
 * Device-smoke diagnostics panel (T-S3.5, R-test-2; ADR-006 layer 2).
 *
 * Six legs, each self-running on mount and individually re-runnable, each
 * rendering PASS/FAIL + copyable evidence (long-press the mono block — text
 * is `selectable`; no clipboard dependency). Charter: readable in ONE glance
 * during device QA, starting with "what base URL did we resolve, via which
 * tier?" (B-5).
 *
 * UNAUTHED-REACHABLE by construction: lives in the `(auth)` group (the gate
 * renders unauthed (auth) routes), touches no session state, and every dep
 * works before sign-in — base-URL resolution matters exactly when sign-in is
 * broken. Entry is the deeplink `gogo://diagnostics` (sign-in-footer link is
 * a parked Sean question — no visible entry affordance anywhere).
 *
 * The Google leg is hook-bearing (`useGoogleSignIn` throws at render when
 * unconfigured — T-5.7), so it mounts as a CONDITIONAL COMPONENT behind
 * `isGoogleConfigured()`; unconfigured builds render its fail row without
 * ever calling the hook.
 *
 * ScrollView is intentional: a static, bounded set of six rows, not a data
 * list (the FlatList landmine targets data-driven lists — gallery precedent).
 */
import { createStyles } from "@gogo/tokens/react";
import * as Device from "expo-device";
import * as SecureStore from "expo-secure-store";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import {
  explainApiBaseUrl,
  isGoogleConfigured,
  resolveApiBaseUrl,
  useGoogleSignIn,
} from "@/auth";
import { AppText, Badge, Button, Card, PageHeader } from "@/components";

import { installConsoleTap, readConsoleTap } from "./console-tap";
import {
  evaluateGoogleRequestLeg,
  readExpoPublicEnv,
  runBaseUrlLeg,
  runEnvLeg,
  runHealthLeg,
  runLastErrorLeg,
  runSecureStoreLeg,
  type GoogleRequestView,
  type LegResult,
  type SecureStoreLike,
} from "./legs";
import { useLegRunner, type LegState } from "./use-leg-runner";

/** How long the Google leg waits for the auth request to load. */
const GOOGLE_REQUEST_PATIENCE_MS = 10_000;

/** Injectable seams — the route passes nothing; jest passes fixtures. */
export interface DiagnosticsDeps {
  fetchFn: (input: string, init?: { signal?: AbortSignal }) => ReturnType<typeof fetch>;
  store: SecureStoreLike;
  isDevice: () => boolean;
}

/**
 * Real device wiring. fetch is wrapped (not referenced) so the call binds to
 * the live global at request time — and so a jest spy on globalThis.fetch is
 * honored by the default wiring.
 */
function buildDefaultDeps(): DiagnosticsDeps {
  return {
    fetchFn: (input, init) => fetch(input, init),
    store: SecureStore,
    isDevice: () => Device.isDevice === true,
  };
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.color.bg.screen },
    content: { padding: t.space[4], gap: t.space[3], paddingBottom: t.space[12] },
    rowTop: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: t.space[2],
    },
    rowTitle: { flexDirection: "row", alignItems: "center", gap: t.space[2], flexShrink: 1 },
    body: { gap: t.space[1], marginTop: t.space[2] },
    evidence: {
      backgroundColor: t.color.bg.inset,
      borderRadius: t.radius.sm,
      padding: t.space[2],
    },
  }),
);

function statusBadge(state: LegState) {
  if (state.status === "running") return { label: "RUNNING", tone: "neutral" as const };
  if (state.status === "pass") return { label: "PASS", tone: "success" as const };
  return { label: "FAIL", tone: "danger" as const };
}

/** One leg row: badge + title + rerun, summary line, selectable evidence. */
function LegRow({
  legKey,
  title,
  state,
  onRerun,
}: {
  legKey: string;
  title: string;
  state: LegState;
  onRerun: () => void;
}) {
  const s = useStyles();
  const badge = statusBadge(state);
  return (
    <Card variant="flat" testID={`diagnostics-list-item-${legKey}`}>
      <View style={s.rowTop}>
        <View style={s.rowTitle}>
          <Badge label={badge.label} tone={badge.tone} testID={`diagnostics-status-${legKey}`} />
          <AppText role="subheading">{title}</AppText>
        </View>
        {/* Never disabled: rerunning a HUNG leg is a first-class device
            scenario (a wedged /health probe), and the runner's runId
            machinery discards the stale settle. A disabled-while-running
            button would also be untestable (RNTL won't fire on disabled —
            mobile.md landmine). */}
        <Button
          title="Run again"
          variant="ghost"
          size="sm"
          onPress={onRerun}
          testID={`diagnostics-button-rerun-${legKey}`}
        />
      </View>
      {state.status !== "running" ? (
        <View style={s.body}>
          <AppText role="caption" color="secondary">
            {state.summary}
          </AppText>
          <View style={s.evidence}>
            <AppText
              role="mono"
              color="secondary"
              selectable
              testID={`diagnostics-evidence-${legKey}`}
            >
              {state.evidence}
            </AppText>
          </View>
        </View>
      ) : null}
    </Card>
  );
}

/** A leg row driven by the shared runner. */
function RunnerLegRow({
  legKey,
  title,
  run,
}: {
  legKey: string;
  title: string;
  run: () => Promise<LegResult>;
}) {
  const { state, rerun } = useLegRunner(run);
  return <LegRow legKey={legKey} title={title} state={state} onRerun={rerun} />;
}

/**
 * Inner half of the Google leg — the ONLY place the hook runs, mounted
 * strictly behind `isGoogleConfigured()` (T-5.7 render-gate pattern). The
 * `request` arrives as reactive state, so the row re-evaluates as it loads;
 * "Run again" remounts this component (key bump in the parent), which mints
 * a fresh request + nonce — that IS the rerun semantics for this leg.
 */
function GoogleLegLoaded({ onEvaluate }: { onEvaluate: (r: LegResult | null) => void }) {
  const { request } = useGoogleSignIn();
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), GOOGLE_REQUEST_PATIENCE_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    onEvaluate(
      evaluateGoogleRequestLeg({
        configured: true,
        request: (request as GoogleRequestView | null | undefined) ?? null,
        timedOut,
      }),
    );
  }, [request, timedOut, onEvaluate]);

  return null;
}

function GoogleLegRow() {
  const configured = isGoogleConfigured();
  const [state, setState] = useState<LegState>({ status: "running" });
  const [runKey, setRunKey] = useState(0);

  const onEvaluate = useCallback((result: LegResult | null) => {
    setState(result ?? { status: "running" });
  }, []);

  const rerun = useCallback(() => {
    setState({ status: "running" });
    setRunKey((k) => k + 1);
  }, []);

  const unconfiguredResult = useMemo(
    () => evaluateGoogleRequestLeg({ configured: false, request: null, timedOut: false }),
    [],
  );

  if (!configured) {
    return (
      <LegRow
        legKey="google-request"
        title="Google auth request (B-4)"
        // Unconfigured is a definite outcome, never null.
        state={unconfiguredResult ?? { status: "running" }}
        onRerun={() => undefined}
      />
    );
  }
  return (
    <>
      <GoogleLegLoaded key={runKey} onEvaluate={onEvaluate} />
      <LegRow
        legKey="google-request"
        title="Google auth request (B-4)"
        state={state}
        onRerun={rerun}
      />
    </>
  );
}

export function DiagnosticsScreen({ deps }: { deps?: DiagnosticsDeps }) {
  const s = useStyles();
  const wired = useMemo(() => deps ?? buildDefaultDeps(), [deps]);

  const baseUrlRun = useCallback(
    () => runBaseUrlLeg({ explain: explainApiBaseUrl, isDevice: wired.isDevice }),
    [wired],
  );
  const healthRun = useCallback(
    () =>
      runHealthLeg({
        baseUrl: resolveApiBaseUrl,
        fetchFn: wired.fetchFn,
        now: () => Date.now(),
      }),
    [wired],
  );
  const envRun = useCallback(() => runEnvLeg({ read: readExpoPublicEnv }), []);
  const secureStoreRun = useCallback(() => runSecureStoreLeg({ store: wired.store }), [wired]);
  const lastErrorRun = useCallback(() => {
    // Idempotent belt-and-braces: earliest capture comes from the route
    // module's import-time install; installing here too means a directly
    // mounted panel is never blind on its own screen — and it runs BEFORE
    // the read (child leg effects fire before any parent effect could).
    installConsoleTap();
    return runLastErrorLeg({ readTap: readConsoleTap });
  }, []);

  return (
    <View style={s.screen} testID="diagnostics-screen">
      <PageHeader
        title="Diagnostics"
        subtitle="Device smoke — measured on THIS runtime"
        large
        testID="diagnostics-header"
      />
      <ScrollView style={s.screen} contentContainerStyle={s.content} testID="diagnostics-scroll">
        <RunnerLegRow legKey="base-url" title="API base URL + tier (B-5)" run={baseUrlRun} />
        <RunnerLegRow legKey="health" title="Server /health round-trip" run={healthRun} />
        <RunnerLegRow legKey="env" title="EXPO_PUBLIC_* inlining" run={envRun} />
        <GoogleLegRow />
        <RunnerLegRow legKey="secure-store" title="Secure-store round-trip" run={secureStoreRun} />
        <RunnerLegRow legKey="last-error" title="Last dev error (B-6)" run={lastErrorRun} />
      </ScrollView>
    </View>
  );
}
