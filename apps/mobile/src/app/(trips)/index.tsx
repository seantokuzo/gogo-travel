/**
 * Trip list (T-6.7 / CT-1; trips spec §2.1) — the default landing route
 * (R-nav-5). Sections by effective `trip_status` in `active → planning →
 * past` order with §2.1 labels (R-tripui-1); rows carry name, destination,
 * date range, member count and push `/[tripId]` (R-tripui-2). REAL keyset
 * pagination over the shared `Paginated` contract (`useTripList`).
 *
 * Freshness (R-tripui-3, §2.6 collab rules): regaining navigation focus
 * marks the list queries stale and refetches — the first focus is the mount
 * itself (useQuery already fetches there), so it is skipped. The
 * `AppState → active` half + push invalidation are the collab client
 * layer's (CT-6 / T-6.9), not this screen's.
 *
 * Join entries (§2.1): invite links are the ONLY join path in v1 (no
 * token-typing UI), so the join affordance opens guidance. It lives in the
 * EmptyState and the list footer — the spec's "header overflow" home is
 * deferred: PageHeader caps trailing actions at two and both slots are
 * nav-owned (profile avatar — resolved Gate 2 — and capture inbox,
 * R-nav-24); the DS ships no overflow menu.
 *
 * Link notice (R-nav-17, T-6.6): an unknown/malformed deep link lands here
 * with a dismissible non-blocking banner.
 */
import type { TripListItem } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useRouter, type Href } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { SectionList, StyleSheet, View } from "react-native";

import { AppText, Button, EmptyState, ErrorBanner, PageHeader, Sheet, Skeleton } from "@/components";
import { queryKeys, useTripList } from "@/data";
import { Fab, TripRow, groupTripsIntoSections } from "@/features/trips";
import { useLinkNoticeStore } from "@/navigation/link-notice";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.color.bg.screen },
    state: { padding: t.space[4], gap: t.space[3] },
    banner: { paddingHorizontal: t.space[4], paddingBottom: t.space[2] },
    sectionHeader: {
      paddingHorizontal: t.space[4],
      paddingTop: t.space[4],
      paddingBottom: t.space[2],
      backgroundColor: t.color.bg.screen,
    },
    listContent: { paddingBottom: 96 },
    footer: { padding: t.space[4], gap: t.space[3], alignItems: "center" },
    sheetBody: { gap: t.space[3], paddingBottom: t.space[4] },
    emptyWrap: { flex: 1, justifyContent: "center", gap: t.space[2] },
    joinInEmpty: { alignItems: "center" },
  }),
);

function JoinGuidanceSheet({ visible, onDismiss }: { visible: boolean; onDismiss(): void }) {
  const s = useStyles();
  return (
    <Sheet visible={visible} onDismiss={onDismiss} title="Join a trip" testID="trip-list-sheet-join">
      <View style={s.sheetBody}>
        <AppText>
          Trips are joined with an invite link — ask a member of the trip to send you one.
        </AppText>
        <AppText color="secondary">
          Opening the link on this device shows you the trip and who invited you, and you choose
          whether to accept. There are no invite codes to type.
        </AppText>
      </View>
    </Sheet>
  );
}

export default function TripListScreen() {
  const s = useStyles();
  const router = useRouter();
  const linkNotice = useLinkNoticeStore((state) => state.message);
  const [joinSheetOpen, setJoinSheetOpen] = useState(false);

  const list = useTripList();

  // R-tripui-3 / §2.6: focus ⇒ mark stale + refetch. First focus is the
  // mount's own fetch — skip it so cold entry doesn't double-request. The
  // tree's provided client (not the singleton import) so the wiring is real
  // under any provider.
  const qc = useQueryClient();
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      // exact: ["trips"] is a PREFIX of every ["trips", id] detail key — a
      // non-exact invalidate would refetch-loop the [tripId] guard (T-6.6).
      void qc.invalidateQueries({ queryKey: queryKeys.tripsList, exact: true });
      void qc.invalidateQueries({ queryKey: queryKeys.trips, exact: true });
    }, [qc]),
  );

  const items = useMemo(() => {
    const pages = list.data?.pages ?? [];
    // Dedupe by id across pages: a focus-invalidate refetching page 1 while
    // an append is in flight can transiently overlap rows; ids are the
    // SectionList keys, so duplicates would collide.
    const byId = new Map<string, TripListItem>();
    for (const page of pages) {
      for (const item of page.items) byId.set(item.id, item);
    }
    return [...byId.values()];
  }, [list.data]);
  const sections = useMemo(() => groupTripsIntoSections(items), [items]);

  let content;
  if (list.status === "pending") {
    // Skeleton rows (§2.1 loading state, R-ds-15); non-screen loading region
    // derives `<screen>-loading` (nav §2.7 rule 6).
    content = (
      <View style={s.state} testID="trip-list-loading">
        <Skeleton variant="rect" height={96} />
        <Skeleton variant="rect" height={96} />
        <Skeleton variant="rect" height={96} />
      </View>
    );
  } else if (list.status === "error") {
    // §2.7 pins the retry control's EXACT id as `trip-list-retry` ("retry"
    // is an element noun) — a standalone retry button keeps every node
    // grammar-conforming, where an ErrorBanner-derived retry could not.
    content = (
      <View style={s.state}>
        <ErrorBanner message="Couldn't load your trips." testID="trip-list-error" />
        <Button
          title="Retry"
          variant="secondary"
          onPress={() => void list.refetch()}
          testID="trip-list-retry"
        />
      </View>
    );
  } else if (items.length === 0) {
    // R-tripui-5: zero trips renders an EmptyState with create AND
    // join-by-link guidance — never a blank region (R-ds-16).
    content = (
      <View style={s.emptyWrap}>
        <EmptyState
          icon="airplane-outline"
          title="No trips yet"
          body="Plan your first trip, or join a friend's trip with an invite link."
          action={{
            label: "Create a trip",
            onPress: () => router.push("/(trips)/new"),
            testID: "trip-list-button-create",
          }}
          testID="trip-list-empty"
        />
        <View style={s.joinInEmpty}>
          <Button
            title="Join with an invite link"
            variant="ghost"
            onPress={() => setJoinSheetOpen(true)}
            testID="trip-list-button-join"
          />
        </View>
      </View>
    );
  } else {
    content = (
      <SectionList
        testID="trip-list-list"
        sections={sections}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          // Dynamic trip targets aren't representable in the typed-route
          // union — same documented cast as TripSwitcher/entry redirect.
          <TripRow trip={item} onPress={() => router.push(`/${item.id}` as Href)} />
        )}
        renderSectionHeader={({ section }) => (
          <View style={s.sectionHeader}>
            <AppText role="heading">{section.title}</AppText>
          </View>
        )}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={s.listContent}
        onEndReachedThreshold={0.4}
        onEndReached={() => {
          if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
        }}
        ListFooterComponent={
          <View style={s.footer}>
            {list.isFetchingNextPage ? (
              <Skeleton variant="rect" height={96} width="100%" testID="trip-list-loading-more" />
            ) : null}
            <Button
              title="Join with an invite link"
              variant="ghost"
              onPress={() => setJoinSheetOpen(true)}
              testID="trip-list-button-join"
            />
            {__DEV__ ? (
              // Dev-only DS evidence surface (DS-10). The T-6.6 "Open sample
              // trip" door is retired — the real list rows are the doors now.
              <Button
                title="Component gallery"
                variant="ghost"
                onPress={() => router.push("/gallery")}
                testID="trip-list-button-gallery"
              />
            ) : null}
          </View>
        }
      />
    );
  }

  return (
    <View style={s.screen} testID="trip-list-screen">
      <PageHeader
        title="Trips"
        large
        testID="trip-list-header"
        trailing={[
          {
            icon: "person-circle-outline",
            label: "Profile",
            onPress: () => router.push("/(trips)/profile"),
            testID: "trip-list-button-profile",
          },
          {
            icon: "file-tray-full-outline",
            label: "Capture inbox",
            onPress: () => router.push("/(trips)/capture"),
            testID: "trip-list-button-capture",
          },
        ]}
      />
      {linkNotice !== null ? (
        <View style={s.banner}>
          <ErrorBanner
            tone="warning"
            message={linkNotice}
            onDismiss={() => useLinkNoticeStore.getState().clear()}
            testID="trip-list-link-notice"
          />
        </View>
      ) : null}
      {content}
      <Fab
        icon="add"
        label="Create a trip"
        onPress={() => router.push("/(trips)/new")}
        testID="trip-list-fab-create"
      />
      <JoinGuidanceSheet visible={joinSheetOpen} onDismiss={() => setJoinSheetOpen(false)} />
    </View>
  );
}
