/**
 * BalancesSegment — the open-request annotation SEAM (T-9.5 / §2.7 step 5),
 * driven at the COMPONENT boundary because prod passes no `openRequests`
 * yet (no list endpoint on the wire — fixture-tested, empty-in-prod, the
 * P-8 photo-pin precedent; T-9.7 wires a real source). The matcher logic
 * itself is pinned in transfers.test.ts — this suite pins the RENDERED
 * subdued annotation and the empty-by-default arm, plus the "Former member"
 * fallback for balance parties the roster no longer contains.
 */
import { screen } from "@testing-library/react-native";

import { MEMBER_B_ID, TEST_TRIP_ID } from "@/test-utils/ids";
import {
  makeBalancesRead,
  makeSettleRequest,
  moneyApiOverrides,
} from "@/test-utils/money-fixtures";
import { makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { settle } from "@/test-utils/settle";
import { seedAuthenticated, TEST_USER } from "@/test-utils/session-fixtures";
import { makeMember, makeTrip, mockNavApi } from "@/test-utils/trip-fixtures";

import { BalancesSegment } from "./BalancesSegment";

import type { SettleRequest } from "@gogo/shared";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));

async function renderSegment(openRequests?: readonly SettleRequest[]) {
  seedAuthenticated();
  const trip = makeTrip({ id: TEST_TRIP_ID });
  mockNavApi({
    trips: [trip],
    members: [
      makeMember(),
      makeMember({ user: { id: MEMBER_B_ID, display_name: "Blair" }, role: "editor" }),
    ],
    overrides: moneyApiOverrides({ balances: makeBalancesRead() }),
  });
  const view = await renderWithProviders(
    <BalancesSegment trip={trip} {...(openRequests === undefined ? {} : { openRequests })} />,
    { queryClient: makeTestQueryClient() },
  );
  await settle();
  return view;
}

afterEach(async () => {
  await settle();
  jest.restoreAllMocks();
});

it("an open request the caller sent renders the subdued annotation on its row", async () => {
  const request = makeSettleRequest();
  await renderSegment([request]);
  const row = await screen.findByTestId(
    `money-transfer-list-item-${MEMBER_B_ID}-${TEST_USER.id}`,
  );
  expect(row).toBeTruthy();
  // Locale-independent: build the expected date the way the component does.
  const expectedDate = new Date(request.created_at).toLocaleDateString();
  expect(screen.getByText(`Requested USD 25.50 on ${expectedDate}`)).toBeTruthy();
});

it("without the seam (prod today) no annotation renders — the ungated control arm", async () => {
  await renderSegment();
  await screen.findByTestId(`money-transfer-list-item-${MEMBER_B_ID}-${TEST_USER.id}`);
  expect(screen.queryByText(/Requested USD/)).toBeNull();
});

it("balance parties missing from the roster label as 'Former member' (departed payers survive in balances)", async () => {
  // The default universe references MEMBER_C_ID, which this roster lacks.
  await renderSegment();
  expect(await screen.findByText(/Former member/)).toBeTruthy();
});
