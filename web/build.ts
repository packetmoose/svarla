import * as esbuild from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(__dirname, "../dist/web");

const watch = process.argv.includes("--watch");

// Copy the static (non-bundled) assets into the output directory.
function copyStaticAssets() {
  cpSync(resolve(__dirname, "index.html"), resolve(outdir, "index.html"));
  cpSync(resolve(__dirname, "src/styles"), resolve(outdir, "styles"), {
    recursive: true,
  });

  const publicDir = resolve(__dirname, "../public");
  cpSync(resolve(publicDir, "favicon.ico"), resolve(outdir, "favicon.ico"));
  cpSync(resolve(publicDir, "icon-192.png"), resolve(outdir, "icon-192.png"));
  cpSync(resolve(publicDir, "icon-512.png"), resolve(outdir, "icon-512.png"));
  cpSync(resolve(publicDir, "apple-touch-icon.png"), resolve(outdir, "apple-touch-icon.png"));
}

async function build() {
  mkdirSync(outdir, { recursive: true });

  const buildOptions: esbuild.BuildOptions = {
    entryPoints: [resolve(__dirname, "src/main.tsx")],
    bundle: true,
    outfile: resolve(outdir, "bundle.js"),
    format: "esm",
    target: "es2020",
    minify: process.argv.includes("--minify"),
    sourcemap: true,
    jsxFactory: "h",
    jsxFragment: "Fragment",
    jsx: "transform",
    define: {
      "process.env.NODE_ENV": JSON.stringify(
        process.env.NODE_ENV || "development"
      ),
    },
  };

  copyStaticAssets();

  if (watch) {
    // Rebuild the bundle on source change and re-copy static assets after each rebuild.
    const ctx = await esbuild.context({
      ...buildOptions,
      plugins: [
        {
          name: "copy-static-assets",
          setup(pluginBuild) {
            pluginBuild.onEnd((result) => {
              copyStaticAssets();
              if (result.errors.length === 0) {
                console.log("Web rebuild complete → dist/web/");
              }
            });
          },
        },
      ],
    });
    await ctx.watch();
    console.log("Watching web sources for changes → dist/web/");
    // Keep the process alive.
    return;
  }

  await esbuild.build(buildOptions);
  console.log("Web build complete → dist/web/");
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
