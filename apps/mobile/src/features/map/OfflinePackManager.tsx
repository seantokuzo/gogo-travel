/**
 * Offline map management UI (T-8.5 / MAP-5 — R-map-19/20/21, map spec §2.5):
 * the body of trip settings → Offline map. Shows pack state (`none /
 * downloading(progress) / ready(size, date) / stale / failed`) with the
 * §2.8 management actions:
 *
 *  - download (`offline-pack-button-download`) — wifi starts immediately;
 *    CELLULAR fronts a size-estimate ConfirmDialog (R-map-19); no
 *    connection degrades to an offline notice (R-map-22: entry points
 *    degrade, no spinners that never resolve),
 *  - refresh (`offline-pack-button-refresh`) — packs never auto-update
 *    (§2.5 trigger 3); re-downloads under the same id, same network flow
 *    as download (a refresh costs the same data),
 *  - retry (`offline-pack-button-retry`) — the R-map-21 failed arm,
 *  - delete (`offline-pack-button-delete`) — destructive ConfirmDialog.
 *
 * Dialogs derive `-confirm`/`-cancel` from the TRIGGERING button's id
 * (§2.7 rule 4 — ConfirmDialog children do this automatically).
 *
 * R-map-20 offer: a `past` trip with a saved pack renders a non-blocking
 * free-up-space line above the actions — the "prompt on active → past",
 * living on the management surface (there is no background transition
 * observer to hang a modal off; documented interpretation, PR record).
 *
 * The size ESTIMATE is a tile-count approximation labeled "~" — the
 * installed SDK has no estimate API (machine module doc). Every action
 * handler is gated in the HANDLER, never only `disabled` (mobile.md).
 *
 * Mounting this surface mounts the pack controller — the second R-map-18
 * activation-trigger mount point (controller doc).
 */
import { createStyles, useTheme } from "@gogo/tokens/react";
import * as Network from "expo-network";
import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";

import { AppText, Button, ConfirmDialog } from "@/components";
import { useTripOffline } from "@/data";
import { useTripContext } from "@/navigation/trip-context";

import { mapStyleUrlForScheme } from "./map-style";
import {
  estimatePackSizeBytes,
  formatPackSize,
  isWifiState,
  packBoundsFor,
  type OfflinePackState,
} from "./offline-packs";
import {
  deleteTripPack,
  startPackDownload,
  useOfflinePackController,
  type PackDownloadTarget,
} from "./offline-pack-controller";

const OFFLINE_NOTICE = "You're offline — map downloads need a connection.";

/** State line for the sheet AND the settings row subtitle (one wording home). */
export function offlinePackSummary(state: OfflinePackState): string {
  switch (state.phase) {
    case "none":
      return "Not downloaded";
    case "downloading":
      return `Saving… ${state.progress}%`;
    case "ready":
      return `Ready — ${formatPackSize(state.sizeBytes)} · saved ${shortDate(state.completedAt)}`;
    case "stale":
      return `Update available — saved ${shortDate(state.completedAt)}`;
    case "failed":
      return "Download failed";
  }
}

function shortDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    body: { gap: t.space[3], paddingBottom: t.space[4] },
    actions: { gap: t.space[2] },
  }),
);

/** Which cellular ConfirmDialog is open — keyed by its triggering button id. */
type CellularDialog =
  | "offline-pack-button-download"
  | "offline-pack-button-refresh"
  | "offline-pack-button-retry"
  | null;

export function OfflinePackManager() {
  const s = useStyles();
  const { scheme } = useTheme();
  const trip = useTripContext();
  const state = useOfflinePackController(trip);
  const offline = useTripOffline(trip.id);

  const [cellularDialog, setCellularDialog] = useState<CellularDialog>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [offlineNotice, setOfflineNotice] = useState(false);

  const target: PackDownloadTarget = {
    tripId: trip.id,
    destinationLat: trip.destination_lat,
    destinationLng: trip.destination_lng,
    styleUrl: mapStyleUrlForScheme(scheme),
  };

  const estimate = useMemo(
    () =>
      formatPackSize(
        estimatePackSizeBytes(packBoundsFor(trip.destination_lat, trip.destination_lng)),
      ),
    [trip.destination_lat, trip.destination_lng],
  );

  /**
   * Download/refresh/retry entry: resolve the network AT PRESS TIME (the
   * derived offline signal can lag a fresh cache — R-map-22's belt), then
   * wifi → start, cellular → size-estimate ConfirmDialog, none → notice.
   */
  const requestDownload = (dialogKey: Exclude<CellularDialog, null>) => {
    if (state.phase === "downloading") return; // handler gate, not `disabled`
    void Network.getNetworkStateAsync().then((network) => {
      if (isWifiState(network)) {
        setOfflineNotice(false);
        startPackDownload(target);
        return;
      }
      if (network.isConnected === true) {
        setOfflineNotice(false);
        setCellularDialog(dialogKey);
        return;
      }
      setOfflineNotice(true);
    });
  };

  const onConfirmCellular = () => {
    setCellularDialog(null);
    startPackDownload(target);
  };

  const onConfirmDelete = () => {
    setDeleteDialogOpen(false);
    void deleteTripPack(trip.id);
  };

  const hasPack = state.phase === "ready" || state.phase === "stale";
  const pastTripOffer = hasPack && trip.status === "past";

  return (
    <View style={s.body}>
      <AppText role="body" testID="offline-pack-status">
        {offlinePackSummary(state)}
      </AppText>
      {state.phase === "failed" ? (
        <AppText role="caption" color="muted">
          {state.message}
        </AppText>
      ) : null}
      {state.phase === "none" ? (
        <AppText role="caption" color="muted">
          Maps for {trip.destination_name} work without a connection once saved. Estimated
          download: ~{estimate}.
        </AppText>
      ) : null}
      {state.phase === "stale" ? (
        <AppText role="caption" color="muted">
          The map style or trip destination changed since this was saved — refresh to update
          it.
        </AppText>
      ) : null}
      {pastTripOffer ? (
        <AppText role="caption" color="muted" testID="offline-pack-past-offer">
          This trip is over — delete the offline map to free up space.
        </AppText>
      ) : null}
      {offline || offlineNotice ? (
        <AppText role="caption" color="muted" testID="offline-pack-offline-notice">
          {OFFLINE_NOTICE}
        </AppText>
      ) : null}

      <View style={s.actions}>
        {state.phase === "none" ? (
          <Button
            title="Download map"
            onPress={() => requestDownload("offline-pack-button-download")}
            testID="offline-pack-button-download"
          />
        ) : null}
        {state.phase === "failed" ? (
          <Button
            title="Retry download"
            onPress={() => requestDownload("offline-pack-button-retry")}
            testID="offline-pack-button-retry"
          />
        ) : null}
        {hasPack ? (
          <>
            <Button
              title="Refresh map"
              variant="secondary"
              onPress={() => requestDownload("offline-pack-button-refresh")}
              testID="offline-pack-button-refresh"
            />
            <Button
              title="Delete offline map"
              variant="destructive"
              onPress={() => setDeleteDialogOpen(true)}
              testID="offline-pack-button-delete"
            />
          </>
        ) : null}
      </View>

      <ConfirmDialog
        visible={cellularDialog !== null}
        title="Download over cellular?"
        body={`You're not on Wi-Fi. Saving this map will download about ${estimate} over your cellular connection.`}
        confirmLabel="Download"
        onConfirm={onConfirmCellular}
        onCancel={() => setCellularDialog(null)}
        testID={cellularDialog ?? "offline-pack-button-download"}
      />
      <ConfirmDialog
        visible={deleteDialogOpen}
        title="Delete offline map?"
        body="The map for this trip will no longer be available offline. You can download it again anytime."
        confirmLabel="Delete"
        destructive
        onConfirm={onConfirmDelete}
        onCancel={() => setDeleteDialogOpen(false)}
        testID="offline-pack-button-delete"
      />
    </View>
  );
}
