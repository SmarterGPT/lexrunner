# Choose the smallest installation

This guide targets `@smartergpt/lexrunner@2.4.0`, Node.js 24+ and Git.
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

## Why does LexRunner depend on Lex 4.0.3?

LexRunner 2.4.0 declares exact `@smartergpt/lex@4.0.3`. The
[1.5.2 alignment record](releases/1.5.2.md) explains the deliberate pin: preserve
reproducible consumer dependency identity instead of selecting a changing Lex 4
version during installation. It is historical rationale, not proof that every
current cross-component combination has passed integration tests.

A newer standalone Lex does not require changing LexRunner's private dependency.
Do not override the pin, deduplicate incompatible versions, or infer shared store
identity merely because both installations use Lex. Cross-component runtime/store
sharing requires its own verified setup. The first-use trial uses the package's
unchanged dependency contract; it does not certify substituting Lex 4.2.0.

Context Forge is not required for this workflow and has no public npm release.
Do not install a guessed package or treat its local linker explanations as proof
of context delivered to a model. A future compatibility matrix and consumer-bound
context delivery evidence are separate work.
