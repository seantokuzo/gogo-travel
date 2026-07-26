/**
 * Universal-link config drift guard (T-6.6 / NAV-5; navigation.spec §2.3 +
 * Gate-2 LINK_DOMAIN resolution).
 *
 * app.json cannot import `@gogo/shared`, and the AASA/assetlinks artifacts
 * are static files served by the LINK_DOMAIN host at P-14 — so this suite IS
 * the "single shared config constant" mechanism: every transport surface is
 * pinned to `LINK_DOMAIN` and to the registry's path families, and the P-14
 * domain swap becomes: change the constant, watch every drift fail loudly.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LINK_DOMAIN } from "@gogo/shared";

const MOBILE_ROOT = join(__dirname, "..", "..");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

interface AppJson {
  expo: {
    scheme: string;
    ios: { bundleIdentifier: string; associatedDomains?: string[] };
    android: {
      intentFilters?: {
        autoVerify?: boolean;
        data: { scheme: string; host: string; pathPrefix?: string }[];
      }[];
    };
  };
}

const appJson = readJson(join(MOBILE_ROOT, "app.json")) as AppJson;

describe("app.json ↔ shared LINK_DOMAIN", () => {
  it("declares the gogo:// scheme (nav §2.3 fallback transport)", () => {
    expect(appJson.expo.scheme).toBe("gogo");
  });

  it("iOS associated domains carry exactly the applinks entry for LINK_DOMAIN", () => {
    expect(appJson.expo.ios.associatedDomains).toEqual([`applinks:${LINK_DOMAIN}`]);
  });

  it("Android intent filters autoVerify LINK_DOMAIN over https for BOTH registry families", () => {
    const filters = appJson.expo.android.intentFilters ?? [];
    expect(filters).toHaveLength(1);
    expect(filters[0].autoVerify).toBe(true);
    expect(filters[0].data).toEqual([
      { scheme: "https", host: LINK_DOMAIN, pathPrefix: "/invite/" },
      { scheme: "https", host: LINK_DOMAIN, pathPrefix: "/t/" },
    ]);
  });
});

describe("AASA artifact (linking/well-known/apple-app-site-association)", () => {
  interface Aasa {
    applinks: { details: { appIDs: string[]; components: { "/": string }[] }[] };
  }
  const aasa = readJson(
    join(MOBILE_ROOT, "linking", "well-known", "apple-app-site-association"),
  ) as Aasa;

  it("appIDs reference the app.json bundle identifier (team id is the P-14 placeholder)", () => {
    expect(aasa.applinks.details).toHaveLength(1);
    expect(aasa.applinks.details[0].appIDs).toEqual([
      `TEAMID_PLACEHOLDER.${appJson.expo.ios.bundleIdentifier}`,
    ]);
  });

  it("claims exactly the §2.3 registry path families — nothing more, nothing less", () => {
    const patterns = aasa.applinks.details[0].components.map((component) => component["/"]);
    expect(patterns).toEqual(["/invite/*", "/t/*"]);
  });
});

describe("assetlinks artifact (linking/well-known/assetlinks.json)", () => {
  interface AssetLink {
    relation: string[];
    target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] };
  }
  const assetlinks = readJson(
    join(MOBILE_ROOT, "linking", "well-known", "assetlinks.json"),
  ) as AssetLink[];

  it("delegates handle_all_urls to the android app target (P-14 placeholders intact)", () => {
    expect(assetlinks).toHaveLength(1);
    expect(assetlinks[0].relation).toEqual(["delegate_permission/common.handle_all_urls"]);
    expect(assetlinks[0].target.namespace).toBe("android_app");
    // Placeholders stay placeholders until Sean's P-14 signing config exists —
    // a premature "real-looking" value here would ship an unverifiable link.
    expect(assetlinks[0].target.package_name).toBe("PACKAGE_NAME_PLACEHOLDER");
    expect(assetlinks[0].target.sha256_cert_fingerprints).toEqual([
      "SHA256_CERT_FINGERPRINT_PLACEHOLDER",
    ]);
  });
});
