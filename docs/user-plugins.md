# User plugins

Noyucord's desktop User plugins settings can install a local entry file, folder, or ZIP, an HTTPS download, or a public GitHub repository, folder, file, or release asset. Installation does not require a source checkout, Git, Node, or a client rebuild.

Imported code runs with the renderer's privileges. Only install code you trust. The loader does not isolate code from Discord or other plugins.

Plugins with a native helper require a separate trust confirmation for each version. Native code runs in Electron's main process with Node access. It can read or change files and run programs on your computer. Native changes require completely quitting and reopening the client, including when disabling or removing a plugin. Reloading Discord does not unload native code.

Plugins install disabled. Enable them and restart the client to load them. Installing, updating, disabling, and uninstalling also take effect after restart. The installed list shows pending changes separately from the current session.

Installed plugins use the same cards and switches as the Plugins page. Enabling or disabling a plugin shows a restart card, including plugins that have never been enabled. Leaving the tab with pending changes opens the usual restart confirmation. Choosing Restart now fully relaunches Discord or the desktop wrapper. Toggling back to the session's original enable state clears that pending toggle.

## Plugin packages

A package has one plugin root containing `noyucord.plugin.json` and its entry file:

```json
{
    "schemaVersion": 1,
    "apiVersion": 1,
    "id": "example-plugin",
    "name": "ExamplePlugin",
    "version": "1.0.0",
    "description": "Adds a local example action.",
    "authors": [{ "name": "Example author" }],
    "entry": "index.ts",
    "format": "source",
    "target": "desktop",
    "dependencies": []
}
```

`id` is the package identity and must stay stable across updates. Capital letters are converted to lowercase in the import form and manifest validation. Use letters, numbers, dots, underscores, and hyphens, with at most 100 characters. Product namespaces and platform-reserved names are unavailable. `name` must match the exported plugin definition and cannot collide with another installed or bundled plugin. Keep it stable to preserve settings.

Supported targets are `desktop` (injected Discord and the compatible desktop wrapper), `discordDesktop`, and `equibop` (the inherited wrapper build target). These internal target names remain for compatibility.

Use `format: "source"` for JS, JSX, TS, or TSX source. Use `format: "prebuilt"` for an already bundled JavaScript CommonJS entry. A prebuilt entry may export the plugin directly or through `exports.default`.

The plugin exports an ordinary Noyucord/Vencord-style definition. It can use settings, lifecycle methods, commands, renderer APIs, and source patches. Dependencies list other plugin names, not npm packages. The manifest and exported dependency lists must match.

```ts
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";

const settings = definePluginSettings({
    enabledAction: {
        type: OptionType.BOOLEAN,
        description: "Enable the example action.",
        default: true
    }
});

export default definePlugin({
    name: "ExamplePlugin",
    description: "Adds a local example action.",
    authors: [{ name: "Example author", id: 0n }],
    settings,
    start() {},
    stop() {}
});
```

Use a real Discord ID when available; `0n` is the existing no-ID sentinel. Names and IDs in this example identify the example only. When adapting an existing plugin, retain its original authors and license.

## Existing source

Source without a manifest can be imported. The import form derives static metadata from `export default definePlugin({...})` or a directly exported object where possible. It reads inline authors and `Devs.NAME`, `EquicordDevs.NAME`, or `NoyucordDevs.NAME` references imported from `@utils/constants`, including import aliases. Names and Discord IDs come from the contributor lists bundled with this build. If a record is missing, the form uses the handle written in the source without inventing a Discord ID and shows a notice. Fill in missing metadata before installing. The reviewed author metadata is included in the compiled plugin; the original sources and host contributor registries stay intact.

Supported files include package-local JS, JSX, TS, TSX, JSON, CSS, managed CSS (`./style.css?managed`), and common image assets. Source compilation uses the host React runtime and approved `@api`, `@utils`, `@components`, and webpack imports. Unsupported host modules produce an import error instead of copying host internals into the plugin.

Default plugin imports through `@plugins`, `@equicordplugins`, or `@noyucordplugins` refer to available host plugins. Declare the corresponding plugin names as dependencies. Do not import arbitrary files from their source directories.

The installer does not run package scripts or fetch npm dependencies. Bundle external libraries yourself before distributing a package. Dynamic imports, CSS `@import`, and native `.node` addons are unsupported. Standard Noyucord renderer packages also reject computed `require` and direct Node/Electron runtime imports; those imports belong in native helpers. BetterDiscord compatibility uses its separate restricted module resolver described below.

A source package can include a `native.ts` helper, its JavaScript/JSX/TSX equivalent, or `native/index.ts`. The installer detects a single conventional helper automatically. Prepared packages can declare an explicit `"native": "native.ts"` entry in their manifest. Multiple native entries require an explicit manifest choice. Native helpers may import package-local JS, TS, JSON, Electron, and Node builtin modules. They cannot install npm packages or run installation scripts.

Export named functions from the helper. The host passes an Electron IPC event as the first argument, followed by the renderer arguments, matching bundled plugins. Existing calls such as `VencordNative.pluginHelpers.PluginName.method(...)` work for enabled user plugins. `NoyucordNative` points to the same bridge. Helpers load once per app process, in dependency order. Disabled plugins, recovery, and the startup bypass flag skip helper evaluation. A failed helper prevents its renderer plugin and dependent user plugins from loading, while other plugins remain manageable.

Updates to native packages require accepting the computer-access warning again. An update that adds a native helper to a renderer-only plugin must be imported again so its native access can be reviewed. Failed compilation or a declined native update retains the installed version.

Packages are limited to 2,000 files, 10 MiB per file, and 50 MiB total. Do not include `.git`, `node_modules`, symlinks, or paths outside the plugin root.

## Updates and recovery

Noyucord checks remembered remote sources at most once per day and notifies about available updates. It installs an update only when requested. GitHub commit-pinned imports remain pinned. Local plugins update by selecting their replacement files or folder.

Updates retain a previous version for rollback. Settings remain on disable or uninstall unless you explicitly remove saved settings. Plugin-owned DataStore entries are not deleted automatically.

If startup is interrupted, use recovery in User plugins settings. Clearing recovery disables all user plugins, allowing you to enable them individually. Starting the desktop client with `--noyucord-disable-userplugins` skips user-code evaluation before it begins. Recovery can help with startup failures but cannot prevent every renderer crash or a plugin that blocks the event loop.

## BetterDiscord compatibility

BetterDiscord compatibility is experimental. Import a `.plugin.js` file or its public source through the same User plugins controls. The importer reads its JSDoc metadata without running it. Class and factory exports are evaluated only when enabled, after Discord connects. Existing Noyucord packages keep their startup stages and source-patch behavior.

Local file imports fill in the name, ID, version, description, authors, and detected dependencies from that file. Leading license comments or a shebang can precede the metadata header. Missing information stays editable in the review form.

Both formats share installation, search, cards, configuration, update/removal controls, recovery, and the full Discord restart prompt. BetterDiscord settings panels can return React content, components, HTML elements, or legacy HTML strings. Disabled plugin details use metadata and do not evaluate the plugin.

Required libraries appear in the installation review and the plugin's collapsed dependency details. Approve their sources and versions before installing the set. The current provider profiles are ZeresPluginLibrary 2.0.23 and BDFDB 4.5.8. BDFDB's matching JSON and CSS are installed with it and served locally during startup. Provider code and licenses remain separate upstream dependency packages. They do not appear as additional plugin cards; unused libraries remain manageable through a collapsed dependency control on this page.

Import the plugin that needs a library rather than the library file itself. Standalone provider imports are rejected so they cannot bypass the reviewed version or omit required resources.

An existing provider is reused even if its package ID, source, version, or pinned revision differs from the current installation profile. The review shows its installed version and source. Importing another plugin does not download or replace that library. Finish any pending library removal before importing a dependent plugin.

Enabling a plugin also enables its approved required providers. Libraries needed by enabled plugins cannot be disabled or removed. Provider resources and source revisions are checked before loading. A failed installation retains the previous installation and its settings.

Provider code starts only when an enabled plugin depends on it. Unused libraries stay installed without applying their global Discord patches.

BDFDB class lookups that find nothing are remembered. They are searched again only after Discord loads a module that could match, so missing Discord classes no longer repeat full module scans.

The adapter supplies shared Discord React, runtime function patching, Webpack searches, synchronous plugin data, DOM/style helpers, common UI/settings controls, context menus, and addon descriptors. Supported Node compatibility modules are `fs`, `path`, `process`, `request`, and selected `electron` operations. React imports use Discord's runtime. Computed module names still go through this same fixed resolver.

Native compatibility access needs approval for each installed version that requests it. Filesystem operations are limited to managed plugin sources and compatibility data; installed source revisions are read-only. Network requests use bounded public HTTPS operations without authentication headers. Clipboard and external-link operations use the native bridge. Arbitrary Electron IPC, process execution, npm modules, and native addons are unavailable. These limits do not sandbox trusted renderer code or protect Discord session data from it.

BetterDiscord data is stored separately from source revisions, survives ordinary uninstall, and is saved before a requested relaunch. Library updaters route through Noyucord's update checks and review controls. They cannot replace installed sources directly. Pinned provider profiles change through compatibility updates rather than downloading new provider code during startup.

Data changes send individual keys to the native bridge while retaining synchronous reads, JSON validation, the 1 MiB limit, and rollback on rejected saves. Renderer reloads connected to an older native bridge retain the full-data operation until the client is fully restarted.

Compatibility follows the BetterDiscord 1.14 API with legacy aliases for these providers. Unsupported calls fail with the API name. This includes `Hooks`, `Commands`, `Utils.Store`, `ReactUtils.wrapInHooks` and `ReactUtils.createNodePatcher`, the BetterDiscord `Components` set, regex and glob context menu patches, and bound `DOM.addStyle(css)`. Slash commands register through Noyucord's command list and post their results as bot messages. Theme queries expose host theme metadata, and theme toggles change the host's enabled themes. `UI.openDialog`, closing a notification from `UI.showNotification`, and `Components.Modal` are not available. Old Discord selectors and discontinued library internals can still fail; compiler and fixture tests do not establish live compatibility for every plugin or provider version.

When a BetterDiscord consumer is enabled, the main Webpack execution hook captures factory-local variables before Discord initializes them. `module.declarations`, `declarationFilter`, `mapDeclarations`, and explicit `getWithKey({ target })` searches use live references. Changing a writable declaration affects its original module, and unpatching restores that binding. Constant bindings retain JavaScript's assignment errors. Factories are parsed once when first executed; side Webpack instances and sessions without enabled BetterDiscord consumers keep their ordinary execution path.

Fully quit and reopen Discord after updating the declaration bridge. Already executed modules are not run again to recover their private variables. Legacy confirmation-modal and voice-channel lookups use the host's current implementations; custom settings children and radio option names remain in the existing User plugins settings surface.

Legacy modal-size lookups map to the current host modal. Modal render failures close the affected modal and report the owning plugin's error. The first plugin failure stays visible even if cleanup also fails. Missing optional patch targets return `null`, matching BetterDiscord's patcher contract; configurable getter exports restore their original descriptors when unpatched.

## Development checks

From the repository root:

```text
pnpm test:userplugins
pnpm test:betterdiscord:runtime
```

The compiler suite builds and runs the actual WASM worker. The runtime suite uses the real registry and plugin manager with controlled Discord/native host modules. These checks do not replace testing the plugin in the desktop client.
