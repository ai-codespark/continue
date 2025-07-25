const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");
const ncp = require("ncp").ncp;
const { rimrafSync } = require("rimraf");
const { validateFilesPresent } = require("../scripts/util");
const { ALL_TARGETS, TARGET_TO_LANCEDB } = require("./utils/targets");
const { fork } = require("child_process");
const {
  installAndCopyNodeModules,
} = require("../extensions/vscode/scripts/install-copy-nodemodule");
const { bundleBinary } = require("./utils/bundle-binary");

const bin = path.join(__dirname, "bin");
const out = path.join(__dirname, "out");
const build = path.join(__dirname, "build");

function cleanSlate() {
  // Clean slate
  rimrafSync(bin);
  rimrafSync(out);
  rimrafSync(build);
  rimrafSync(path.join(__dirname, "tmp"));
  rimrafSync(path.join(__dirname, "tree-sitter"));
  fs.mkdirSync(bin);
  fs.mkdirSync(out);
  fs.mkdirSync(build);
}

const esbuildOutputFile = "out/index.js";
let targets = [...ALL_TARGETS];

const assetBackups = [
  "node_modules/win-ca/lib/crypt32-ia32.node.bak",
  "node_modules/win-ca/lib/crypt32-x64.node.bak",
];

let esbuildOnly = false;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--esbuild-only") {
    esbuildOnly = true;
  }
  if (process.argv[i - 1] === "--target") {
    targets = [process.argv[i]];
  }
}

// Bundles the extension into one file
async function buildWithEsbuild() {
  console.log("[info] Building with esbuild...");
  await esbuild.build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    outfile: esbuildOutputFile,
    external: [
      "esbuild",
      "./xhr-sync-worker.js",
      "llamaTokenizerWorkerPool.mjs",
      "tiktokenWorkerPool.mjs",
      "vscode",
      "./index.node",
    ],
    format: "cjs",
    platform: "node",
    sourcemap: true,
    minify: !esbuildOnly,
    treeShaking: true,
    loader: {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      ".node": "file",
    },

    // To allow import.meta.path for transformers.js
    // https://github.com/evanw/esbuild/issues/1492#issuecomment-893144483
    inject: ["./importMetaUrl.js"],
    define: {
      "import.meta.url": "importMetaUrl",
      "process.env.LITELLM_API_BASE": `"${process.env.LITELLM_API_BASE || "http://127.0.0.1:4000"}"`,
    },
  });
}

(async () => {
  if (esbuildOnly) {
    await buildWithEsbuild();
    return;
  }

  cleanSlate();

  // Informs of where to look for node_sqlite3.node https://www.npmjs.com/package/bindings#:~:text=The%20searching%20for,file%20is%20found
  // This is only needed for our `pkg` command at build time
  fs.writeFileSync(
    "out/package.json",
    JSON.stringify(
      {
        name: "binary",
        version: "1.0.0",
        author: "Continue Dev, Inc",
        license: "Apache-2.0",
      },
      undefined,
      2,
    ),
  );

  const copyLanceDBPromises = [];
  for (const target of targets) {
    if (!TARGET_TO_LANCEDB[target]) {
      continue;
    }
    console.log(`[info] Downloading for ${target}...`);
    copyLanceDBPromises.push(
      installAndCopyNodeModules(TARGET_TO_LANCEDB[target], "@lancedb"),
    );
  }
  await Promise.all(copyLanceDBPromises).catch(() => {
    console.error("[error] Failed to copy LanceDB");
    process.exit(1);
  });
  console.log("[info] Copied all LanceDB");

  // tree-sitter-wasm
  const treeSitterWasmsDir = path.join(out, "tree-sitter-wasms");
  fs.mkdirSync(treeSitterWasmsDir);
  await new Promise((resolve, reject) => {
    ncp(
      path.join(
        __dirname,
        "..",
        "core",
        "node_modules",
        "tree-sitter-wasms",
        "out",
      ),
      treeSitterWasmsDir,
      { dereference: true },
      (error) => {
        if (error) {
          console.warn("[error] Error copying tree-sitter-wasm files", error);
          reject(error);
        } else {
          resolve();
        }
      },
    );
  });

  // copy tree-sitter colder to binary folder to make it available when running in intellij debug mode
  const treeSitterDir = path.join(__dirname, "tree-sitter");
  fs.mkdirSync(treeSitterDir);
  await new Promise((resolve, reject) => {
    ncp(
      path.join(__dirname, "..", "extensions", "vscode", "tree-sitter"),
      treeSitterDir,
      { dereference: true },
      (error) => {
        if (error) {
          console.warn("[error] Error copying tree-sitter files", error);
          reject(error);
        } else {
          resolve();
        }
      },
    );
  });

  const filesToCopy = [
    "../core/vendor/tree-sitter.wasm",
    "../core/llm/llamaTokenizerWorkerPool.mjs",
    "../core/llm/llamaTokenizer.mjs",
    "../core/llm/tiktokenWorkerPool.mjs",
  ];
  for (const f of filesToCopy) {
    fs.copyFileSync(
      path.join(__dirname, f),
      path.join(__dirname, "out", path.basename(f)),
    );
    console.log(`[info] Copied ${path.basename(f)}`);
  }

  console.log("[info] Cleaning up artifacts from previous builds...");

  // delete asset backups generated by previous pkg invocations, if present
  for (const assetPath of assetBackups) {
    fs.rmSync(assetPath, { force: true });
  }

  await buildWithEsbuild();

  // Copy over any worker files
  fs.cpSync(
    "../core/node_modules/jsdom/lib/jsdom/living/xhr/xhr-sync-worker.js",
    "out/xhr-sync-worker.js",
  );
  fs.cpSync("../core/llm/tiktokenWorkerPool.mjs", "out/tiktokenWorkerPool.mjs");
  fs.cpSync(
    "../core/llm/llamaTokenizerWorkerPool.mjs",
    "out/llamaTokenizerWorkerPool.mjs",
  );

  const buildBinaryPromises = [];
  console.log("[info] Building binaries with pkg...");
  for (const target of targets) {
    buildBinaryPromises.push(bundleBinary(target));
  }
  await Promise.all(buildBinaryPromises).catch(() => {
    console.error("[error] Failed to build binaries");
    process.exit(1);
  });
  console.log("[info] All binaries built");

  // Cleanup - this is needed when running locally
  fs.rmSync("out/package.json");

  const pathsToVerify = [];
  for (const target of targets) {
    const exe = target.startsWith("win") ? ".exe" : "";
    const targetDir = `bin/${target}`;
    pathsToVerify.push(
      `${targetDir}/continue-binary${exe}`,
      `${targetDir}/index.node`, // @lancedb
      `${targetDir}/build/Release/node_sqlite3.node`,
      `${targetDir}/rg${exe}`, // ripgrep binary
    );
  }

  // Note that this doesn't verify they actually made it into the binary, just that they were in the expected folder before it was built
  pathsToVerify.push("out/index.js");
  pathsToVerify.push("out/llamaTokenizerWorkerPool.mjs");
  pathsToVerify.push("out/tiktokenWorkerPool.mjs");
  pathsToVerify.push("out/xhr-sync-worker.js");
  pathsToVerify.push("out/tree-sitter.wasm");

  validateFilesPresent(pathsToVerify);

  console.log("[info] Done!");
  process.exit(0);
})();
