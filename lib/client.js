// dsh-cordis-mcp — web client face (intentionally empty).
//
// All capability lives on the host half (an MCP endpoint for Claude Code);
// the browser has nothing to render. This file exists only so the web boot's
// module table has a valid client module to load — an empty plugin that
// contributes no UI and registers no slot.

window.__ModuleLoader__.load({
  id: "dsh-cordis-mcp",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    function apply() {
      // No browser UI: the MCP endpoint is consumed by external clients.
    }

    exports.apply = apply;
    exports.inject = [];
    return module.exports;
  },
});
