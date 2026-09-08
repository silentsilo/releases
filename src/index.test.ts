import { describe, expect, it } from "vitest";
import worker, { type Env } from "./index";

type DataPoint = {
  indexes?: string[];
  blobs?: string[];
  doubles?: number[];
};

type Vars = Partial<
  Pick<Env, "TARGETS" | "ARCHS" | "MANIFEST_CACHE_TTL_SECONDS">
>;

/**
 * A manifest the way the release workflow writes it: one entry per shipped
 * platform, signature and url opaque to the endpoint.
 */
const MANIFEST = {
  version: "1.1.0",
  notes: "notes",
  pub_date: "2026-08-07T10:00:00Z",
  platforms: {
    "windows-x86_64": { signature: "sig", url: "https://example.com/a.zip" },
  },
};

function testEnv(manifest: unknown, vars: Vars = {}) {
  const points: DataPoint[] = [];
  const env = {
    RELEASES: { get: async () => manifest },
    UPDATE_CHECKS: {
      writeDataPoint: (point: DataPoint) => {
        points.push(point);
      },
    },
    ...vars,
  } as unknown as Env;
  return { env, points };
}

function call(env: Env, path: string, method = "GET"): Promise<Response> {
  const request = new Request(`https://releases.silentsilo.com${path}`, {
    method,
  }) as Parameters<typeof worker.fetch>[0];
  return worker.fetch(request, env);
}

describe("methods and routes", () => {
  it("rejects anything but GET and HEAD", async () => {
    const { env } = testEnv(MANIFEST);
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await call(env, "/windows/x86_64/1.0.0", method);
      expect(res.status).toBe(405);
    }
  });

  it("answers HEAD like GET", async () => {
    const { env } = testEnv(null);
    const res = await call(env, "/windows/x86_64/1.0.0", "HEAD");
    expect(res.status).toBe(204);
  });

  it("has a health route", async () => {
    const { env } = testEnv(null);
    const res = await call(env, "/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("404s paths that are not target/arch/version", async () => {
    const { env, points } = testEnv(MANIFEST);
    for (const path of [
      "/",
      "/windows/x86_64",
      "/windows/x86_64/1.0.0/extra",
      "/freebsd/x86_64/1.0.0",
      "/windows/mips/1.0.0",
      "/windows/x86_64/latest",
    ]) {
      const res = await call(env, path);
      expect(res.status).toBe(404);
    }
    // Nothing invalid reaches the analytics dataset.
    expect(points).toHaveLength(0);
  });
});

describe("update decisions", () => {
  it("204s when no manifest is published", async () => {
    const { env, points } = testEnv(null);
    const res = await call(env, "/windows/x86_64/1.0.0");
    expect(res.status).toBe(204);
    expect(points[0]?.blobs?.[3]).toBe("no-release");
  });

  it("204s when the manifest has no entry for the caller's platform", async () => {
    const { env, points } = testEnv(MANIFEST);
    const res = await call(env, "/linux/x86_64/1.0.0");
    expect(res.status).toBe(204);
    expect(points[0]?.blobs?.[3]).toBe("no-release");
  });

  it("204s when the caller is current or ahead", async () => {
    const { env, points } = testEnv(MANIFEST);
    for (const installed of ["1.1.0", "1.2.0"]) {
      const res = await call(env, `/windows/x86_64/${installed}`);
      expect(res.status).toBe(204);
    }
    expect(points.map((p) => p.blobs?.[3])).toEqual([
      "up-to-date",
      "up-to-date",
    ]);
  });

  it("hands a Windows caller exactly what it handed before", async () => {
    // The pin that guards the installed base. Adding the per-installer keys
    // below changed how the platform map is selected, and this is the shape
    // that must not move for the platform every user is on today.
    const { env } = testEnv(MANIFEST);
    const res = await call(env, "/windows/x86_64/1.0.0");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      version: "1.1.0",
      notes: "notes",
      pub_date: "2026-08-07T10:00:00Z",
      platforms: { "windows-x86_64": MANIFEST.platforms["windows-x86_64"] },
    });
  });

  it("hands over every installer for the caller's platform", async () => {
    // The updater asks for `{os}-{arch}-{installer}` before `{os}-{arch}`,
    // and the request says nothing about which installer the caller used.
    // So both have to arrive, or a .deb user gets offered an AppImage.
    const { env } = testEnv({
      ...MANIFEST,
      platforms: {
        ...MANIFEST.platforms,
        "linux-x86_64-deb": { signature: "d", url: "https://example.com/a.deb" },
        "linux-x86_64-appimage": { signature: "a", url: "https://example.com/a.AppImage" },
      },
    });
    const res = await call(env, "/linux/x86_64/1.0.0");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { platforms: Record<string, unknown> };
    expect(Object.keys(body.platforms).sort()).toEqual([
      "linux-x86_64-appimage",
      "linux-x86_64-deb",
    ]);
  });

  it("still answers a platform published under the bare key alone", async () => {
    const { env } = testEnv({
      ...MANIFEST,
      platforms: {
        "linux-x86_64": { signature: "l", url: "https://example.com/a.AppImage" },
      },
    });
    const res = await call(env, "/linux/x86_64/1.0.0");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { platforms: Record<string, unknown> };
    expect(Object.keys(body.platforms)).toEqual(["linux-x86_64"]);
  });

  it("never leaks another platform's entries", async () => {
    const { env } = testEnv({
      ...MANIFEST,
      platforms: {
        ...MANIFEST.platforms,
        "linux-x86_64-deb": { signature: "d", url: "https://example.com/a.deb" },
        "darwin-aarch64": { signature: "m", url: "https://example.com/a.tar.gz" },
      },
    });
    const res = await call(env, "/linux/x86_64/1.0.0");
    const body = (await res.json()) as { platforms: Record<string, unknown> };
    expect(Object.keys(body.platforms)).toEqual(["linux-x86_64-deb"]);
  });

  it("never answers one architecture with another architecture's entry", async () => {
    // The family filter keys on `{os}-{arch}`, so a 32-bit caller must not
    // be handed the 64-bit build. The hyphen is what keeps the match tight:
    // `linux-x86_64` is not an installer variant of `linux-x86`.
    const { env } = testEnv({
      ...MANIFEST,
      platforms: {
        "linux-x86_64": { signature: "l", url: "https://example.com/a.AppImage" },
      },
    });
    expect((await call(env, "/linux/i686/1.0.0")).status).toBe(204);
  });

  it("offers the update, filtered to the caller's platform", async () => {
    const { env } = testEnv(MANIFEST);
    const res = await call(env, "/windows/x86_64/1.0.0");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      version: "1.1.0",
      notes: "notes",
      pub_date: "2026-08-07T10:00:00Z",
      platforms: {
        "windows-x86_64": MANIFEST.platforms["windows-x86_64"],
      },
    });
  });

  it("offers a release to its own prereleases and never the reverse", async () => {
    const { env } = testEnv({ ...MANIFEST, version: "1.1.0" });
    expect((await call(env, "/windows/x86_64/1.1.0-rc.1")).status).toBe(200);

    const rc = testEnv({ ...MANIFEST, version: "1.1.1-rc.1" });
    expect((await call(rc.env, "/windows/x86_64/1.1.0")).status).toBe(200);
    expect((await call(rc.env, "/windows/x86_64/1.1.1")).status).toBe(204);
  });

  it("normalizes a v prefix out of the offered version", async () => {
    const { env } = testEnv({ ...MANIFEST, version: "v1.1.0" });
    const res = await call(env, "/windows/x86_64/1.0.0");
    const body = (await res.json()) as { version: string };
    expect(body.version).toBe("1.1.0");
  });

  it("fills notes and pub_date in when the manifest omits them", async () => {
    const { env } = testEnv({
      version: "1.1.0",
      platforms: MANIFEST.platforms,
    });
    const res = await call(env, "/windows/x86_64/1.0.0");
    const body = (await res.json()) as { notes: string; pub_date: string };
    expect(body.notes).toBe("");
    expect(body.pub_date).toBe("");
  });

  it("never offers a manifest whose version does not parse", async () => {
    const { env } = testEnv({ ...MANIFEST, version: "garbage" });
    const res = await call(env, "/windows/x86_64/0.0.1");
    expect(res.status).toBe(204);
  });
});

describe("platform vocabulary from vars", () => {
  it("narrows to what the vars list", async () => {
    const { env } = testEnv(MANIFEST, { TARGETS: "windows", ARCHS: "x86_64" });
    expect((await call(env, "/windows/x86_64/1.0.0")).status).toBe(200);
    expect((await call(env, "/linux/x86_64/1.0.0")).status).toBe(404);
    expect((await call(env, "/windows/aarch64/1.0.0")).status).toBe(404);
  });

  it("falls back to the defaults when vars are missing or blank", async () => {
    const { env } = testEnv(MANIFEST, { TARGETS: "  ", ARCHS: undefined });
    expect((await call(env, "/darwin/aarch64/1.0.0")).status).toBe(204);
    expect((await call(env, "/windows/x86_64/1.0.0")).status).toBe(200);
  });
});

describe("analytics", () => {
  it("writes exactly platform, version and outcome", async () => {
    const { env, points } = testEnv(MANIFEST);
    await call(env, "/windows/x86_64/v1.0.0");
    expect(points).toEqual([
      {
        indexes: ["windows-x86_64"],
        blobs: ["windows", "x86_64", "1.0.0", "update-offered"],
        doubles: [1],
      },
    ]);
  });

  it("still answers when the analytics binding is absent", async () => {
    const env = {
      RELEASES: { get: async () => MANIFEST },
    } as unknown as Env;
    const res = await call(env, "/windows/x86_64/1.0.0");
    expect(res.status).toBe(200);
  });
});
