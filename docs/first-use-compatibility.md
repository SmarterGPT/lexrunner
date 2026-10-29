# Choose the smallest installation

This guide targets `@smartergpt/lexrunner@2.5.0`, Node.js 24+ and Git.
GitHub discovery needs repository access; running gates also needs the tools and
project dependencies named by the plan. npm installs package dependencies. You do
not need every SmarterGPT component or an MCP connection for the CLI walkthrough.

## Which interface do I use?

| Need                                           | Start with                                 | Add only when needed                                    |
| ---------------------------------------------- | ------------------------------------------ | ------------------------------------------------------- |
| Inspect and integrate GitHub PRs in a terminal | LexRunner CLI                              | LexRunner MCP for an agent client                       |
| Give an agent plan, gate and integration tools | LexRunner MCP, shipped in the same package | Explicit client tool permissions and repository context |
| Remember work and retrieve policy context      | Lex CLI, or Lex MCP for an agent           | Store setup appropriate to that workspace               |
| Discover repeatable workspace actions          | AXF CLI or AXF MCP                         | Workspace capability definitions                        |
| Derive behavioral constraints                  | LexSona                                    | Its documented scoped runtime setup                     |

AXF MCP and LexRunner MCP serve different needs; you do not have to connect both.
An MCP client launches a stdio process. For a local LexRunner installation, configure
it to launch your native Node executable with the absolute path to
`node_modules/@smartergpt/lexrunner/mcp-server.mjs`, and the intended repository as
its working directory using the client's supported configuration. A global install
also provides `lexrunner-mcp`. Avoid copying a maintainer's `/srv/...` source path.

Forward `GITHUB_TOKEN` through the client's supported secret/environment mechanism
when needed. Keep `ALLOW_MUTATIONS=false` for the initial connection. That setting
blocks protected mutation operations such as merge; it does **not** make every tool
read-only. Plan creation writes files, and gate tools execute commands. Review and
authorize those tool calls separately through your client's controls.

[Detailed MCP reference](../README.mcp.md) · [Tool contracts](AX.md)

Maintainers adopting reviewed source changes can use the repository's
[local dogfood installer](local-dogfood-install.md), which retains the exact
dependency lock and native-script policy across the global installation boundary.

## Which Lex and SQLite versions does this source candidate support?

Published LexRunner 2.5.0 pins Lex 4.0.3. This source candidate upgrades to exact
`@smartergpt/lex@4.4.4` and exact `better-sqlite3-multiple-ciphers@13.0.3`,
matching Lex 4.4.4's native dependency. A source change does not establish that a
new LexRunner release has been published or that an installed runtime was updated.

The [1.5.2 alignment record](releases/1.5.2.md) and
[#938](https://github.com/SmarterGPT/lexrunner/issues/938) explain the deliberate
exact pin: preserve reproducible consumer dependency identity instead of selecting
a changing Lex version during installation. The upgrade preserves that strategy;
it does not widen to `^4.4.4` or follow the registry's moving `latest` tag.

`npm run check:lex-compatibility` checks the source support claim against the
manifest, lock, installed Lex and native dependency, exact native script approval,
and Lex script denial. It rejects duplicate locked Lex/native installations and
checks that Lex resolves the same native installation as LexRunner. CI runs this
check through lint. Version changes require deliberate requalification, including
packed ESM/CommonJS/CLI/MCP and SQLite lifecycle tests.

This aligns LexRunner with Lex, not every separately installed ecosystem package.
Published LexSona 2.0.4 still depends on `^12.6.2` of the SQLite binding and has a
Lex peer range of `>=4.0.1 <5`. Installing it alongside this candidate can therefore
still require a second native major. LexSona needs a separate reviewed upgrade;
do not override its dependency or copy a 13.x native binary into a 12.x package.
The ecosystem dogfood defaults update Lex/Lex-MCP to 4.4.4 and retain the existing
AXF/LexSona pins; those defaults are test inputs, not a new compatibility certificate.

LexRunner uses Lex's policy, aliases and error exports; its coordination SQLite
store is owned by LexRunner. This upgrade does not migrate a standalone Lex store,
share store identity or replace the workspace's scoped runtime configuration.
Do not infer shared store identity merely because both installations use Lex.

Context Forge is not required for this workflow and has no public npm release.
Do not install a guessed package or treat its local linker explanations as proof
of context delivered to a model. A future compatibility matrix and consumer-bound
context delivery evidence are separate work.
