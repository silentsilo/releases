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
