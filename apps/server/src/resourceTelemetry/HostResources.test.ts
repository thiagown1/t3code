import { describe, expect, it } from "vite-plus/test";

import { workspaceStorageSnapshot } from "./HostResources.ts";

describe("workspaceStorageSnapshot", () => {
  it("projects filesystem blocks into privacy-safe capacity", () => {
    expect(
      workspaceStorageSnapshot({
        bavail: 25,
        blocks: 100,
        bsize: 4_096,
      }),
    ).toEqual({
      status: "available",
      volumes: [
        {
          kind: "workspace",
          availableBytes: 102_400,
          totalBytes: 409_600,
        },
      ],
    });
  });

  it("fails closed when filesystem capacity is invalid", () => {
    expect(workspaceStorageSnapshot({ bavail: -1, blocks: 100, bsize: 4_096 })).toEqual({
      status: "error",
      volumes: [],
    });
    expect(
      workspaceStorageSnapshot({ bavail: Number.MAX_VALUE, blocks: 100, bsize: 4_096 }),
    ).toEqual({ status: "error", volumes: [] });
  });
});
