import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, rename, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { parseDocument } from "yaml";
import { getAgentPath } from "./agent-dir.ts";
import type { McpServerManager } from "./server-manager.ts";

export const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
const resourceSchema = z.object({
  uri: z.string(), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  size: z.number().int().min(0).max(1024 * 1024),
});
const skillSchema = z.object({
  uri: z.string(),
  frontmatter: z.object({
    name: z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: z.string().min(1).max(1024).refine(value => value.trim().length > 0),
  }).passthrough(),
  resources: z.union([z.array(resourceSchema).min(1).max(100), z.literal("dynamic")]),
});
const listSchema = z.object({ skills: z.array(skillSchema).max(100), nextCursor: z.string().optional() });
const getSchema = z.object({ skill: skillSchema });
const meta = { "io.modelcontextprotocol/clientCapabilities": { extensions: { [SKILLS_EXTENSION]: {} } } };

function relativeResource(root: string, uri: string): string {
  if (!uri.startsWith(root)) throw new Error(`Skill resource outside its directory: ${uri}`);
  const parts = uri.slice(root.length).split("/").map(decodeURIComponent);
  if (parts.some(part => !part || part === "." || part === ".." || /[\\\x00-\x1f:?#]/.test(part) || part.includes("/") || part !== part.normalize("NFC"))) {
    throw new Error(`Unsafe skill resource path: ${uri}`);
  }
  return parts.join("/");
}

export async function importRemoteSkills(manager: McpServerManager, server: string, signal?: AbortSignal) {
  const connection = manager.getConnection(server);
  if (!connection || connection.status !== "connected") throw new Error(`MCP server ${server} is not connected`);
  if (!connection.client.getServerCapabilities()?.extensions?.[SKILLS_EXTENSION]) return undefined;
  const requestOptions = manager.getRequestOptions(server, signal);
  const origin = createHash("sha256").update(JSON.stringify([server, connection.definition])).digest("hex");
  const cache = getAgentPath("remote-skills", origin);
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(cache, ".staging-"));
  const manifests: unknown[] = [];
  const files: Array<{ relative: string; digest: string }> = [];
  const names = new Set<string>();
  const cursors = new Set<string>();
  const provenance: Array<{ server: string; uri: string; path: string }> = [];
  manager.incrementInFlight(server);
  try {
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await connection.client.request({ method: "skills/list", params: { _meta: meta, ...(cursor === undefined ? {} : { cursor }) } }, listSchema, requestOptions);
      for (const listed of result.skills) {
        if (names.has(listed.frontmatter.name)) throw new Error(`Duplicate remote skill name: ${listed.frontmatter.name}`);
        names.add(listed.frontmatter.name);
        if (names.size > 100) throw new Error("Remote skill count limit exceeded");
        const { skill } = await connection.client.request({ method: "skills/get", params: { uri: listed.uri, _meta: meta } }, getSchema, requestOptions);
        if (!isDeepStrictEqual(skill, listed)) throw new Error(`Skill changed during discovery: ${listed.uri}; reload to retry`);
        if (skill.resources === "dynamic") throw new Error(`Dynamic skills are not supported: ${skill.uri}`);
        if (!skill.uri.endsWith("/SKILL.md")) throw new Error(`Invalid skill URI: ${skill.uri}`);
        manifests.push(skill);
        const base = skill.uri.slice(0, -"SKILL.md".length);
        const folder = join(root, skill.frontmatter.name);
        const paths = new Set<string>();
        let total = 0;
        let foundInstructions = false;
        for (const resource of skill.resources) {
          signal?.throwIfAborted();
          total += resource.size;
          if (total > 5 * 1024 * 1024) throw new Error("Skill exceeds 5 MiB");
          const relative = relativeResource(base, resource.uri);
          const key = relative.toLowerCase();
          if (paths.has(key)) throw new Error(`Duplicate skill path: ${relative}`);
          paths.add(key);
          const response = await manager.readResource(server, resource.uri, signal);
          const content = response.contents[0];
          if (response.contents.length !== 1 || !content || content.uri !== resource.uri) throw new Error(`Resource response mismatch: ${resource.uri}`);
          const bytes = "text" in content ? Buffer.from(content.text, "utf8") : Buffer.from(content.blob, "base64");
          if (bytes.length !== resource.size || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== resource.digest) throw new Error(`Skill integrity mismatch: ${resource.uri}`);
          if (resource.uri === skill.uri) {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
            if (!match) throw new Error(`Missing skill frontmatter: ${skill.uri}`);
            const document = parseDocument(match[1]!, { uniqueKeys: true });
            if (document.errors.length) throw new Error(`Invalid skill frontmatter: ${skill.uri}`);
            if (!isDeepStrictEqual(document.toJS(), skill.frontmatter)) throw new Error(`Skill frontmatter mismatch: ${skill.uri}`);
            foundInstructions = true;
          }
          files.push({ relative: join(skill.frontmatter.name, relative), digest: resource.digest });
          const path = join(folder, relative);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
        }
        if (!foundInstructions) throw new Error(`Missing SKILL.md: ${skill.uri}`);
        provenance.push({ server, uri: skill.uri, path: join(folder, "SKILL.md") });
      }
      cursor = result.nextCursor;
      if (cursor === undefined) {
        const revision = createHash("sha256").update(JSON.stringify(manifests)).digest("hex");
        const destination = join(cache, revision);
        const published = provenance.map(item => ({ ...item, path: join(destination, item.path.slice(root.length + 1)) }));
        await writeFile(join(root, "provenance.json"), JSON.stringify(published, null, 2));
        try {
          await rename(root, destination);
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || !["ENOTEMPTY", "EEXIST"].includes(String(error.code))) throw error;
          for (const file of files) {
            const bytes = await readFile(join(destination, file.relative));
            if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== file.digest) throw new Error(`Cached skill integrity mismatch: ${file.relative}`);
          }
          await rm(root, { recursive: true, force: true });
        }
        return { root: destination, skillPaths: published.map(item => item.path), provenance: published };
      }
      if (cursors.has(cursor)) throw new Error("Repeated skills pagination cursor");
      cursors.add(cursor);
    }
    throw new Error("Skills pagination limit exceeded");
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  } finally {
    manager.decrementInFlight(server);
    manager.touch(server);
  }
}
