/**
 * Component Gallery (DS-10) — the Law #7 visual-evidence surface: every §2.9
 * component × its states, under every palette × scheme.
 *
 * GATING: dev-only via a `__DEV__` redirect. File-based routing can't
 * conditionally register routes, so the route always exists but production
 * builds bounce straight back to the trip list before any gallery UI mounts
 * (and the dev-only entry on the trip-list screen is itself `__DEV__`-gated).
 * Chosen over a route group because it keeps the gate in ONE grep-able place.
 *
 * This screen intentionally uses a ScrollView: it is a STATIC, bounded set
 * of demo sections, not a data list (the FlatList landmine targets
 * data-driven lists).
 */
import { THEME_NAMES, themes } from "@gogo/tokens";
import { createStyles, useTheme } from "@gogo/tokens/react";
import { Redirect, Stack } from "expo-router";
import type { ReactNode } from "react";
import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import {
  AppText,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  Icon,
  Input,
  ListItem,
  PageHeader,
  SegmentedControl,
  Sheet,
  Skeleton,
  TabNav,
} from "@/components";

const TYPE_ROLES = [
  "display",
  "title",
  "heading",
  "subheading",
  "body",
  "bodyStrong",
  "caption",
  "label",
  "mono",
] as const;

const useStyles = createStyles((t) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.color.bg.screen },
    content: { padding: t.space[4], gap: t.space[6], paddingBottom: t.space[12] },
    section: { gap: t.space[3] },
    row: { flexDirection: "row", flexWrap: "wrap", gap: t.space[2], alignItems: "center" },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: t.color.border.default },
  }),
);

function Section({ title, children }: { title: string; children: ReactNode }) {
  const s = useStyles();
  return (
    <View style={s.section}>
      <AppText role="heading">{title}</AppText>
      {children}
    </View>
  );
}

function GalleryContent() {
  const { theme, scheme, appearancePref, setAppearancePref, accentName, setAccentName } =
    useTheme();
  const s = useStyles();

  const [plainDialogOpen, setPlainDialogOpen] = useState(false);
  const [destructiveDialogOpen, setDestructiveDialogOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [bannerVisible, setBannerVisible] = useState(true);
  const [tripName, setTripName] = useState("");
  const [notes, setNotes] = useState("");
  const [secret, setSecret] = useState("");
  const [segment, setSegment] = useState("budget");
  const [tab, setTab] = useState("today");

  const noop = () => undefined;

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <PageHeader
        title="Gallery"
        subtitle={`${theme.name} — Law #7 evidence surface`}
        large
        leading="back"
        trailing={[
          {
            icon: scheme === "dark" ? "sunny" : "moon",
            label: "Toggle scheme",
            onPress: () => setAppearancePref(scheme === "dark" ? "light" : "dark"),
            testID: "gallery-scheme-quick-toggle",
          },
        ]}
        testID="gallery-header"
      />
      <ScrollView style={s.screen} contentContainerStyle={s.content} testID="gallery-scroll">
        <Section title="Theme controls">
          <AppText role="caption" color="secondary">
            Appearance ({appearancePref})
          </AppText>
          <SegmentedControl
            segments={[
              { key: "system", label: "System" },
              { key: "light", label: "Light" },
              { key: "dark", label: "Dark" },
            ]}
            selectedKey={appearancePref}
            onChange={(key) => setAppearancePref(key as typeof appearancePref)}
            testID="gallery-scheme"
          />
          <AppText role="caption" color="secondary">
            Accent palette ({accentName})
          </AppText>
          <SegmentedControl
            segments={THEME_NAMES.map((name) => ({ key: name, label: themes[name].label }))}
            selectedKey={accentName}
            onChange={setAccentName}
            testID="gallery-palette"
          />
        </Section>

        <Section title="Text — every role">
          {TYPE_ROLES.map((role) => (
            <AppText key={role} role={role}>
              {role} — GoGo Travel
            </AppText>
          ))}
          <View style={s.row}>
            <AppText color="primary">primary</AppText>
            <AppText color="secondary">secondary</AppText>
            <AppText color="muted">muted</AppText>
            <AppText color="accent">accent</AppText>
          </View>
        </Section>

        <Section title="Button — variants">
          <View style={s.row}>
            <Button title="Primary" onPress={noop} testID="g-btn-primary" />
            <Button title="Secondary" onPress={noop} variant="secondary" testID="g-btn-secondary" />
          </View>
          <View style={s.row}>
            <Button title="Ghost" onPress={noop} variant="ghost" testID="g-btn-ghost" />
            <Button
              title="Delete trip"
              onPress={noop}
              variant="destructive"
              testID="g-btn-destructive"
            />
          </View>
        </Section>

        <Section title="Button — states & sizes">
          <View style={s.row}>
            <Button title="Loading" onPress={noop} loading testID="g-btn-loading" />
            <Button title="Disabled" onPress={noop} disabled testID="g-btn-disabled" />
          </View>
          <View style={s.row}>
            <Button title="Small" onPress={noop} size="sm" testID="g-btn-sm" />
            <Button title="Medium" onPress={noop} size="md" testID="g-btn-md" />
            <Button title="Large" onPress={noop} size="lg" testID="g-btn-lg" />
          </View>
          <View style={s.row}>
            <Button title="Add stop" onPress={noop} icon="add" testID="g-btn-icon" />
            <Button
              title="Share"
              onPress={noop}
              variant="secondary"
              icon="share-outline"
              iconPosition="trailing"
              testID="g-btn-icon-trailing"
            />
          </View>
          <Button title="Full width" onPress={noop} fullWidth testID="g-btn-full" />
        </Section>

        <Section title="Card">
          <Card>
            <AppText role="subheading">Raised card</AppText>
            <AppText role="caption" color="secondary">
              elevation 1, bg.surface
            </AppText>
          </Card>
          <Card variant="flat">
            <AppText role="subheading">Flat card</AppText>
            <AppText role="caption" color="secondary">
              border.subtle, no shadow
            </AppText>
          </Card>
          <Card variant="inset">
            <AppText role="subheading">Inset card</AppText>
            <AppText role="caption" color="secondary">
              bg.inset well
            </AppText>
          </Card>
          <Card onPress={noop} testID="g-card-pressable" accessibilityLabel="Pressable card">
            <AppText role="subheading">Pressable card</AppText>
            <AppText role="caption" color="secondary">
              press me — overlay feedback
            </AppText>
          </Card>
        </Section>

        <Section title="Input">
          <Input
            label="Trip name"
            value={tripName}
            onChangeText={setTripName}
            placeholder="Summer in Lisbon"
            helper="Shown on the trip card"
            testID="g-input-default"
          />
          <Input
            label="Trip name"
            value=""
            onChangeText={noop}
            placeholder="Summer in Lisbon"
            error="Trip name is required"
            testID="g-input-error"
          />
          <Input
            label="Password"
            value={secret}
            onChangeText={setSecret}
            secureTextEntry
            testID="g-input-secure"
          />
          <Input
            label="Notes"
            value={notes}
            onChangeText={setNotes}
            placeholder="Anything worth remembering…"
            multiline
            testID="g-input-multiline"
          />
          <Input
            label="Search"
            value=""
            onChangeText={noop}
            placeholder="Places, bookings…"
            leading={<Icon name="search" size={18} color={theme.color.text.muted} />}
            trailing={<Icon name="close-circle" size={18} color={theme.color.text.muted} />}
            testID="g-input-slots"
          />
        </Section>

        <Section title="Badge">
          <View style={s.row}>
            <Badge label="Idea" tone="neutral" />
            <Badge label="Up next" tone="accent" />
            <Badge label="Booked" tone="success" />
            <Badge label="Pending" tone="warning" />
            <Badge label="Canceled" tone="danger" />
            <Badge label="Offline" tone="info" />
          </View>
          <View style={s.row}>
            <Badge label="sm neutral" tone="neutral" size="sm" />
            <Badge label="sm accent" tone="accent" size="sm" />
          </View>
        </Section>

        <Section title="EmptyState">
          <Card variant="flat" padded={false}>
            <EmptyState
              icon="airplane"
              title="No trips yet"
              body="Plan your first trip and it will show up here."
              action={{ label: "Create a trip", onPress: noop, testID: "g-empty-action" }}
              testID="g-empty"
            />
          </Card>
        </Section>

        <Section title="ErrorBanner">
          {bannerVisible ? (
            <ErrorBanner
              message="Couldn't sync your itinerary."
              onRetry={noop}
              onDismiss={() => setBannerVisible(false)}
              testID="g-banner-danger"
            />
          ) : (
            <Button
              title="Show banner again"
              onPress={() => setBannerVisible(true)}
              variant="ghost"
              testID="g-banner-restore"
            />
          )}
          <ErrorBanner
            message="You're offline — showing cached data."
            tone="warning"
            onRetry={noop}
            testID="g-banner-warning"
          />
        </Section>

        <Section title="Skeleton">
          <View style={s.row}>
            <Skeleton variant="circle" testID="g-skeleton-circle" />
            <Skeleton variant="rect" width={120} height={64} testID="g-skeleton-rect" />
          </View>
          <Skeleton variant="text" lines={3} testID="g-skeleton-text" />
          <AppText role="caption" color="muted">
            Shimmer pulses on motion.duration.shimmer; OS reduce-motion renders it static (R-ds-11).
          </AppText>
        </Section>

        <Section title="ListItem">
          <Card padded={false}>
            <ListItem
              title="Passport & documents"
              subtitle="3 files"
              leading={<Icon name="document-text-outline" size={22} />}
              trailing="chevron"
              onPress={noop}
              testID="g-list-item-pressable"
            />
            <View style={s.divider} />
            <ListItem
              title="Trip members"
              subtitle="You, Maya, Ken"
              leading={<Icon name="people-outline" size={22} />}
              trailing={<Badge label="Owner" tone="accent" size="sm" />}
            />
          </Card>
        </Section>

        <Section title="SegmentedControl">
          <SegmentedControl
            segments={[
              { key: "budget", label: "Budget" },
              { key: "expenses", label: "Expenses" },
              { key: "balances", label: "Balances" },
            ]}
            selectedKey={segment}
            onChange={setSegment}
            testID="g-segmented"
          />
          <AppText role="caption" color="secondary">
            Selected: {segment}
          </AppText>
        </Section>

        <Section title="ConfirmDialog">
          <View style={s.row}>
            <Button
              title="Confirm (plain)"
              onPress={() => setPlainDialogOpen(true)}
              variant="secondary"
              testID="g-open-dialog"
            />
            <Button
              title="Delete photo…"
              onPress={() => setDestructiveDialogOpen(true)}
              variant="destructive"
              testID="g-open-destructive-dialog"
            />
          </View>
        </Section>

        <Section title="Sheet">
          <Button
            title="Open sheet"
            onPress={() => setSheetOpen(true)}
            variant="secondary"
            testID="g-open-sheet"
          />
        </Section>

        <Section title="PageHeader — inline (small)">
          <Card variant="flat" padded={false}>
            <PageHeader
              title="Section header"
              subtitle="Small variant, custom leading"
              leading={<Icon name="map-outline" size={22} />}
              trailing={[
                { icon: "add", label: "Add", onPress: noop, testID: "g-header-add" },
                { icon: "search", label: "Search", onPress: noop, testID: "g-header-search" },
              ]}
              testID="g-inline-header"
            />
          </Card>
          <AppText role="caption" color="muted">
            Inline demo includes the safe-area top pad the real header applies.
          </AppText>
        </Section>

        <Section title="TabNav — inline">
          <Card variant="flat" padded={false}>
            <TabNav
              items={[
                { key: "today", label: "Today", icon: "sunny-outline" },
                { key: "itinerary", label: "Itinerary", icon: "calendar-outline", badge: 3 },
                { key: "map", label: "Map", icon: "map-outline" },
                { key: "budget", label: "Budget", icon: "wallet-outline", badge: "dot" },
                { key: "photos", label: "Photos", icon: "images-outline" },
              ]}
              activeKey={tab}
              onSelect={setTab}
              testID="g-tab-nav"
            />
          </Card>
        </Section>
      </ScrollView>

      <ConfirmDialog
        visible={plainDialogOpen}
        title="Mark day as done?"
        body="You can undo this from the itinerary."
        confirmLabel="Mark done"
        onConfirm={() => setPlainDialogOpen(false)}
        onCancel={() => setPlainDialogOpen(false)}
        testID="g-dialog"
      />
      <ConfirmDialog
        visible={destructiveDialogOpen}
        title="Delete photo?"
        body="This removes the photo from the trip album for everyone."
        confirmLabel="Delete"
        destructive
        onConfirm={() => setDestructiveDialogOpen(false)}
        onCancel={() => setDestructiveDialogOpen(false)}
        testID="g-destructive-dialog"
      />
      <Sheet
        visible={sheetOpen}
        onDismiss={() => setSheetOpen(false)}
        title="Place details"
        testID="g-sheet"
      >
        <AppText color="secondary">
          Bottom sheet: grab handle, swipe-down from the header, explicit close, scrim dismissal
          (R-ds-19).
        </AppText>
      </Sheet>
    </View>
  );
}

export default function GalleryScreen() {
  // Production builds never mount gallery UI — see file header for gating.
  if (!__DEV__) {
    return <Redirect href="/" />;
  }
  return <GalleryContent />;
}
