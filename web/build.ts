import * as esbuild from "esbuild";
import { cpSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(__dirname, "../dist/web");
const webDir = __dirname;

const watch = process.argv.includes("--watch");
// esbuild's native watcher relies on filesystem events (inotify), which are
// not reliably delivered across Docker bind mounts. When WATCH_POLL is set
// (see docker-compose.yml) we fall back to polling the source tree for mtime
// changes instead. Interval is configurable via WATCH_POLL (ms), default 300.
const pollInterval = process.env.WATCH_POLL
  ? Number(process.env.WATCH_POLL) || 300
  : 0;

// Recursively find the most recent mtime (ms) under `dir`. Used by the
// polling watcher to detect changes across Docker bind mounts. Node modules
// and hidden directories are skipped to keep the walk cheap.
function latestMtime(dir: string): number {
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        newest = Math.max(newest, latestMtime(full));
      } else {
        newest = Math.max(newest, statSync(full).mtimeMs);
      }
    } catch {
      // File may have been removed mid-walk; ignore.
    }
  }
  return newest;
}

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

    if (pollInterval > 0) {
      // Polling watcher: reliable across Docker bind mounts where inotify
      // events are not delivered. Walk the web source tree, track the newest
      // mtime, and trigger a rebuild whenever it advances.
      await ctx.rebuild();
      console.log(
        `Polling web sources every ${pollInterval}ms for changes → dist/web/`
      );
      let lastMtime = latestMtime(webDir);
      let rebuilding = false;
      setInterval(async () => {
        if (rebuilding) return;
        const current = latestMtime(webDir);
        if (current > lastMtime) {
          lastMtime = current;
          rebuilding = true;
          try {
            await ctx.rebuild();
          } catch {
            // esbuild prints its own error output; keep watching.
          } finally {
            rebuilding = false;
          }
        }
      }, pollInterval);
      return;
    }

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
