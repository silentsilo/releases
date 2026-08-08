import { describe, expect, it } from "vitest";
import { compareVersions, isVersion, normalize } from "./semver";

describe("isVersion", () => {
  it("accepts plain and prerelease versions, with or without a v prefix", () => {
    expect(isVersion("0.1.0")).toBe(true);
    expect(isVersion("v0.1.0")).toBe(true);
    expect(isVersion("1.2.3-rc.1")).toBe(true);
  });

  it("rejects garbage and path tricks", () => {
    expect(isVersion("latest")).toBe(false);
    expect(isVersion("0.1")).toBe(false);
    expect(isVersion("0.1.0/../secret")).toBe(false);
    expect(isVersion("")).toBe(false);
  });

  it("rejects anything long enough to be sent for the sake of it", () => {
    // Whatever passes validation is written to the analytics dataset, so the
    // pattern on its own would let a stranger choose how much gets stored.
    expect(isVersion(`1.0.0-${"a".repeat(200)}`)).toBe(false);
    expect(isVersion(`${"9".repeat(50)}.0.0`)).toBe(false);
    // The longest thing a real build has any reason to report still fits.
    expect(isVersion("10.20.30-rc.11")).toBe(true);
  });
});

describe("normalize", () => {
  it("strips only a leading v", () => {
    expect(normalize("v0.1.0")).toBe("0.1.0");
    expect(normalize("0.1.0")).toBe("0.1.0");
  });
});

describe("compareVersions", () => {
  it("orders by core version", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("1.0.0", "2.0.0")).toBeLessThan(0);
  });

  it("treats a release as newer than its own prereleases", () => {
    expect(compareVersions("0.2.0", "0.2.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0-rc.2", "0.2.0")).toBeLessThan(0);
  });

  it("orders prereleases among themselves", () => {
    expect(compareVersions("0.2.0-rc.2", "0.2.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0-alpha", "0.2.0-beta")).toBeLessThan(0);
    expect(compareVersions("0.2.0-rc.1.1", "0.2.0-rc.1")).toBeGreaterThan(0);
    // Numeric identifiers sort below alphanumeric ones per semver.
    expect(compareVersions("0.2.0-1", "0.2.0-alpha")).toBeLessThan(0);
  });

  it("ignores a v prefix on either side", () => {
    expect(compareVersions("v0.2.0", "0.1.0")).toBeGreaterThan(0);
    expect(compareVersions("0.1.0", "v0.1.0")).toBe(0);
  });

  it("sorts unparseable input as oldest so it is never offered", () => {
    expect(compareVersions("garbage", "0.0.1")).toBeLessThan(0);
    expect(compareVersions("0.0.1", "garbage")).toBeGreaterThan(0);
  });
});
