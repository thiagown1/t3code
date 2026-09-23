// @effect-diagnostics nodeBuiltinImport:off - Drives the real updater against a fixture release server.
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

const updater = NodePath.resolve(import.meta.dirname, "t3-update.sh");

interface Fixture {
  readonly dir: string;
  readonly root: string;
  readonly log: string;
  readonly unhealthy: Set<string>;
  releases: Array<{ tag_name: string; draft: boolean; assets: Array<{ name: string }> }>;
  readonly archives: Map<string, Buffer>;
  readonly server: NodeHttp.Server;
  readonly port: number;
}

let fixture: Fixture;

async function install(version: string) {
  const dir = NodePath.join(fixture.root, version);
  await NodeFSP.mkdir(dir, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(dir, "t3"), `#!/bin/sh\necho 't3 v${version}'\n`, {
    mode: 0o755,
  });
}

async function publish(tag: string, arch = "x64", reportedVersion?: string) {
  const version = tag.replace(/^cli-/, "");
  const stem = `t3-${version}-linux-${arch}`;
  const staging = await NodeFSP.mkdtemp(NodePath.join(fixture.dir, "archive-"));
  await NodeFSP.mkdir(NodePath.join(staging, stem));
  await NodeFSP.writeFile(
    NodePath.join(staging, stem, "t3"),
    `#!/bin/sh\necho 't3 v${reportedVersion ?? version}'\n`,
    { mode: 0o755 },
  );
  NodeChildProcess.execFileSync("tar", ["-czf", `${stem}.tar.gz`, stem], { cwd: staging });
  fixture.archives.set(
    `/download/${tag}/${stem}.tar.gz`,
    await NodeFSP.readFile(NodePath.join(staging, `${stem}.tar.gz`)),
  );
  fixture.releases.push({ tag_name: tag, draft: false, assets: [{ name: `${stem}.tar.gz` }] });
}

// Asynchronous: the fixture server shares this event loop.
async function run(env: Record<string, string> = {}) {
  const child = NodeChildProcess.spawn("bash", [updater], {
    env: {
      ...process.env,
      PATH: `${NodePath.join(fixture.dir, "bin")}:${process.env.PATH}`,
      T3_TEST_LOG: fixture.log,
      T3_UPDATE_API_URL: `http://127.0.0.1:${fixture.port}/releases`,
      T3_UPDATE_DOWNLOAD_URL: `http://127.0.0.1:${fixture.port}/download`,
      T3_UPDATE_HEALTH_URL: `http://127.0.0.1:${fixture.port}/health`,
      T3_UPDATE_HEALTH_TIMEOUT: "1",
      T3_UPDATE_ROOT: fixture.root,
      T3_UPDATE_ARCH: "x64",
      T3_UPDATE_CGROUP_ROOT: NodePath.join(fixture.dir, "cgroup"),
      T3_UPDATE_STATE_DIR: NodePath.join(fixture.dir, "state"),
      ...env,
    },
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  return { code, output };
}

const current = async () => NodePath.basename(await NodeFSP.readlink(`${fixture.root}/current`));
const installed = async () =>
  (await NodeFSP.readdir(fixture.root)).filter((name) => name.includes("-vps.")).toSorted();
const restarts = async () =>
  (await NodeFSP.readFile(fixture.log, "utf8").catch(() => ""))
    .split("\n")
    .filter((line) => line.startsWith("--user restart")).length;

describe.skipIf(HostProcessPlatform.defaultValue() !== "linux")("VPS updater", () => {
  beforeEach(async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-update-"));
    const root = NodePath.join(dir, "opt");
    await NodeFSP.mkdir(NodePath.join(dir, "bin"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(dir, "cgroup/t3.service"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(dir, "cgroup/t3.service/cgroup.procs"), "1\n");
    await NodeFSP.writeFile(
      NodePath.join(dir, "bin/systemctl"),
      [
        "#!/bin/sh",
        'echo "$*" >> "$T3_TEST_LOG"',
        'case "$*" in',
        "  *ControlGroup*) echo /t3.service ;;",
        "  *MainPID*) echo 1 ;;",
        "esac",
      ].join("\n"),
      { mode: 0o755 },
    );
    const unhealthy = new Set<string>();
    const archives = new Map<string, Buffer>();
    const server = NodeHttp.createServer(async (request, response) => {
      const url = request.url ?? "";
      if (url === "/releases") {
        response.end(JSON.stringify(fixture.releases.toReversed()));
      } else if (url === "/health") {
        const running = NodePath.basename(await NodeFSP.readlink(`${root}/current`));
        response.writeHead(unhealthy.has(running) ? 500 : 200).end();
      } else if (url.endsWith("/SHA256SUMS")) {
        const prefix = url.slice(0, -"SHA256SUMS".length);
        const lines = [...archives]
          .filter(([path]) => path.startsWith(prefix))
          .map(([path, bytes]) => {
            const checksum = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
            return `${checksum}  ${NodePath.basename(path)}\n`;
          });
        response.end(lines.join(""));
      } else if (archives.has(url)) {
        response.end(archives.get(url));
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
    fixture = {
      dir,
      root,
      log: NodePath.join(dir, "systemctl.log"),
      unhealthy,
      releases: [],
      archives,
      server,
      port: address.port,
    };
    await install("0.0.40-vps.1");
    await install("0.0.42-vps.3");
    await NodeFSP.symlink(`${root}/0.0.42-vps.3`, `${root}/current`);
    await publish("cli-0.0.42-vps.3");
  });

  afterEach(async () => {
    fixture.server.closeAllConnections();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    await NodeFSP.rm(fixture.dir, { recursive: true, force: true });
  });

  it("installs the newest release for this architecture and keeps one rollback version", async () => {
    await publish("cli-0.0.43-vps.4");
    await publish("cli-0.0.43-vps.5", "arm64");
    fixture.releases.push({ tag_name: "v0.0.43", draft: false, assets: [] });

    const { code, output } = await run();

    expect(output).toContain("now running 0.0.43-vps.4");
    expect(code).toBe(0);
    expect(await current()).toBe("0.0.43-vps.4");
    expect(await installed()).toEqual(["0.0.42-vps.3", "0.0.43-vps.4"]);
    expect(await restarts()).toBe(1);
    expect((await run()).output).toContain("up to date (0.0.43-vps.4)");
    expect(await restarts()).toBe(1);
  });

  it("rolls back a release that fails its health check and does not retry it", async () => {
    await publish("cli-0.0.43-vps.4");
    fixture.unhealthy.add("0.0.43-vps.4");

    const { code, output } = await run();

    expect(code).not.toBe(0);
    expect(output).toContain("rolling back to 0.0.42-vps.3");
    expect(await current()).toBe("0.0.42-vps.3");
    expect(await restarts()).toBe(2);
    expect((await run()).output).toContain("cli-0.0.43-vps.4 failed before");
    expect(await restarts()).toBe(2);
  });

  it("rejects an archive whose binary reports another version", async () => {
    await publish("cli-0.0.43-vps.4", "x64", "0.0.42-vps.3");

    const { code, output } = await run();

    expect(code).not.toBe(0);
    expect(output).toContain("expected 't3 v0.0.43-vps.4'");
    expect(await current()).toBe("0.0.42-vps.3");
    expect(await restarts()).toBe(0);
  });

  it("waits while the server has child processes, up to the deferral limit", async () => {
    await publish("cli-0.0.43-vps.4");
    const child = NodeChildProcess.spawn("sleep", ["30"]);
    try {
      await NodeFSP.writeFile(
        NodePath.join(fixture.dir, "cgroup/t3.service/cgroup.procs"),
        `1\n${child.pid}\n`,
      );

      const deferred = await run();
      expect(deferred.code).toBe(0);
      expect(deferred.output).toContain("deferring cli-0.0.43-vps.4, server is busy: sleep(");
      expect(await current()).toBe("0.0.42-vps.3");
      expect(await restarts()).toBe(0);

      expect((await run({ T3_UPDATE_MAX_DEFER_HOURS: "0" })).output).toContain(
        "although the server is busy",
      );
      expect(await current()).toBe("0.0.43-vps.4");
    } finally {
      child.kill();
    }
  });
});
