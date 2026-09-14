import { HostResourcesSnapshot } from "./resourceTelemetry.ts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

const decode = Schema.decodeUnknownSync(HostResourcesSnapshot);

describe("HostResourcesSnapshot", () => {
  it("keeps storage optional for older connected environments", () => {
    expect(
      decode({
        sampledAt: 1,
        cpuUtilization: 0.5,
        cpuCount: 8,
        availableMemoryBytes: 4_000,
        totalMemoryBytes: 8_000,
      }).storage,
    ).toBeUndefined();
  });

  it("decodes privacy-safe workspace capacity", () => {
    expect(
      decode({
        sampledAt: 1,
        cpuUtilization: 0.5,
        cpuCount: 8,
        availableMemoryBytes: 4_000,
        totalMemoryBytes: 8_000,
        storage: {
          status: "available",
          volumes: [{ kind: "workspace", availableBytes: 25_000, totalBytes: 100_000 }],
        },
      }).storage,
    ).toEqual({
      status: "available",
      volumes: [{ kind: "workspace", availableBytes: 25_000, totalBytes: 100_000 }],
    });
  });
});
