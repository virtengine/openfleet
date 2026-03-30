/**
 * project-detection.mjs — Auto-detect project type, build tools, and commands.
 *
 * Scans a directory for manifest files and infers the project's language,
 * package manager, and standard commands (test, build, lint, syntax-check,
 * quality gate).
 * Handles mono-repos by detecting multiple stacks in a single root.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// ── Stack Definitions ────────────────────────────────────────────────────────

/**
 * Each stack entry describes a language/framework ecosystem and how to detect it.
 * Priority order matters — first match with a manifest file wins for "primary".
 */
const STACK_DEFINITIONS = [
  {
    id: "node",
    label: "Node.js",
    markers: ["package.json"],
    detectPackageManager(rootDir) {
      if (existsSync(resolve(rootDir, "pnpm-lock.yaml"))) return "pnpm";
      if (existsSync(resolve(rootDir, "yarn.lock"))) return "yarn";
      if (existsSync(resolve(rootDir, "bun.lockb")) || existsSync(resolve(rootDir, "bun.lock"))) return "bun";
      return "npm";
    },
    detectCommands(rootDir) {
      const pm = this.detectPackageManager(rootDir);
      const run = pm === "npm" ? "npm run" : pm === "yarn" ? "yarn" : pm === "pnpm" ? "pnpm" : "bun run";
      const scripts = readPackageJsonScripts(rootDir);
      const cmds = {
        test: scripts.test ? `${pm} test` : "",
        build: scripts.build ? `${run} build` : "",
        lint: scripts.lint ? `${run} lint` : "",
        syntaxCheck: "node --check",
        typeCheck: "",
        install: ["npm install"],
        start: scripts.dev ? `${run} dev` : scripts.start ? `${pm} start` : "",
        debug: `node --inspect ${scripts.start ? "$(npm run start 2>/dev/null)" : "index.js"}`,
      };
      if (existsSync(resolve(rootDir, "tsconfig.json"))) {
        cmds.typeCheck = `${pm === "npm" ? "npx" : pm} tsc --noEmit`;
        cmds.syntaxCheck = `${pm === "npm" ? "npx" : pm} tsc --noEmit`;
      }
      // Detect test framework
      const deps = readPackageJsonDeps(rootDir);
      if (deps.has("vitest")) cmds.testFramework = "vitest";
      else if (deps.has("jest")) cmds.testFramework = "jest";
      else if (deps.has("mocha")) cmds.testFramework = "mocha";
      else if (deps.has("ava")) cmds.testFramework = "ava";
      // Detect lint tool
      if (deps.has("eslint") && !scripts.lint) cmds.lint = `${pm === "npm" ? "npx" : pm} eslint .`;
      if (deps.has("biome") && !scripts.lint) cmds.lint = `${pm === "npm" ? "npx" : pm} biome check .`;
      return cmds;
    },
    detectFrameworks(rootDir) {
      const deps = readPackageJsonDeps(rootDir);
      const frameworks = [];
      if (deps.has("react") || deps.has("react-dom")) frameworks.push("react");
      if (deps.has("next")) frameworks.push("nextjs");
      if (deps.has("vue")) frameworks.push("vue");
      if (deps.has("nuxt")) frameworks.push("nuxt");
      if (deps.has("svelte")) frameworks.push("svelte");
      if (deps.has("angular") || deps.has("@angular/core")) frameworks.push("angular");
      if (deps.has("express")) frameworks.push("express");
      if (deps.has("fastify")) frameworks.push("fastify");
      if (deps.has("nestjs") || deps.has("@nestjs/core")) frameworks.push("nestjs");
      if (deps.has("electron")) frameworks.push("electron");
      return frameworks;
    },
  },
  {
    id: "python",
    label: "Python",
    markers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"],
    detectPackageManager(rootDir) {
      if (existsSync(resolve(rootDir, "poetry.lock")) || existsSync(resolve(rootDir, "pyproject.toml"))) {
        try {
          const toml = readFileSync(resolve(rootDir, "pyproject.toml"), "utf8");
          if (toml.includes("[tool.poetry]")) return "poetry";
        } catch {}
      }
      if (existsSync(resolve(rootDir, "Pipfile"))) return "pipenv";
      if (existsSync(resolve(rootDir, "uv.lock"))) return "uv";
      if (existsSync(resolve(rootDir, "pdm.lock"))) return "pdm";
      return "pip";
    },
    detectCommands(rootDir) {
      const pm = this.detectPackageManager(rootDir);
      const cmds = { test: "", build: "", lint: "", syntaxCheck: "python -m py_compile", typeCheck: "",
        install: ["pip install -r requirements.txt"],
        start: "python -m app",
        debug: "python -m debugpy --listen 5678 -m app",
      };

      // Test command
      if (existsSync(resolve(rootDir, "pytest.ini")) || existsSync(resolve(rootDir, "conftest.py"))) {
        cmds.test = pm === "poetry" ? "poetry run pytest" : pm === "uv" ? "uv run pytest" : "pytest";
      } else if (existsSync(resolve(rootDir, "pyproject.toml"))) {
        try {
          const toml = readFileSync(resolve(rootDir, "pyproject.toml"), "utf8");
          if (toml.includes("[tool.pytest]") || toml.includes("pytest")) {
            cmds.test = pm === "poetry" ? "poetry run pytest" : pm === "uv" ? "uv run pytest" : "pytest";
          }
        } catch {}
      }
      if (!cmds.test) cmds.test = pm === "poetry" ? "poetry run pytest" : "python -m pytest";

      // Build command
      if (pm === "poetry") cmds.build = "poetry build";
      else if (pm === "uv") cmds.build = "uv build";
      else cmds.build = "python -m build";

      if (pm === "poetry") {
        cmds.install = ["poetry install"];
        cmds.start = "poetry run python -m app";
        cmds.debug = "poetry run python -m debugpy --listen 5678 -m app";
      } else if (pm === "uv") {
        cmds.install = ["uv sync"];
        cmds.start = "uv run python -m app";
        cmds.debug = "uv run python -m debugpy --listen 5678 -m app";
      }

      // Lint / type check
      cmds.lint = pm === "poetry" ? "poetry run ruff check ." : "ruff check .";
      cmds.typeCheck = pm === "poetry" ? "poetry run mypy ." : "mypy .";
      cmds.syntaxCheck = "python -m py_compile";
      return cmds;
    },
    detectFrameworks(rootDir) {
      const frameworks = [];
      try {
        const content = readAllPythonDeps(rootDir);
        if (/\bdjango\b/i.test(content)) frameworks.push("django");
        if (/\bflask\b/i.test(content)) frameworks.push("flask");
        if (/\bfastapi\b/i.test(content)) frameworks.push("fastapi");
        if (/\btorch\b|\bpytorch\b/i.test(content)) frameworks.push("pytorch");
        if (/\btensorflow\b/i.test(content)) frameworks.push("tensorflow");
      } catch {}
      return frameworks;
    },
  },
  {
    id: "go",
    label: "Go",
    markers: ["go.mod"],
    detectPackageManager() { return "go"; },
    detectCommands() {
      return {
        test: "go test ./...",
        build: "go build ./...",
        lint: "golangci-lint run",
        syntaxCheck: "go vet ./...",
        typeCheck: "go vet ./...",
        install: ["go mod download"],
        start: "go run ./...",
        debug: "dlv debug ./...",
      };
    },
    detectFrameworks(rootDir) {
      const frameworks = [];
      try {
        const gomod = readFileSync(resolve(rootDir, "go.mod"), "utf8");
        if (gomod.includes("github.com/gin-gonic/gin")) frameworks.push("gin");
        if (gomod.includes("github.com/gofiber/fiber")) frameworks.push("fiber");
        if (gomod.includes("github.com/labstack/echo")) frameworks.push("echo");
        if (gomod.includes("github.com/gorilla/mux")) frameworks.push("gorilla");
      } catch {}
      return frameworks;
    },
  },
  {
    id: "rust",
    label: "Rust",
    markers: ["Cargo.toml"],
    detectPackageManager() { return "cargo"; },
    detectCommands() {
      return {
        test: "cargo test",
        build: "cargo build",
        lint: "cargo clippy -- -D warnings",
        syntaxCheck: "cargo check",
        typeCheck: "cargo check",
        install: [],
        start: "cargo run",
        debug: "rust-gdb target/debug/app",
      };
    },
    detectFrameworks(rootDir) {
      const frameworks = [];
      try {
        const cargo = readFileSync(resolve(rootDir, "Cargo.toml"), "utf8");
        if (cargo.includes("actix")) frameworks.push("actix");
        if (cargo.includes("axum")) frameworks.push("axum");
        if (cargo.includes("rocket")) frameworks.push("rocket");
        if (cargo.includes("tokio")) frameworks.push("tokio");
      } catch {}
      return frameworks;
    },
  },
  {
    id: "java",
    label: "Java",
    markers: ["pom.xml", "build.gradle", "build.gradle.kts"],
    detectPackageManager(rootDir) {
      if (existsSync(resolve(rootDir, "gradlew")) || existsSync(resolve(rootDir, "build.gradle")) || existsSync(resolve(rootDir, "build.gradle.kts"))) return "gradle";
      return "maven";
    },
    detectCommands(rootDir) {
      const pm = this.detectPackageManager(rootDir);
      const gradlew = existsSync(resolve(rootDir, "gradlew")) ? "./gradlew" : "gradle";
      if (pm === "gradle") {
        return {
          test: `${gradlew} test`,
          build: `${gradlew} build`,
          lint: `${gradlew} checkstyleMain`,
          syntaxCheck: `${gradlew} compileJava`,
          typeCheck: `${gradlew} compileJava`,
          install: [`${gradlew} dependencies`],
          start: `${gradlew} bootRun`,
          debug: `${gradlew} bootRun --debug-jvm`,
        };
      }
      return {
        test: "mvn test",
        build: "mvn package -DskipTests",
        lint: "mvn checkstyle:check",
        syntaxCheck: "mvn compile",
        typeCheck: "mvn compile",
        install: ["mvn dependency:resolve"],
        start: "mvn spring-boot:run",
        debug: "mvnDebug spring-boot:run",
      };
    },
    detectFrameworks(rootDir) {
      const frameworks = [];
      try {
        const content = existsSync(resolve(rootDir, "pom.xml"))
          ? readFileSync(resolve(rootDir, "pom.xml"), "utf8")
          : existsSync(resolve(rootDir, "build.gradle"))
            ? readFileSync(resolve(rootDir, "build.gradle"), "utf8")
            : "";
        if (/spring/i.test(content)) frameworks.push("spring");
        if (/quarkus/i.test(content)) frameworks.push("quarkus");
        if (/micronaut/i.test(content)) frameworks.push("micronaut");
      } catch {}
      return frameworks;
    },
  },
  {
    id: "dotnet",
    label: ".NET",
    markers: ["*.csproj", "*.fsproj", "*.sln"],
    detectPackageManager() { return "dotnet"; },
    detectCommands() {
      return {
        test: "dotnet test",
        build: "dotnet build",
        lint: "dotnet format --verify-no-changes",
        syntaxCheck: "dotnet build --no-restore",
        typeCheck: "dotnet build --no-restore",
        install: ["dotnet restore"],
        start: "dotnet run",
        debug: "dotnet run",
      };
    },
    detectFrameworks(rootDir) {
      const frameworks = [];
      try {
        const files = readdirSync(rootDir).filter(f => f.endsWith(".csproj") || f.endsWith(".fsproj"));
        for (const f of files) {
          const content = readFileSync(resolve(rootDir, f), "utf8");
          if (content.includes("Microsoft.AspNetCore") || content.includes("Microsoft.NET.Sdk.Web")) frameworks.push("aspnet");
          if (content.includes("Microsoft.Maui")) frameworks.push("maui");
        }
      } catch {}
      return frameworks;
    },
  },
  {
    id: "ruby",
    label: "Ruby",
    markers: ["Gemfile"],
    detectPackageManager() { return "bundler"; },
    detectCommands() {
      return {
        test: "bundle exec rspec",
        build: "bundle exec rake build",
        lint: "bundle exec rubocop",
        syntaxCheck: "ruby -c",
        typeCheck: "",
        install: ["bundle install"],
        start: "bundle exec rails server",
        debug: "ruby -rdebug app.rb",
      };
    },
    detectFrameworks(rootDir) {
      const frameworks = [];
      try {
        const gemfile = readFileSync(resolve(rootDir, "Gemfile"), "utf8");
        if (/\brails\b/i.test(gemfile)) frameworks.push("rails");
        if (/\bsinatra\b/i.test(gemfile)) frameworks.push("sinatra");
      } catch {}
      return frameworks;
    },
  },
  {
    id: "php",
    label: "PHP",
    markers: ["composer.json"],
    detectPackageManager() { return "composer"; },
    detectCommands() {
      return {
        test: "vendor/bin/phpunit",
        build: "composer install --no-dev",
        lint: "vendor/bin/phpcs",
        syntaxCheck: "php -l",
        typeCheck: "vendor/bin/phpstan analyse",
        install: ["composer install"],
        start: "php -S localhost:8000 -t public",
        debug: "php -dzend_extension=xdebug.so -S localhost:8000 -t public",
      };
    },
    detectFrameworks(rootDir) {
      const frameworks = [];
      try {
        const composer = JSON.parse(readFileSync(resolve(rootDir, "composer.json"), "utf8"));
        const deps = { ...composer.require, ...composer["require-dev"] };
        if (deps["laravel/framework"]) frameworks.push("laravel");
        if (deps["symfony/framework-bundle"]) frameworks.push("symfony");
      } catch {}
      return frameworks;
    },
  },
  {
    id: "make",
    label: "Makefile",
    markers: ["Makefile", "makefile", "GNUmakefile"],
    detectPackageManager() { return "make"; },
    detectCommands(rootDir) {
      const cmds = { test: "make test", build: "make", lint: "make lint", syntaxCheck: "make check", typeCheck: "",
        install: [], start: "make run", debug: "make debug" };
      try {
        // Try all known Makefile variants (case-sensitive filesystems may use different names)
        let mf = "";
        for (const name of ["Makefile", "makefile", "GNUmakefile"]) {
          try { mf = readFileSync(resolve(rootDir, name), "utf8"); break; } catch {}
        }
        if (mf) {
          if (!mf.includes("test:")) cmds.test = "";
          if (!mf.includes("lint:")) cmds.lint = "";
          if (!mf.includes("check:")) cmds.syntaxCheck = "";
        }
      } catch {}
      return cmds;
    },
    detectFrameworks() { return []; },
  },

  // ── C ────────────────────────────────────────────────────────────────────
  {
    id: "c",
    label: "C",
    markers: ["CMakeLists.txt", "Makefile", "makefile", "meson.build"],
    detectPackageManager(rootDir) {
      if (existsSync(resolve(rootDir, "CMakeLists.txt"))) return "cmake";
      if (existsSync(resolve(rootDir, "meson.build"))) return "meson";
      return "make";
    },
    detectCommands(rootDir) {
      const pm = this.detectPackageManager(rootDir);
      if (pm === "cmake") {
        return {
          test: "cd build && ctest --output-on-failure",
          build: "cmake --build build --config Release",
          lint: "clang-format --dry-run --Werror src/*.c",
          syntaxCheck: "cmake --build build",
          typeCheck: "",
          install: ["cmake -B build -DCMAKE_BUILD_TYPE=Debug", "cmake --build build"],
          start: "./build/app",
          debug: "gdb ./build/app",
        };
      }
      return {
        test: "make test",
        build: "make",
        lint: "make lint",
        syntaxCheck: "make",
        typeCheck: "",
        install: [],
        start: "./app",
        debug: "gdb ./app",
      };
    },
    detectFrameworks() { return []; },
  },

  // ── C++ ───────────────────────────────────────────────────────────────────
  {
    id: "cpp",
    label: "C++",
    markers: ["CMakeLists.txt", "Makefile", "makefile", "conanfile.txt", "vcpkg.json"],
    detectPackageManager(rootDir) {
      if (existsSync(resolve(rootDir, "CMakeLists.txt"))) return "cmake";
      if (existsSync(resolve(rootDir, "conanfile.txt")) || existsSync(resolve(rootDir, "conanfile.py"))) return "conan";
      if (existsSync(resolve(rootDir, "vcpkg.json"))) return "vcpkg";
      return "make";
    },
    detectCommands(rootDir) {
      const pm = this.detectPackageManager(rootDir);
      if (pm === "cmake") {
        return {
          test: "cd build && ctest --output-on-failure",
          build: "cmake --build build --config Release",
          lint: "clang-tidy -p build src/*.cpp",
          syntaxCheck: "cmake --build build",
          typeCheck: "",
          install: ["cmake -B build -DCMAKE_BUILD_TYPE=Debug", "cmake --build build"],
          start: "./build/app",
          debug: "gdb ./build/app",
        };
      }
      return {
        test: "make test",
        build: "make",
        lint: "make lint",
        syntaxCheck: "make",
        typeCheck: "",
        install: [],
        start: "./app",
        debug: "gdb ./app",
      };
    },
    detectFrameworks() { return []; },
  },

  // ── Swift ──────────────────────────────────────────────────────────────────
  {
    id: "swift",
    label: "Swift",
    markers: ["Package.swift"],
    detectPackageManager() { return "spm"; },
    detectCommands() {
      return {
        test: "swift test",
        build: "swift build -c release",
        lint: "swiftlint lint",
        syntaxCheck: "swift build",
        typeCheck: "swift build",
        install: ["swift package resolve"],
        start: "swift run",
        debug: "lldb .build/debug/app",
      };
    },
    detectFrameworks() { return []; },
  },

  // ── Kotlin ────────────────────────────────────────────────────────────────
  {
    id: "kotlin",
    label: "Kotlin",
    markers: ["build.gradle.kts", "settings.gradle.kts"],
    detectPackageManager(rootDir) {
      return existsSync(resolve(rootDir, "gradlew")) ? "gradle" : "gradle";
    },
    detectCommands(rootDir) {
      const gradlew = existsSync(resolve(rootDir, "gradlew")) ? "./gradlew" : "gradle";
      return {
        test: `${gradlew} test`,
        build: `${gradlew} build -x test`,
        lint: `${gradlew} ktlintCheck`,
        syntaxCheck: `${gradlew} compileKotlin`,
        typeCheck: `${gradlew} compileKotlin`,
        install: [`${gradlew} dependencies`],
        start: `${gradlew} run`,
        debug: `${gradlew} run --debug-jvm`,
      };
    },
    detectFrameworks() { return []; },
  },

  // ── Dart / Flutter ────────────────────────────────────────────────────────
  {
    id: "dart",
    label: "Dart / Flutter",
    markers: ["pubspec.yaml"],
    detectPackageManager(rootDir) {
      try {
        const pubspec = readFileSync(resolve(rootDir, "pubspec.yaml"), "utf8");
        if (pubspec.includes("flutter:")) return "flutter";
      } catch {}
      return "dart";
    },
    detectCommands(rootDir) {
      const pm = this.detectPackageManager(rootDir);
      if (pm === "flutter") {
        return {
          test: "flutter test",
          build: "flutter build apk",
          lint: "flutter analyze",
          syntaxCheck: "flutter analyze",
          typeCheck: "flutter analyze",
          install: ["flutter pub get"],
          start: "flutter run",
          debug: "flutter run --debug",
        };
      }
      return {
        test: "dart test",
        build: "dart compile exe bin/main.dart",
        lint: "dart analyze",
        syntaxCheck: "dart analyze",
        typeCheck: "dart analyze",
        install: ["dart pub get"],
        start: "dart run",
        debug: "dart --enable-vm-service run",
      };
    },
    detectFrameworks() { return []; },
  },

  // ── Elixir ────────────────────────────────────────────────────────────────
  {
    id: "elixir",
    label: "Elixir",
    markers: ["mix.exs"],
    detectPackageManager() { return "mix"; },
    detectCommands(rootDir) {
      const isPhoenix = existsSync(resolve(rootDir, "config", "config.exs")) &&
        (() => {
          try { return readFileSync(resolve(rootDir, "mix.exs"), "utf8").includes("phoenix"); } catch { return false; }
        })();
      return {
        test: "mix test",
        build: "mix compile",
        lint: "mix credo --strict",
        syntaxCheck: "mix compile",
        typeCheck: "mix dialyzer",
        install: ["mix deps.get", "mix compile"],
        start: isPhoenix ? "mix phx.server" : "mix run",
        debug: "iex -S mix",
      };
    },
    detectFrameworks(rootDir) {
      try {
        const mix = readFileSync(resolve(rootDir, "mix.exs"), "utf8");
        if (mix.includes("phoenix")) return ["phoenix"];
        if (mix.includes("nerves")) return ["nerves"];
      } catch {}
      return [];
    },
  },

  // ── Zig ───────────────────────────────────────────────────────────────────
  {
    id: "zig",
    label: "Zig",
    markers: ["build.zig", "build.zig.zon"],
    detectPackageManager() { return "zig"; },
    detectCommands() {
      return {
        test: "zig build test",
        build: "zig build -Doptimize=ReleaseFast",
        lint: "zig fmt --check src/",
        syntaxCheck: "zig build",
        typeCheck: "zig build",
        install: [],
        start: "zig build run",
        debug: "zig build run",
      };
    },
    detectFrameworks() { return []; },
  },

  // ── Haskell ───────────────────────────────────────────────────────────────
  {
    id: "haskell",
    label: "Haskell",
    markers: ["stack.yaml", "cabal.project", "*.cabal"],
    detectPackageManager(rootDir) {
      return existsSync(resolve(rootDir, "stack.yaml")) ? "stack" : "cabal";
    },
    detectCommands(rootDir) {
      const pm = this.detectPackageManager(rootDir);
      if (pm === "stack") {
        return {
          test: "stack test",
          build: "stack build",
          lint: "hlint src",
          syntaxCheck: "stack build",
          typeCheck: "stack build",
          install: ["stack setup", "stack build --only-dependencies"],
          start: "stack run",
          debug: "stack ghci",
        };
      }
      return {
        test: "cabal test",
        build: "cabal build",
        lint: "hlint src",
        syntaxCheck: "cabal build",
        typeCheck: "cabal build",
        install: ["cabal update", "cabal install --only-dependencies"],
        start: "cabal run",
        debug: "cabal repl",
      };
    },
    detectFrameworks() { return []; },
  },

  // ── R ─────────────────────────────────────────────────────────────────────
  {
    id: "r",
    label: "R",
    markers: ["DESCRIPTION", "renv.lock", ".Rprofile"],
    detectPackageManager(rootDir) {
      return existsSync(resolve(rootDir, "renv.lock")) ? "renv" : "r";
    },
    detectCommands(rootDir) {
      const pm = this.detectPackageManager(rootDir);
      return {
        test: "Rscript -e 'testthat::test_dir(\"tests\")'",
        build: "R CMD INSTALL .",
        lint: "Rscript -e 'lintr::lint_dir(\".\")'",
        syntaxCheck: "R CMD check --no-tests .",
        typeCheck: "",
        install: pm === "renv" ? ["Rscript -e 'renv::restore()'"] : ["Rscript -e 'install.packages(\".\", dependencies=TRUE)'"],
        start: "Rscript app.R",
        debug: "Rscript -e 'source(\"app.R\")'",
      };
    },
    detectFrameworks() { return []; },
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function readPackageJsonScripts(rootDir) {
  try {
    const pkg = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));
    return pkg.scripts || {};
  } catch { return {}; }
}

function readPackageJsonDeps(rootDir) {
  try {
    const pkg = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));
    return new Set([
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.devDependencies || {}),
      ...Object.keys(pkg.peerDependencies || {}),
    ]);
  } catch { return new Set(); }
}

function readAllPythonDeps(rootDir) {
  const parts = [];
  for (const f of ["requirements.txt", "requirements-dev.txt", "requirements_dev.txt", "pyproject.toml", "setup.py", "Pipfile"]) {
    try { parts.push(readFileSync(resolve(rootDir, f), "utf8")); } catch {}
  }
  return parts.join("\n");
}

function markerExists(rootDir, marker) {
  if (marker.includes("*")) {
    // Glob-style: *.csproj, *.sln etc.
    try {
      const ext = marker.replace(/\*/g, "");
      return readdirSync(rootDir).some(f => f.endsWith(ext));
    } catch { return false; }
  }
  return existsSync(resolve(rootDir, marker));
}

function buildPackageScriptCommand(packageManager, scriptName) {
  const pm = String(packageManager || "npm").trim().toLowerCase();
  if (pm === "yarn") return `yarn ${scriptName}`;
  if (pm === "pnpm") return `pnpm ${scriptName}`;
  if (pm === "bun") return `bun run ${scriptName}`;
  return `npm run ${scriptName}`;
}

function readMakefile(rootDir) {
  for (const name of ["Makefile", "makefile", "GNUmakefile"]) {
    try {
      return readFileSync(resolve(rootDir, name), "utf8");
    } catch {}
  }
  return "";
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findMakeTarget(rootDir, targetNames = []) {
  const makefile = readMakefile(rootDir);
  if (!makefile) return "";
  for (const name of targetNames) {
    const pattern = new RegExp(`^${escapeRegExp(name)}\\s*:`, "m");
    if (pattern.test(makefile)) return name;
  }
  return "";
}

function detectQualityGateCommand(rootDir, commands = {}, options = {}) {
  const packageManager = String(options.packageManager || "").trim().toLowerCase();
  const scripts = readPackageJsonScripts(rootDir);
  for (const scriptName of ["prepush:check", "prepush-check", "prepush", "pre-push", "verify", "validate", "check"]) {
    if (typeof scripts[scriptName] === "string" && scripts[scriptName].trim()) {
      return buildPackageScriptCommand(packageManager, scriptName);
    }
  }

  if (existsSync(resolve(rootDir, ".githooks", "pre-push"))) {
    return "bash .githooks/pre-push";
  }

  const makeTarget = findMakeTarget(rootDir, ["prepush", "pre-push", "verify", "validate", "check"]);
  if (makeTarget) {
    return `make ${makeTarget}`;
  }

  return commands.test || commands.lint || commands.build || commands.syntaxCheck || "";
}

function detectPostEditCommand(rootDir, commands = {}, options = {}) {
  const packageManager = String(options.packageManager || "").trim().toLowerCase();
  const scripts = readPackageJsonScripts(rootDir);
  for (const scriptName of [
    "postedit:check",
    "post-edit:check",
    "check:quick",
    "quick:check",
    "check:fast",
    "lint:quick",
    "format:check",
    "lint",
    "syntax:check",
    "check",
  ]) {
    if (typeof scripts[scriptName] === "string" && scripts[scriptName].trim()) {
      return buildPackageScriptCommand(packageManager, scriptName);
    }
  }

  const makeTarget = findMakeTarget(rootDir, [
    "postedit-check",
    "post-edit-check",
    "check-quick",
    "quick-check",
    "format-check",
    "lint",
    "check",
  ]);
  if (makeTarget) {
    return `make ${makeTarget}`;
  }

  return commands.lint || commands.syntaxCheck || "";
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect the project stack(s) at the given root directory.
 *
 * @param {string} rootDir - Absolute path to the project root
 * @returns {ProjectDetectionResult}
 *
 * @typedef {object} ProjectDetectionResult
 * @property {DetectedStack[]} stacks    - All detected stacks (may be >1 for monorepos)
 * @property {DetectedStack|null} primary - The primary/first detected stack
 * @property {CommandMap} commands       - Merged command map (primary stack wins)
 * @property {string[]} frameworks       - All detected frameworks
 * @property {boolean} isMonorepo        - True if multiple stacks detected
 *
 * @typedef {object} DetectedStack
 * @property {string} id             - Stack ID (e.g. "node", "python")
 * @property {string} label          - Human-readable label
 * @property {string} packageManager - Detected package manager
 * @property {CommandMap} commands    - Commands for this stack
 * @property {string[]} frameworks   - Detected frameworks
 *
 * @typedef {object} CommandMap
 * @property {string}   test          - Test command
 * @property {string}   build         - Build command
 * @property {string}   lint          - Lint command
 * @property {string}   syntaxCheck   - Syntax/compile check command
 * @property {string}   [typeCheck]   - Type-check command
 * @property {string}   [qualityGate] - Pre-push / pre-PR validation command
 * @property {string}   [postEdit]    - Quick validation command to run after edits
 * @property {string}   [testFramework] - Detected test framework name
 * @property {string[]} [install]     - Dependency install commands (ordered)
 * @property {string}   [start]       - Dev-server / process start command
 * @property {string}   [debug]       - Debug session launch command
 */
export function detectProjectStack(rootDir) {
  if (!rootDir || !existsSync(rootDir)) {
    return { stacks: [], primary: null, commands: emptyCommands(), frameworks: [], isMonorepo: false };
  }

  const stacks = [];
  for (const def of STACK_DEFINITIONS) {
    const hasMarker = def.markers.some(m => markerExists(rootDir, m));
    if (!hasMarker) continue;

    const pm = def.detectPackageManager(rootDir);
    const commands = def.detectCommands(rootDir);
    commands.qualityGate = detectQualityGateCommand(rootDir, commands, { packageManager: pm });
    commands.postEdit = detectPostEditCommand(rootDir, commands, { packageManager: pm });
    const frameworks = def.detectFrameworks(rootDir);
    stacks.push({
      id: def.id,
      label: def.label,
      packageManager: pm,
      commands,
      frameworks,
    });
  }

  const primary = stacks[0] || null;
  const commands = primary?.commands || emptyCommands();
  const allFrameworks = stacks.flatMap(s => s.frameworks);

  return {
    stacks,
    primary,
    commands,
    frameworks: [...new Set(allFrameworks)],
    isMonorepo: stacks.length > 1,
  };
}

/**
 * Get command presets for all supported stacks (for UI dropdowns).
 * Returns a list of { label, value } options for each command type.
 *
 * @param {ProjectDetectionResult} [detected] - Optional detected stack to put first
 * @returns {CommandPresets}
 */
export function getCommandPresets(detected) {
  const presets = {
    install: [],
    start: [],
    test: [],
    build: [],
    lint: [],
    syntaxCheck: [],
    qualityGate: [],
    debug: [],
  };

  // If we have a detected stack, put its commands first as "Detected" options
  if (detected?.primary) {
    const cmds = detected.primary.commands;
    const label = `${detected.primary.label} (detected)`;
    if (cmds.install?.length) presets.install.push({ label: `${label}: ${cmds.install[0]}`, value: cmds.install.join(" && "), detected: true });
    if (cmds.start) presets.start.push({ label: `${label}: ${cmds.start}`, value: cmds.start, detected: true });
    if (cmds.test) presets.test.push({ label: `${label}: ${cmds.test}`, value: cmds.test, detected: true });
    if (cmds.build) presets.build.push({ label: `${label}: ${cmds.build}`, value: cmds.build, detected: true });
    if (cmds.lint) presets.lint.push({ label: `${label}: ${cmds.lint}`, value: cmds.lint, detected: true });
    if (cmds.syntaxCheck) presets.syntaxCheck.push({ label: `${label}: ${cmds.syntaxCheck}`, value: cmds.syntaxCheck, detected: true });
    if (cmds.qualityGate) presets.qualityGate.push({ label: `${label}: ${cmds.qualityGate}`, value: cmds.qualityGate, detected: true });
    if (cmds.debug) presets.debug.push({ label: `${label}: ${cmds.debug}`, value: cmds.debug, detected: true });
  }

  // Add additional detected stacks (monorepo)
  if (detected?.stacks?.length > 1) {
    for (const stack of detected.stacks.slice(1)) {
      const cmds = stack.commands;
      const label = `${stack.label} (detected)`;
      if (cmds.install?.length) presets.install.push({ label: `${label}: ${cmds.install[0]}`, value: cmds.install.join(" && "), detected: true });
      if (cmds.start) presets.start.push({ label: `${label}: ${cmds.start}`, value: cmds.start, detected: true });
      if (cmds.test) presets.test.push({ label: `${label}: ${cmds.test}`, value: cmds.test, detected: true });
      if (cmds.build) presets.build.push({ label: `${label}: ${cmds.build}`, value: cmds.build, detected: true });
      if (cmds.lint) presets.lint.push({ label: `${label}: ${cmds.lint}`, value: cmds.lint, detected: true });
      if (cmds.syntaxCheck) presets.syntaxCheck.push({ label: `${label}: ${cmds.syntaxCheck}`, value: cmds.syntaxCheck, detected: true });
      if (cmds.qualityGate) presets.qualityGate.push({ label: `${label}: ${cmds.qualityGate}`, value: cmds.qualityGate, detected: true });
    }
  }

  // Add universal presets from all known stacks
  const universalPresets = {
    install: [
      { label: "Node.js — npm install", value: "npm install" },
      { label: "Node.js — yarn install", value: "yarn install" },
      { label: "Node.js — pnpm install", value: "pnpm install" },
      { label: "Python — pip install -r requirements.txt", value: "pip install -r requirements.txt" },
      { label: "Python — poetry install", value: "poetry install" },
      { label: "Python — uv sync", value: "uv sync" },
      { label: "Go — go mod download", value: "go mod download" },
      { label: "Rust — (no install needed)", value: "" },
      { label: "Java/Maven — mvn dependency:resolve", value: "mvn dependency:resolve" },
      { label: "Java/Gradle — ./gradlew dependencies", value: "./gradlew dependencies" },
      { label: ".NET — dotnet restore", value: "dotnet restore" },
      { label: "Ruby — bundle install", value: "bundle install" },
      { label: "PHP — composer install", value: "composer install" },
      { label: "Swift — swift package resolve", value: "swift package resolve" },
      { label: "Dart/Flutter — flutter pub get", value: "flutter pub get" },
      { label: "Elixir — mix deps.get", value: "mix deps.get" },
    ],
    start: [
      { label: "Node.js — npm start", value: "npm start" },
      { label: "Node.js — npm run dev", value: "npm run dev" },
      { label: "Python — python -m app", value: "python -m app" },
      { label: "Python — uvicorn main:app --reload", value: "uvicorn main:app --reload" },
      { label: "Django — python manage.py runserver", value: "python manage.py runserver" },
      { label: "Go — go run ./...", value: "go run ./..." },
      { label: "Rust — cargo run", value: "cargo run" },
      { label: "Java/Spring — mvn spring-boot:run", value: "mvn spring-boot:run" },
      { label: "Java/Gradle — ./gradlew bootRun", value: "./gradlew bootRun" },
      { label: ".NET — dotnet run", value: "dotnet run" },
      { label: "Ruby/Rails — bin/rails server", value: "bin/rails server" },
      { label: "PHP — php -S localhost:8000", value: "php -S localhost:8000 -t public" },
      { label: "Swift — swift run", value: "swift run" },
      { label: "Elixir/Phoenix — mix phx.server", value: "mix phx.server" },
      { label: "Flutter — flutter run", value: "flutter run" },
    ],
    debug: [
      { label: "Node.js — node --inspect", value: "node --inspect index.js" },
      { label: "Node.js — node --inspect-brk", value: "node --inspect-brk index.js" },
      { label: "Python — debugpy", value: "python -m debugpy --listen 5678 -m app" },
      { label: "Go — dlv debug", value: "dlv debug ./..." },
      { label: "Rust — rust-gdb", value: "rust-gdb target/debug/app" },
      { label: "Java — remote debug port 5005", value: "./gradlew bootRun --debug-jvm" },
      { label: ".NET — dotnet run", value: "dotnet run" },
      { label: "C/C++ — gdb", value: "gdb ./build/app" },
      { label: "Swift — lldb", value: "lldb .build/debug/app" },
      { label: "Elixir — iex -S mix", value: "iex -S mix" },
    ],
    test: [
      { label: "Node.js — npm test", value: "npm test" },
      { label: "Node.js — yarn test", value: "yarn test" },
      { label: "Node.js — pnpm test", value: "pnpm test" },
      { label: "Python — pytest", value: "pytest" },
      { label: "Python — poetry run pytest", value: "poetry run pytest" },
      { label: "Python — python -m pytest", value: "python -m pytest" },
      { label: "Go — go test ./...", value: "go test ./..." },
      { label: "Rust — cargo test", value: "cargo test" },
      { label: "Java/Maven — mvn test", value: "mvn test" },
      { label: "Java/Gradle — ./gradlew test", value: "./gradlew test" },
      { label: ".NET — dotnet test", value: "dotnet test" },
      { label: "Ruby — bundle exec rspec", value: "bundle exec rspec" },
      { label: "PHP — vendor/bin/phpunit", value: "vendor/bin/phpunit" },
      { label: "Make — make test", value: "make test" },
      { label: "Swift — swift test", value: "swift test" },
      { label: "Kotlin/Gradle — ./gradlew test", value: "./gradlew test" },
      { label: "Dart — dart test", value: "dart test" },
      { label: "Flutter — flutter test", value: "flutter test" },
      { label: "Elixir — mix test", value: "mix test" },
      { label: "Zig — zig build test", value: "zig build test" },
      { label: "Haskell/Stack — stack test", value: "stack test" },
      { label: "R — Rscript testthat", value: "Rscript -e 'testthat::test_dir(\"tests\")'" },
    ],
    build: [
      { label: "Node.js — npm run build", value: "npm run build" },
      { label: "Node.js — yarn build", value: "yarn build" },
      { label: "Node.js — pnpm build", value: "pnpm build" },
      { label: "Python — python -m build", value: "python -m build" },
      { label: "Python — poetry build", value: "poetry build" },
      { label: "Go — go build ./...", value: "go build ./..." },
      { label: "Rust — cargo build", value: "cargo build" },
      { label: "Rust — cargo build --release", value: "cargo build --release" },
      { label: "Java/Maven — mvn package -DskipTests", value: "mvn package -DskipTests" },
      { label: "Java/Gradle — ./gradlew build", value: "./gradlew build" },
      { label: ".NET — dotnet build", value: "dotnet build" },
      { label: "Ruby — bundle exec rake build", value: "bundle exec rake build" },
      { label: "PHP — composer install --no-dev", value: "composer install --no-dev" },
      { label: "C++/CMake — cmake --build build", value: "cmake --build build --config Release" },
      { label: "C++/Make — make", value: "make" },
      { label: "Swift — swift build", value: "swift build -c release" },
      { label: "Zig — zig build", value: "zig build -Doptimize=ReleaseFast" },
      { label: "Make — make", value: "make" },
    ],
    lint: [
      { label: "Node.js — npm run lint", value: "npm run lint" },
      { label: "Node.js — npx eslint .", value: "npx eslint ." },
      { label: "Python — ruff check .", value: "ruff check ." },
      { label: "Python — flake8", value: "flake8" },
      { label: "Python — pylint", value: "pylint" },
      { label: "Go — golangci-lint run", value: "golangci-lint run" },
      { label: "Rust — cargo clippy -- -D warnings", value: "cargo clippy -- -D warnings" },
      { label: "Java — mvn checkstyle:check", value: "mvn checkstyle:check" },
      { label: ".NET — dotnet format --verify-no-changes", value: "dotnet format --verify-no-changes" },
      { label: "Ruby — bundle exec rubocop", value: "bundle exec rubocop" },
      { label: "PHP — vendor/bin/phpcs", value: "vendor/bin/phpcs" },
      { label: "Swift — swiftlint lint", value: "swiftlint lint" },
      { label: "Kotlin — ./gradlew ktlintCheck", value: "./gradlew ktlintCheck" },
      { label: "Elixir — mix credo --strict", value: "mix credo --strict" },
      { label: "Zig — zig fmt --check src/", value: "zig fmt --check src/" },
      { label: "Make — make lint", value: "make lint" },
    ],
    syntaxCheck: [
      { label: "Node.js — node --check", value: "node --check" },
      { label: "Node.js — npx tsc --noEmit", value: "npx tsc --noEmit" },
      { label: "Python — python -m py_compile", value: "python -m py_compile" },
      { label: "Go — go vet ./...", value: "go vet ./..." },
      { label: "Rust — cargo check", value: "cargo check" },
      { label: "Java/Maven — mvn compile", value: "mvn compile" },
      { label: "Java/Gradle — ./gradlew compileJava", value: "./gradlew compileJava" },
      { label: ".NET — dotnet build --no-restore", value: "dotnet build --no-restore" },
      { label: "Ruby — ruby -c", value: "ruby -c" },
      { label: "PHP — php -l", value: "php -l" },
      { label: "Swift — swift build", value: "swift build" },
      { label: "Elixir — mix compile", value: "mix compile" },
      { label: "Zig — zig build", value: "zig build" },
    ],
    qualityGate: [
      { label: "Node.js — npm run prepush:check", value: "npm run prepush:check" },
      { label: "Node.js — pnpm prepush:check", value: "pnpm prepush:check" },
      { label: "Repository hook — bash .githooks/pre-push", value: "bash .githooks/pre-push" },
      { label: "Go — go test ./...", value: "go test ./..." },
      { label: "Make — make test", value: "make test" },
    ],
  };

  // Merge: skip any universal presets whose value already appears in detected
  for (const key of Object.keys(presets)) {
    const existingValues = new Set(presets[key].map(p => p.value));
    for (const preset of universalPresets[key] || []) {
      if (!existingValues.has(preset.value)) {
        presets[key].push(preset);
      }
    }
  }

  return presets;
}

/**
 * Resolve an "auto" command placeholder to the detected command.
 * If the value isn't "auto", returns it unchanged.
 *
 * @param {string|string[]} value - The command value (may be "auto" or an actual command/array)
 * @param {string} commandType - One of "test", "build", "lint", "syntaxCheck", "qualityGate", "install", "start", "debug"
 * @param {string} rootDir - Project root for detection
 * @returns {string|string[]} The resolved command or array of commands
 */
export function resolveAutoCommand(value, commandType, rootDir) {
  const isArrayType = commandType === "install";
  const str = Array.isArray(value) ? value.join(" && ") : String(value || "");
  if (!str || str.toLowerCase().trim() !== "auto") return value;
  const detected = detectProjectStack(rootDir);
  const resolved = detected.commands?.[commandType];
  if (!resolved) return isArrayType ? [] : "";
  if (isArrayType) return Array.isArray(resolved) ? resolved : [resolved];
  return Array.isArray(resolved) ? resolved.join(" && ") : resolved;
}

function emptyCommands() {
  return { test: "", build: "", lint: "", syntaxCheck: "", typeCheck: "", qualityGate: "",
    install: [], start: "", debug: "" };
}

// Re-export the stack definitions for introspection
export { STACK_DEFINITIONS };
