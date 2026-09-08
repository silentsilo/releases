/**
 * releases.silentsilo.com
 *
 * The update endpoint the desktop app polls:
 *
 *   GET /{target}/{arch}/{installed_version}
 *
 * Answers 204 when the caller is current (or when nothing is published for
 * its platform) and a Tauri updater JSON when a newer version exists. The
 * manifest is the latest.json produced by the release workflow, stored in
 * KV under the key "latest".
 *
 * Security does not live here. The app verifies every update against the
 * minisign public key embedded in its binary, so this endpoint serving the
 * wrong bytes can break updates but can never inject code.
 *
 * Each check writes one analytics datapoint: platform, installed version,
 * outcome. Deliberately nothing else. No IPs, no identifiers, no cookies.
 * Counting requests, not people, is the whole design.
 */

import { compareVersions, isVersion, normalize } from "./semver";

export interface Env {
  RELEASES: KVNamespace;
  UPDATE_CHECKS?: AnalyticsEngineDataset;
  // Set under [vars] in wrangler.toml. Adding a platform when one ships is
  // a config edit there; the defaults below only cover a deployment where
  // the vars are missing entirely.
  TARGETS?: string;
  ARCHS?: string;
  MANIFEST_CACHE_TTL_SECONDS?: string;
}

type PlatformEntry = { signature: string; url: string };

type Manifest = {
  version: string;
  notes?: string;
  pub_date?: string;
  platforms: Record<string, PlatformEntry>;
};

/**
 * The KV key the manifest lives under. The publish:manifest script in
 * package.json writes the same key; change both or neither.
 */
const MANIFEST_KEY = "latest";

const DEFAULT_TARGETS = "windows,linux,darwin";
const DEFAULT_ARCHS = "x86_64,aarch64,i686,armv7";

/** KV refuses a cacheTtl under 60, which makes 60 the floor here too. */
const MIN_CACHE_TTL_SECONDS = 60;

function listFromVar(value: string | undefined, fallback: string): Set<string> {
  const raw = value?.trim() ? value : fallback;
  return new Set(
    raw
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

function ttlFromVar(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= MIN_CACHE_TTL_SECONDS
    ? parsed
    : MIN_CACHE_TTL_SECONDS;
}

export default {
  async fetch(request, env): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405 });
    }

    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("ok");
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 3) {
      return new Response("not found", { status: 404 });
    }
    const [target, arch, installed] = parts as [string, string, string];
    const targets = listFromVar(env.TARGETS, DEFAULT_TARGETS);
    const archs = listFromVar(env.ARCHS, DEFAULT_ARCHS);
    if (!targets.has(target) || !archs.has(arch) || !isVersion(installed)) {
      return new Response("not found", { status: 404 });
    }

    const manifest = await env.RELEASES.get<Manifest>(MANIFEST_KEY, {
      type: "json",
      cacheTtl: ttlFromVar(env.MANIFEST_CACHE_TTL_SECONDS),
    });

    const platformKey = `${target}-${arch}`;
    // Every key for this platform, not just the bare one. The updater looks
    // for `{os}-{arch}-{installer}` first and falls back to `{os}-{arch}`,
    // but the request carries no installer, so the endpoint cannot pick: it
    // hands over the whole family and the client takes its own. On Linux
    // that is the difference between a .deb user being offered a .deb and
    // being offered an AppImage it cannot install.
    //
    // The hyphen is what keeps the family tight. A caller on `linux-x86`
    // does not match `linux-x86_64`, because that is not `linux-x86-`.
    const platforms = Object.fromEntries(
      Object.entries(manifest?.platforms ?? {}).filter(
        ([key]) => key === platformKey || key.startsWith(`${platformKey}-`),
      ),
    );
    const offered = Object.keys(platforms).length > 0;

    let outcome: "no-release" | "up-to-date" | "update-offered";
    let response: Response;

    if (!manifest || !offered) {
      outcome = "no-release";
      response = new Response(null, { status: 204 });
    } else if (compareVersions(manifest.version, installed) <= 0) {
      outcome = "up-to-date";
      response = new Response(null, { status: 204 });
    } else {
      outcome = "update-offered";
      // Only the caller's platform: no other platform's entries are its
      // business, and the updater reads nothing outside its own family.
      response = Response.json({
        version: normalize(manifest.version),
        notes: manifest.notes ?? "",
        pub_date: manifest.pub_date ?? "",
        platforms,
      });
    }

    env.UPDATE_CHECKS?.writeDataPoint({
      indexes: [platformKey],
      blobs: [target, arch, normalize(installed), outcome],
      doubles: [1],
    });

    return response;
  },
} satisfies ExportedHandler<Env>;
