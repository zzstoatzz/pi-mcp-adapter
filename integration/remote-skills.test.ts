import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { McpServerManager } from "../server-manager.ts";
import { importRemoteSkills } from "../remote-skills.ts";

test("Skills over real stdio MCP", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "pi-skills-integration-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home;
  const manager = new McpServerManager();
  const definition = { command: "uv", args: ["run", "--script", resolve("integration/skills-server.py")], protocolVersion: "auto" as const };
  try {
    const connection = await manager.connect("fixture", definition);
    const snapshot = await importRemoteSkills(manager, "fixture");
    assert(snapshot);
    const file = snapshot.skillPaths[0]!;
    await t.test("discovers and verifies instructions and nested references", async () => {
      assert.match(await readFile(file, "utf8"), /name: fixture/);
      assert.equal(await readFile(join(dirname(file), "references/help.txt"), "utf8"), "reference contents");
    });
    await t.test("identical manifests reuse a persistent snapshot", async () => {
      assert.equal((await importRemoteSkills(manager, "fixture"))?.root, snapshot.root);
    });
    for (const [value, error] of [["digest", /integrity mismatch/], ["traversal", /Unsafe/], ["duplicate", /Duplicate/], ["frontmatter", /frontmatter mismatch/], ["dynamic", /Dynamic/], ["changed", /changed during discovery/]] as const) {
      await t.test(`rejects ${value}`, async () => {
        await connection.client.callTool({ name: "scenario", arguments: { value } });
        await assert.rejects(importRemoteSkills(manager, "fixture"), error);
      });
    }
    await connection.client.callTool({ name: "scenario", arguments: { value: "valid" } });
    await t.test("rejects modified cached bytes", async () => {
      const original = await readFile(file);
      await writeFile(file, "tampered");
      await assert.rejects(importRemoteSkills(manager, "fixture"), /Cached skill integrity/);
      await writeFile(file, original);
    });
    await t.test("does not call skill methods on ordinary servers", async () => {
      const c = await manager.connect("plain", { ...definition, args: [...definition.args, "--plain"] });
      assert.equal(await importRemoteSkills(manager, "plain"), undefined);
      assert(c.tools.some(tool => tool.name === "scenario"));
    });
    await t.test("failed imports leave no staging directories", async () => {
      for (const origin of await readdir(join(home, "remote-skills"))) {
        assert((await readdir(join(home, "remote-skills", origin))).every(name => !name.startsWith(".staging-")));
      }
    });
    await manager.closeAll();
    await t.test("snapshot remains readable after disconnect for session resume", async () => {
      assert.match(await readFile(file, "utf8"), /name: fixture/);
    });
  } finally {
    await manager.closeAll();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(home, { recursive: true, force: true });
  }
});
