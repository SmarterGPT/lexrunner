import { Command, Help } from "commander";

const FIRST_USE_COMMANDS = new Set([
  "idea",
  "create-project",
  "attempt",
  "weave",
  "gate",
  "plan",
  "schema",
  "workspace",
  "help",
]);

/** Presentation only: retain the registered tree and all command-specific help. */
export function configureProgressiveHelp(root: Command): void {
  root.configureHelp({
    formatHelp(command, helper) {
      if (command !== root || root.opts().helpAll) {
        return Help.prototype.formatHelp.call(this, command, helper);
      }
      // Commander also uses visibleCommands for unknown-command suggestions.
      // Scope the smaller inventory to this rendering, preserving error discovery.
      const presentation: Help = Object.create(helper);
      presentation.visibleCommands = (entry) => {
        const commands = helper.visibleCommands(entry);
        return entry === root
          ? commands.filter((child) => FIRST_USE_COMMANDS.has(child.name()))
          : commands;
      };
      return Help.prototype.formatHelp.call(this, command, presentation);
    },
  });
  root
    .option("--help-all", "Show all command families and compatibility aliases")
    .on("option:help-all", () => root.help());
  root.addHelpText(
    "after",
    `
Start with a reviewable GitHub integration plan:
  lexrunner weave discover --json                          Read open PRs from GitHub
  lexrunner weave plan --from-github --output plan.json --json
                                                          Read GitHub and write the plan file
  lexrunner schema validate plan.json --json               Validate the saved plan
  lexrunner weave merge-order plan.json --json              Inspect dependency order
  lexrunner gate run plan.json --dry-run --json              Preview gates without running them

Choose an unused plan filename. Inspect selected heads, dependencies and executable
gate commands. Preview may write local diagnostics; it proves neither passed gates
nor review or merge authority. Later gate execution runs commands; weave apply
--execute changes Git state and requires separate review and explicit authority.

Plan tasks without GitHub:
  lexrunner plan levels --plan plan.json --json             Read authored task dependency levels
This offline query needs no Git checkout, profile, network or token. It does not
execute tasks or gates. See packaged docs/offline-planning.md for planning and gates.

Plan and carry out authored work:
  lexrunner idea --help             Capture an idea; normal execution may create GitHub issues
  lexrunner create-project --help   Build a work plan; may write files and create issues
  lexrunner attempt --help          Materialize selected work, prepare, attach, submit and verify
Selection and materialization do not launch workers. Preparation changes workspace
and lifecycle state; the assisted host owns actual worker launch and dispatch.
Completion requires evidence and reassessment against success criteria.

Explore further:
  lexrunner --help-all              All command families, aliases, diagnostics and recovery
  lexrunner <command> --help        Full help for that command, including nested operations
  lexrunner workspace --help        Setup and environment diagnostics

Walkthrough: https://github.com/SmarterGPT/lexrunner/blob/main/MERGE_WEAVE_QUICKSTART.md
`
  );
}
