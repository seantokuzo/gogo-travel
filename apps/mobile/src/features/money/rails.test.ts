/**
 * Rail link-builder pins (T-9.7 — R-cmoney-15..19, §2.5 live-probed
 * formats VERBATIM; spec §3 checklist "Link builder" rows). Byte-exact URL
 * assertions on fixture handles/amounts: `@`/`$` normalization, note
 * URL-encoding, PayPal currency pinning, JPY zero-decimal formatting, USD
 * rail gating, no-stub absence, and the R-cmoney-28 charge gate.
 */
import {
  buildRails,
  railAmountText,
  VENMO_TXN_CHARGE_ENABLED,
  type RailHandles,
} from "./rails";

const NO_HANDLES: RailHandles = {
  venmo_username: null,
  cashtag: null,
  paypalme_username: null,
  zelle_handle: null,
  zelle_display_name: null,
};

const ALL_HANDLES: RailHandles = {
  venmo_username: "alex-p_1",
  cashtag: "alexp",
  paypalme_username: "alexpay",
  zelle_handle: "alex@example.com",
  zelle_display_name: "Alex P",
};

const USD_CTX = { currency: "USD", amountCents: 2550, tripName: "Tokyo & Back" };

describe("railAmountText (§2.5 shared formatting)", () => {
  it("renders fixed minor-unit digits: USD 2550 → 25.50, JPY 2550 → 2550", () => {
    expect(railAmountText(2550, "USD")).toBe("25.50");
    expect(railAmountText(2550, "JPY")).toBe("2550");
    // Sub-dollar and whole-dollar boundaries keep fixed 2dp (never "5" / ".5").
    expect(railAmountText(5, "USD")).toBe("0.05");
    expect(railAmountText(2500, "USD")).toBe("25.00");
  });
});

describe("buildRails — §2.5 formats verbatim", () => {
  it("Venmo app URL: paycharge, txn=pay, bare recipient, dot-decimal amount, URL-encoded note", () => {
    const rails = buildRails({ ...NO_HANDLES, venmo_username: "alex-p_1" }, USD_CTX);
    expect(rails).toEqual([
      {
        kind: "venmo",
        appUrl:
          "venmo://paycharge?txn=pay&recipients=alex-p_1&amount=25.50&note=GoGo%3A%20Tokyo%20%26%20Back",
        webUrl:
          "https://account.venmo.com/pay?txn=pay&recipients=alex-p_1&amount=25.50&note=GoGo%3A%20Tokyo%20%26%20Back",
      },
    ]);
  });

  it("defensively strips a legacy leading @ from a Venmo username (stored bare since T-5.8)", () => {
    const rails = buildRails({ ...NO_HANDLES, venmo_username: "@alex" }, USD_CTX);
    expect(rails[0]).toMatchObject({ appUrl: expect.stringContaining("recipients=alex&") });
  });

  it("Cash App: cash.app/$<cashtag>/<amount> — $ prefixed at render, no note anywhere", () => {
    const rails = buildRails({ ...NO_HANDLES, cashtag: "alexp" }, USD_CTX);
    expect(rails).toEqual([{ kind: "cashapp", url: "https://cash.app/$alexp/25.50" }]);
    // Legacy stored `$` never doubles.
    const legacy = buildRails({ ...NO_HANDLES, cashtag: "$alexp" }, USD_CTX);
    expect(legacy).toEqual([{ kind: "cashapp", url: "https://cash.app/$alexp/25.50" }]);
  });

  it("PayPal.me pins the currency code (USD) — recipient default must never apply", () => {
    const rails = buildRails({ ...NO_HANDLES, paypalme_username: "alexpay" }, USD_CTX);
    expect(rails).toEqual([{ kind: "paypal", url: "https://paypal.me/alexpay/25.50USD" }]);
  });

  it("Zelle is copy-only: handle + display name, no URL of any kind (R-cmoney-19)", () => {
    const rails = buildRails(
      { ...NO_HANDLES, zelle_handle: "alex@example.com", zelle_display_name: "Alex P" },
      USD_CTX,
    );
    expect(rails).toEqual([
      { kind: "zelle", handle: "alex@example.com", displayName: "Alex P" },
    ]);
  });

  it("orders rails per the §2.8 inventory (venmo · cashapp · paypal · zelle)", () => {
    expect(buildRails(ALL_HANDLES, USD_CTX).map((r) => r.kind)).toEqual([
      "venmo",
      "cashapp",
      "paypal",
      "zelle",
    ]);
  });

  it("absent handles produce NOTHING — no disabled stubs (R-cmoney-15)", () => {
    expect(buildRails(NO_HANDLES, USD_CTX)).toEqual([]);
    // Control arm: the same context with handles produces rails, so the
    // empty result above is the absence of handles, not a broken builder.
    expect(buildRails(ALL_HANDLES, USD_CTX)).toHaveLength(4);
  });

  it("non-USD hides the USD-only rails; PayPal survives with the pinned currency (R-cmoney-18)", () => {
    const rails = buildRails(ALL_HANDLES, { currency: "EUR", amountCents: 2550, tripName: "T" });
    expect(rails).toEqual([{ kind: "paypal", url: "https://paypal.me/alexpay/25.50EUR" }]);
  });

  it("JPY (zero-decimal): whole-unit amount in the PayPal URL, JPY pinned", () => {
    const rails = buildRails(ALL_HANDLES, { currency: "JPY", amountCents: 2550, tripName: "T" });
    expect(rails).toEqual([{ kind: "paypal", url: "https://paypal.me/alexpay/2550JPY" }]);
  });
});

describe("R-cmoney-28 — Venmo charge GATE (device test D1, P-14)", () => {
  it("the gate ships OFF", () => {
    expect(VENMO_TXN_CHARGE_ENABLED).toBe(false);
  });

  it("txn DERIVES from the gate: charge iff enabled, pay otherwise (both states)", () => {
    // R1: the flag is a REAL gate — at P-14 flipping the const flips the
    // built URLs. Both states pinned through the injectable flags seam.
    const on = buildRails({ ...NO_HANDLES, venmo_username: "alex-p_1" }, USD_CTX, {
      venmoTxnCharge: true,
    });
    expect(on).toEqual([
      {
        kind: "venmo",
        appUrl:
          "venmo://paycharge?txn=charge&recipients=alex-p_1&amount=25.50&note=GoGo%3A%20Tokyo%20%26%20Back",
        webUrl:
          "https://account.venmo.com/pay?txn=charge&recipients=alex-p_1&amount=25.50&note=GoGo%3A%20Tokyo%20%26%20Back",
      },
    ]);
    const off = buildRails({ ...NO_HANDLES, venmo_username: "alex-p_1" }, USD_CTX, {
      venmoTxnCharge: false,
    });
    expect(off[0]).toMatchObject({
      appUrl: expect.stringContaining("txn=pay&"),
      webUrl: expect.stringContaining("txn=pay&"),
    });
  });

  it("no DEFAULT-built URL ever carries txn=charge while the shipped gate is off", () => {
    // Control: production callers pass no flags — the default derives from
    // the module const, so today's behavior is byte-identical to txn=pay.
    const rails = buildRails(ALL_HANDLES, USD_CTX);
    const urls = rails.flatMap((rail) =>
      rail.kind === "venmo" ? [rail.appUrl, rail.webUrl] : rail.kind === "zelle" ? [] : [rail.url],
    );
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).not.toContain("txn=charge");
    }
    // The pay arm is present (control: the venmo URLs DO carry a txn param).
    expect(urls[0]).toContain("txn=pay");
  });
});
