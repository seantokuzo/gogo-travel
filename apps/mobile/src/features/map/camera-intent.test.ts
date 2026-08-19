/**
 * Pending camera intent (T-8.3 / MAP-4 — R-map-17 transport; pending-focus
 * twin). Load-bearing: CONSUMED ONCE (a drained intent never replays on a
 * tab revisit) and LAST-SET-WINS (rapid successive locates apply the final
 * position, not a stale queue).
 */
import {
  consumePendingCameraIntent,
  setPendingCameraIntent,
  useMapCameraIntentStore,
} from "./camera-intent";

beforeEach(() => {
  useMapCameraIntentStore.setState({ pending: null });
});

it("empty store consumes to null", () => {
  expect(consumePendingCameraIntent()).toBeNull();
});

it("consumed once: the second consume returns null", () => {
  setPendingCameraIntent({ center: [135.77, 35.01], zoom: 14 });

  expect(consumePendingCameraIntent()).toEqual({ center: [135.77, 35.01], zoom: 14 });
  expect(consumePendingCameraIntent()).toBeNull();
});

it("last-set-wins: a newer intent replaces the pending one", () => {
  setPendingCameraIntent({ center: [135.77, 35.01], zoom: 14 });
  setPendingCameraIntent({ center: [139.7, 35.66], zoom: 12 });

  expect(consumePendingCameraIntent()).toEqual({ center: [139.7, 35.66], zoom: 12 });
  expect(consumePendingCameraIntent()).toBeNull();
});
