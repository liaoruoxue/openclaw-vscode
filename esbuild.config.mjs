import * as esbuild from "esbuild";

const isWatch = process.argv.includes("--watch");

/** @type {esbuild.BuildOptions} */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode", "ws"],
  format: "cjs",
  platform: "node",
  target: "node22",
  sourcemap: true,
};

/** @type {esbuild.BuildOptions} */
const chatWebviewConfig = {
  entryPoints: ["src/webview/chat/index.tsx"],
  bundle: true,
  outfile: "dist/webview/chat.js",
  format: "esm",
  platform: "browser",
  target: "chrome120",
  sourcemap: true,
  jsx: "automatic",
};

/** @type {esbuild.BuildOptions} */
const canvasWebviewConfig = {
  entryPoints: ["src/webview/canvas/index.tsx"],
  bundle: true,
  outfile: "dist/webview/canvas.js",
  format: "esm",
  platform: "browser",
  target: "chrome120",
  sourcemap: true,
  jsx: "automatic",
};

/** @type {esbuild.BuildOptions} */
const a2uiBundleConfig = {
  entryPoints: ["vendor/a2ui/bootstrap.js"],
  bundle: true,
  outfile: "dist/webview/a2ui.bundle.js",
  format: "esm",
  platform: "browser",
  target: "chrome120",
  sourcemap: false,
  alias: {
    "@a2ui/lit": "./vendor/a2ui/lit/src/index.ts",
    "@a2ui/lit/ui": "./vendor/a2ui/lit/src/0.8/ui/ui.ts",
    "@openclaw/a2ui-theme-context":
      "./vendor/a2ui/lit/src/0.8/ui/context/theme.ts",
  },
};

const configs = [extensionConfig, chatWebviewConfig, canvasWebviewConfig, a2uiBundleConfig];

async function main() {
  if (isWatch) {
    const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log("[watch] Build started...");
  } else {
    await Promise.all(configs.map((c) => esbuild.build(c)));
    console.log("[build] Done.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
