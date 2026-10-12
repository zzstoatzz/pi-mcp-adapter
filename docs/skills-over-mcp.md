# Skills over MCP

This fork is maintained by zzstoatzz for daily use in Pi and Gardener. It starts from upstream pi-mcp-adapter 5.2.0 (4b08a15) and uses Pi's public `resources_discover` extension API. Pi core is unchanged.

Enable experimental SEP-2640 skills for an individual trusted MCP server:

```json
{
  "mcpServers": {
    "personal-skills": {
      "command": "stoat-skills",
      "args": ["--profile", "interactive"],
      "skills": true,
      "protocolVersion": "auto",
      "exposeResources": false
    }
  }
}
```

At startup and `/reload`, the adapter connects through its ordinary connection and project-trust path. If the server advertises `io.modelcontextprotocol/skills`, it lists skills, gets each manifest, downloads the static resources and verifies their sizes, SHA-256 digests, paths, and frontmatter. Servers without the extension continue to work normally. Opting into skills makes that server connect during discovery, even when tool connections would otherwise be lazy.

Pi adds the verified skill names, descriptions, and file locations to its native catalog. The model reads `SKILL.md` when relevant, then supporting files as needed. Download is eager; model-context disclosure is progressive. New server connections become skill sources on the next reload.

Snapshots live under the Pi agent directory's `remote-skills` folder, keyed by server configuration and manifest. Older snapshots remain readable for resumed sessions. There is currently no automatic garbage collection; removing them can invalidate paths in old conversations. Discovery fails visibly on corrupt or unsupported manifests and does not substitute stale content.

This initial implementation supports static manifests, up to 100 skills per server, 100 files per skill, 1 MiB per file and 5 MiB per skill. Dynamic skills are not supported. Native local skills with the same name retain Pi's normal collision behavior; exclude the local copy when migrating a skill to MCP.

Run `npm run test:skills` for real stdio tests against the pinned experimental FastMCP implementation. The fixture requires `uv` and network access on its first dependency installation.
