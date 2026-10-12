# /// script
# requires-python = ">=3.12"
# dependencies = ["fastmcp-slim[server] @ git+https://github.com/PrefectHQ/fastmcp.git@780cb4ce5ad27672040f5aafb87d5df14150ccc5#subdirectory=fastmcp_slim"]
# ///
import hashlib
import sys
from fastmcp import FastMCP
from fastmcp.server.extensions import ServerExtension, MethodBinding
from pydantic import BaseModel

mcp = FastMCP('skills-fixture')
mode = 'valid'
text = '---\nname: fixture\ndescription: A test skill\n---\nRead references/help.txt.\n'
uri = 'skill://fixture/SKILL.md'

@mcp.tool
def scenario(value: str) -> str:
    global mode
    mode = value
    return mode

@mcp.resource('skill://fixture/{path*}')
def resource(path: str) -> str:
    if path == 'SKILL.md':
        return text + ('tampered' if mode == 'digest' else '')
    return 'reference contents'

class Params(BaseModel):
    uri: str | None = None
    cursor: str | None = None

class Fixture(ServerExtension):
    identifier = 'io.modelcontextprotocol/skills'
    def methods(self):
        return [MethodBinding(method='skills/list', params_type=Params, handler=self.list), MethodBinding(method='skills/get', params_type=Params, handler=self.get)]
    def entry(self):
        def file(uri, data):
            return {'uri': uri, 'size': len(data.encode()), 'digest': 'sha256:' + hashlib.sha256(data.encode()).hexdigest()}
        files = [file(uri, text), file('skill://fixture/references/help.txt', 'reference contents')]
        if mode == 'traversal':
            files.append(file('skill://fixture/%2e%2e/escaped', 'reference contents'))
        if mode == 'duplicate':
            files.append(files[0])
        frontmatter = {'name': 'fixture', 'description': 'A test skill'}
        if mode == 'frontmatter':
            frontmatter['description'] = 'Wrong description'
        return {'uri': uri, 'frontmatter': frontmatter, 'resources': 'dynamic' if mode == 'dynamic' else files}
    async def list(self, ctx, params):
        return {'skills': [self.entry()]}
    async def get(self, ctx, params):
        entry = self.entry()
        if mode == 'changed':
            entry['frontmatter']['description'] = 'Changed after list'
        return {'skill': entry}

if "--plain" not in sys.argv:
    mcp.add_extension(Fixture())
mcp.run(transport="stdio", show_banner=False)
