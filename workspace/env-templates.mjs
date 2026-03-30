/**
 * env-templates.mjs — Project environment templates for Bosun.
 *
 * Provides 25+ project type templates with pre-populated install, build, test,
 * lint, start, debug, and worktree-setup commands.  Detection is purely
 * file-system based — no LLMs required.
 *
 * Used by:
 *  - "Configure Environment" UI (template picker + auto-detect)
 *  - Worktree bootstrap command resolution
 *  - Server-side /api/env/detect endpoint
 */

import { existsSync, readdirSync } from "node:fs";
import { resolve, extname, basename } from "node:path";

// ── Template Registry ─────────────────────────────────────────────────────────

/**
 * @typedef {object} EnvTemplate
 * @property {string}   id                    - Unique template identifier
 * @property {string}   label                 - Human-readable name
 * @property {string}   description           - One-line description
 * @property {string}   icon                  - Emoji icon
 * @property {string}   group                 - Category group (e.g. "JavaScript", "Systems")
 * @property {string[]} markers               - Files/dirs where ANY match triggers detection
 * @property {string[]} [strictMarkers]       - Files where ALL must be present (AND logic)
 * @property {string[]} [extensionMarkers]    - File extensions that trigger detection (e.g. ".cs")
 * @property {string[]} installCommands       - Ordered commands to install dependencies
 * @property {string}   startCommand          - Command to start the dev server / main process
 * @property {string}   buildCommand          - Command to produce build artifacts
 * @property {string}   testCommand           - Command to run the test suite
 * @property {string}   lintCommand           - Command to lint/style-check the codebase
 * @property {string}   debugCommand          - Command to start a debug session
 * @property {string[]} worktreeSetupCommands - Extra commands run once per new worktree
 * @property {string[]} sharedPaths           - Relative paths to symlink from repo root into worktrees
 * @property {number}   [priority]            - Detection priority (higher = checked first); default 0
 */

/** @type {EnvTemplate[]} */
export const ENV_TEMPLATES = [
  // ── JavaScript / TypeScript ──────────────────────────────────────────────

  {
    id: "node-ts",
    label: "TypeScript / Node.js",
    description: "TypeScript project using Node.js runtime",
    icon: "🔷",
    group: "JavaScript",
    markers: ["tsconfig.json"],
    strictMarkers: ["package.json", "tsconfig.json"],
    installCommands: ["npm install"],
    startCommand: "npm run dev",
    buildCommand: "npm run build",
    testCommand: "npm test",
    lintCommand: "npx tsc --noEmit && npx eslint .",
    debugCommand: "node --inspect -r ts-node/register src/index.ts",
    worktreeSetupCommands: [],
    sharedPaths: ["node_modules"],
    priority: 20,
  },
  {
    id: "node-esm",
    label: "JavaScript / ESM (Node.js)",
    description: "Modern ECMAScript modules project",
    icon: "🟨",
    group: "JavaScript",
    markers: ["package.json"],
    installCommands: ["npm install"],
    startCommand: "npm start",
    buildCommand: "npm run build",
    testCommand: "npm test",
    lintCommand: "npx eslint .",
    debugCommand: "node --inspect index.mjs",
    worktreeSetupCommands: [],
    sharedPaths: ["node_modules"],
    priority: 5,
  },
  {
    id: "react-ts",
    label: "React / TypeScript",
    description: "React SPA with TypeScript (Vite, CRA, or similar)",
    icon: "⚛️",
    group: "JavaScript",
    markers: ["package.json"],
    strictMarkers: ["package.json", "tsconfig.json"],
    installCommands: ["npm install"],
    startCommand: "npm run dev",
    buildCommand: "npm run build",
    testCommand: "npm test",
    lintCommand: "npx tsc --noEmit && npx eslint src",
    debugCommand: "npm run dev",
    worktreeSetupCommands: [],
    sharedPaths: ["node_modules"],
    priority: 25,
  },
  {
    id: "nextjs",
    label: "Next.js",
    description: "React framework with SSR/SSG (Next.js)",
    icon: "▲",
    group: "JavaScript",
    markers: ["next.config.js", "next.config.mjs", "next.config.ts"],
    installCommands: ["npm install"],
    startCommand: "npm run dev",
    buildCommand: "npm run build",
    testCommand: "npm test",
    lintCommand: "next lint",
    debugCommand: "npm run dev",
    worktreeSetupCommands: [],
    sharedPaths: ["node_modules", ".next/cache"],
    priority: 30,
  },
  {
    id: "vue",
    label: "Vue.js",
    description: "Vue.js single-page application",
    icon: "💚",
    group: "JavaScript",
    markers: ["vue.config.js", "vue.config.ts", "vite.config.js", "vite.config.ts"],
    installCommands: ["npm install"],
    startCommand: "npm run dev",
    buildCommand: "npm run build",
    testCommand: "npm test",
    lintCommand: "npx eslint src",
    debugCommand: "npm run dev",
    worktreeSetupCommands: [],
    sharedPaths: ["node_modules"],
    priority: 18,
  },

  // ── Python ───────────────────────────────────────────────────────────────

  {
    id: "python-poetry",
    label: "Python / Poetry",
    description: "Python project managed with Poetry",
    icon: "🐍",
    group: "Python",
    markers: ["poetry.lock"],
    strictMarkers: ["pyproject.toml", "poetry.lock"],
    installCommands: ["poetry install"],
    startCommand: "poetry run python -m app",
    buildCommand: "poetry build",
    testCommand: "poetry run pytest",
    lintCommand: "poetry run ruff check .",
    debugCommand: "poetry run python -m debugpy --listen 5678 -m app",
    worktreeSetupCommands: [],
    sharedPaths: [],
    priority: 25,
  },
  {
    id: "python-uv",
    label: "Python / uv",
    description: "Python project managed with uv (fast package manager)",
    icon: "🐍",
    group: "Python",
    markers: ["uv.lock"],
    installCommands: ["uv sync"],
    startCommand: "uv run python -m app",
    buildCommand: "uv build",
    testCommand: "uv run pytest",
    lintCommand: "uv run ruff check .",
    debugCommand: "uv run python -m debugpy --listen 5678 -m app",
    worktreeSetupCommands: [],
    sharedPaths: [],
    priority: 28,
  },
  {
    id: "python-pip",
    label: "Python / pip",
    description: "Python project using pip and requirements.txt",
    icon: "🐍",
    group: "Python",
    markers: ["requirements.txt", "setup.py", "setup.cfg", "Pipfile"],
    installCommands: ["pip install -r requirements.txt"],
    startCommand: "python -m app",
    buildCommand: "python -m build",
    testCommand: "pytest",
    lintCommand: "ruff check .",
    debugCommand: "python -m debugpy --listen 5678 -m app",
    worktreeSetupCommands: ["python -m venv .venv", ".venv/bin/pip install -r requirements.txt"],
    sharedPaths: [],
    priority: 5,
  },
  {
    id: "python-django",
    label: "Django",
    description: "Django web framework project",
    icon: "🟩",
    group: "Python",
    markers: ["manage.py"],
    installCommands: ["pip install -r requirements.txt"],
    startCommand: "python manage.py runserver",
    buildCommand: "python manage.py collectstatic --noinput",
    testCommand: "python manage.py test",
    lintCommand: "ruff check .",
    debugCommand: "python -m debugpy --listen 5678 manage.py runserver --noreload",
    worktreeSetupCommands: ["python manage.py migrate --run-syncdb"],
    sharedPaths: [],
    priority: 30,
  },
  {
    id: "python-fastapi",
    label: "FastAPI",
    description: "FastAPI async web framework",
    icon: "⚡",
    group: "Python",
    markers: ["main.py"],
    strictMarkers: ["main.py", "requirements.txt"],
    installCommands: ["pip install -r requirements.txt"],
    startCommand: "uvicorn main:app --reload",
    buildCommand: "",
    testCommand: "pytest",
    lintCommand: "ruff check .",
    debugCommand: "python -m debugpy --listen 5678 -m uvicorn main:app --reload",
    worktreeSetupCommands: [],
    sharedPaths: [],
    priority: 15,
  },

  // ── Go ───────────────────────────────────────────────────────────────────

  {
    id: "go",
    label: "Go",
    description: "Go module project",
    icon: "🐹",
    group: "Systems",
    markers: ["go.mod"],
    installCommands: ["go mod download"],
    startCommand: "go run ./...",
    buildCommand: "go build ./...",
    testCommand: "go test ./...",
    lintCommand: "golangci-lint run",
    debugCommand: "dlv debug ./...",
    worktreeSetupCommands: [],
    sharedPaths: [],
    priority: 10,
  },

  // ── Rust ─────────────────────────────────────────────────────────────────

  {
    id: "rust",
    label: "Rust / Cargo",
    description: "Rust project managed with Cargo",
    icon: "🦀",
    group: "Systems",
    markers: ["Cargo.toml"],
    installCommands: [],
    startCommand: "cargo run",
    buildCommand: "cargo build --release",
    testCommand: "cargo test",
    lintCommand: "cargo clippy -- -D warnings",
    debugCommand: "rust-gdb target/debug/app",
    worktreeSetupCommands: [],
    sharedPaths: ["target"],
    priority: 10,
  },

  // ── Java / JVM ────────────────────────────────────────────────────────────

  {
    id: "java-maven",
    label: "Java / Maven",
    description: "Java project built with Apache Maven",
    icon: "☕",
    group: "JVM",
    markers: ["pom.xml"],
    installCommands: ["mvn dependency:resolve"],
    startCommand: "mvn spring-boot:run",
    buildCommand: "mvn package -DskipTests",
    testCommand: "mvn test",
    lintCommand: "mvn checkstyle:check",
    debugCommand: "mvnDebug spring-boot:run",
    worktreeSetupCommands: [],
    sharedPaths: [],
    priority: 10,
  },
  {
    id: "java-gradle",
    label: "Java / Gradle",
    description: "Java project built with Gradle",
    icon: "☕",
    group: "JVM",
    markers: ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
    installCommands: ["./gradlew dependencies"],
    startCommand: "./gradlew bootRun",
    buildCommand: "./gradlew build -x test",
    testCommand: "./gradlew test",
    lintCommand: "./gradlew checkstyleMain",
    debugCommand: "./gradlew bootRun --debug-jvm",
    worktreeSetupCommands: [],
    sharedPaths: [".gradle"],
    priority: 10,
  },
  {
    id: "kotlin-gradle",
    label: "Kotlin / Gradle",
    description: "Kotlin project built with Gradle",
    icon: "🟣",
    group: "JVM",
    markers: ["build.gradle.kts"],
    extensionMarkers: [".kt"],
    installCommands: ["./gradlew dependencies"],
    startCommand: "./gradlew run",
    buildCommand: "./gradlew build -x test",
    testCommand: "./gradlew test",
    lintCommand: "./gradlew ktlintCheck",
    debugCommand: "./gradlew run --debug-jvm",
    worktreeSetupCommands: [],
    sharedPaths: [".gradle"],
    priority: 15,
  },

  // ── .NET ─────────────────────────────────────────────────────────────────

  {
    id: "dotnet-csharp",
    label: "C# / .NET",
    description: "C# project using the .NET SDK",
    icon: "🟦",
    group: ".NET",
    markers: [],
    extensionMarkers: [".csproj", ".sln"],
    installCommands: ["dotnet restore"],
    startCommand: "dotnet run",
    buildCommand: "dotnet build",
    testCommand: "dotnet test",
    lintCommand: "dotnet format --verify-no-changes",
    debugCommand: "dotnet run",
    worktreeSetupCommands: [],
    sharedPaths: [],
    priority: 10,
  },
  {
    id: "dotnet-fsharp",
    label: "F# / .NET",
    description: "F# project using the .NET SDK",
    icon: "🔵",
    group: ".NET",
    markers: [],
    extensionMarkers: [".fsproj"],
    installCommands: ["dotnet restore"],
    startCommand: "dotnet run",
    buildCommand: "dotnet build",
    testCommand: "dotnet test",
    lintCommand: "dotnet format --verify-no-changes",
    debugCommand: "dotnet run",
    worktreeSetupCommands: [],
    sharedPaths: [],
    priority: 15,
  },

  // ── C / C++ ───────────────────────────────────────────────────────────────

  {
    id: "cpp-cmake",
    label: "C++ / CMake",
    description: "C++ project with CMake build system",
    icon: "⚙️",
    group: "Systems",
    markers: ["CMakeLists.txt"],
    extensionMarkers: [".cpp", ".cxx", ".cc", ".hpp"],
    installCommands: ["cmake -B build -DCMAKE_BUILD_TYPE=Debug", "cmake --build build"],
    startCommand: "./build/app",
    buildCommand: "cmake --build build --config Release",
    testCommand: "cd build && ctest --output-on-failure",
    lintCommand: "clang-tidy src/**/*.cpp",
    debugCommand: "gdb ./build/app",
    worktreeSetupCommands: ["cmake -B build -DCMAKE_BUILD_TYPE=Debug"],
    sharedPaths: [],
    priority: 15,
  },
  {
    id: "cpp-make",
    label: "C++ / Make",
    description: "C++ project with Makefile build system",
    icon: "⚙️",
    group: "Systems",
    markers: ["Makefile", "makefile", "GNUmakefile"],
    extensionMarkers: [".cpp", ".cxx", ".cc"],
    installCommands: [],
    startCommand: "./app",
    buildCommand: "make",
    testCommand: "make test",
    lintCommand: "clang-tidy *.cpp",
    debugCommand: "gdb ./app",
    worktreeSetupCommands: [],
    sharedPaths: [],
    priority: 8,
  },
  {
    id: "c-make",
    label: "C / Make",
    description: "C project with Makefile build system",
    icon: "🔧",
    group: "Systems",
    markers: ["Makefile", "makefile", "GNUmakefile"],
    extensionMarkers: [".c", ".h"],
    installCommands: [],
    startCommand: "./app",
    buildCommand: "make",
    testCommand: "make test",
    lintCommand: "clang-format --dry-run --Werror *.c",
    debugCommand: "gdb ./app",
    worktreeSetupCommands: [],
    sharedPaths: [],
    priority: 8,
  },
  {
    id: "c-cmake",
    label: "C / CMake",
    description: "C project with CMake build system",
    icon: "🔧",
    group: "Systems",
    markers: ["CMakeLists.txt"],
    extensionMarkers: [".c", ".h"],
    installCommands: ["cmake -B build -DCMAKE_BUILD_TYPE=Debug", "cmake --build build"],
    startCommand: "./build/app",
    buildCommand: "cmake --build build --config Release",
    testCommand: "cd build && ctest --output-on-failure",
    lintCommand: "clang-format --dry-run --Werror src/*.c",
    debugCommand: "gdb ./build/app",
    worktreeSetupCommands: ["cmake -B build -DCMAKE_BUILD_TYPE=Debug"],
    sharedPaths: [],
    priority: 12,
  },

  // ── Swift ─────────────────────────────────────────────────────────────────

  {
    id: "swift",
    label: "Swift / SPM",
    description: "Swift project using Swift Package Manager",
    icon: "🍎",
    group: "Apple",
    markers: ["Package.swift"],
    extensionMarkers: [".swift"],
    installCommands: ["swift package resolve"],
    startCommand: "swift run",
    buildCommand: "swift build -c release",
    testCommand: "swift test",
    lintCommand: "swiftlint lint",
    debugCommand: "lldb .build/debug/app",
    worktreeSetupCommands: [],
    sharedPaths: [".build"],
    priority: 20,
  },

  // ── Dart / Flutter ───────────────────────────────────────────────────────

  {
    id: "dart-flutter",
    label: "Flutter / Dart",
    description: "Flutter mobile/web application",
    icon: "💙",
    group: "Mobile",
    markers: ["pubspec.yaml"],
    installCommands: ["flutter pub get"],
    startCommand: "flutter run",
    buildCommand: "flutter build apk",
    testCommand: "flutter test",
    lintCommand: "flutter analyze",
    debugCommand: "flutter run --debug",
    worktreeSetupCommands: [],
    sharedPaths: [".pub-cache"],
    priority: 15,
  },
  {
    id: "dart",
    label: "Dart",
    description: "Pure Dart project (not Flutter)",
    icon: "🎯",
    group: "Mobile",
    markers: ["pubspec.yaml"],
    extensionMarkers: [".dart"],
    installCommands: ["dart pub get"],
    startCommand: "dart run",
    buildCommand: "dart compile exe bin/main.dart",
    testCommand: "dart test",
    lintCommand: "dart analyze",
    debugCommand: "dart --enable-vm-service run",
    worktreeSetupCommands: [],
    sharedPaths: [".pub-cache"],
    priority: 10,
  },

  // ── Elixir ────────────────────────────────────────────────────────────────

  {
    id: "elixir",
    label: "Elixir / Mix",
    description: "Elixir project managed with Mix",
    icon: "💜",
    group: "Functional",
    markers: ["mix.exs"],
    extensionMarkers: [".ex", ".exs"],
    installCommands: ["mix deps.get", "mix compile"],
    startCommand: "mix phx.server",
    buildCommand: "mix compile",
    testCommand: "mix test",
    lintCommand: "mix credo --strict",
    debugCommand: "iex -S mix",
    worktreeSetupCommands: ["mix deps.get"],
    sharedPaths: ["deps", "_build"],
    priority: 15,
  },

  // ── Ruby ─────────────────────────────────────────────────────────────────

  {
    id: "ruby-rails",
    label: "Ruby on Rails",
    description: "Ruby on Rails web application",
    icon: "💎",
    group: "Ruby",
    markers: ["Gemfile"],
    strictMarkers: ["Gemfile", "config/routes.rb"],
    installCommands: ["bundle install"],
    startCommand: "bin/rails server",
    buildCommand: "bundle exec rake assets:precompile",
    testCommand: "bundle exec rspec",
    lintCommand: "bundle exec rubocop",
    debugCommand: "bin/rails server",
    worktreeSetupCommands: ["bundle exec rails db:migrate"],
    sharedPaths: ["vendor/bundle"],
    priority: 20,
  },
  {
    id: "ruby",
    label: "Ruby / Bundler",
    description: "Ruby project with Bundler",
    icon: "💎",
    group: "Ruby",
    markers: ["Gemfile"],
    extensionMarkers: [".rb"],
    installCommands: ["bundle install"],
    startCommand: "ruby app.rb",
    buildCommand: "bundle exec rake build",
    testCommand: "bundle exec rspec",
    lintCommand: "bundle exec rubocop",
    debugCommand: "ruby -rdebug app.rb",
    worktreeSetupCommands: [],
    sharedPaths: ["vendor/bundle"],
    priority: 5,
  },

  // ── PHP ───────────────────────────────────────────────────────────────────

  {
    id: "php-laravel",
    label: "PHP / Laravel",
    description: "Laravel web application",
    icon: "🔴",
    group: "PHP",
    markers: ["artisan"],
    strictMarkers: ["artisan", "composer.json"],
    installCommands: ["composer install", "php artisan key:generate"],
    startCommand: "php artisan serve",
    buildCommand: "npm run build",
    testCommand: "php artisan test",
    lintCommand: "vendor/bin/phpcs",
    debugCommand: "php artisan serve",
    worktreeSetupCommands: ["php artisan migrate --seed"],
    sharedPaths: ["vendor"],
    priority: 25,
  },
  {
    id: "php-composer",
    label: "PHP / Composer",
    description: "PHP project with Composer",
    icon: "🐘",
    group: "PHP",
    markers: ["composer.json"],
    extensionMarkers: [".php"],
    installCommands: ["composer install"],
    startCommand: "php -S localhost:8000 -t public",
    buildCommand: "composer install --no-dev --optimize-autoloader",
    testCommand: "vendor/bin/phpunit",
    lintCommand: "vendor/bin/phpcs",
    debugCommand: "php -dzend_extension=xdebug.so -S localhost:8000",
    worktreeSetupCommands: [],
    sharedPaths: ["vendor"],
    priority: 8,
  },

  // ── Zig ───────────────────────────────────────────────────────────────────

  {
    id: "zig",
    label: "Zig",
    description: "Zig systems programming project",
    icon: "⚡",
    group: "Systems",
    markers: ["build.zig", "build.zig.zon"],
    extensionMarkers: [".zig"],
    installCommands: [],
    startCommand: "zig build run",
    buildCommand: "zig build -Doptimize=ReleaseFast",
    testCommand: "zig build test",
    lintCommand: "zig fmt --check src/",
    debugCommand: "zig build run",
    worktreeSetupCommands: [],
    sharedPaths: ["zig-cache", "zig-out"],
    priority: 15,
  },

  // ── Haskell ───────────────────────────────────────────────────────────────

  {
    id: "haskell-stack",
    label: "Haskell / Stack",
    description: "Haskell project with Stack build tool",
    icon: "λ",
    group: "Functional",
    markers: ["stack.yaml"],
    extensionMarkers: [".hs", ".lhs"],
    installCommands: ["stack setup", "stack build --only-dependencies"],
    startCommand: "stack run",
    buildCommand: "stack build",
    testCommand: "stack test",
    lintCommand: "hlint src",
    debugCommand: "stack ghci",
    worktreeSetupCommands: [],
    sharedPaths: [".stack-work"],
    priority: 15,
  },
  {
    id: "haskell-cabal",
    label: "Haskell / Cabal",
    description: "Haskell project with Cabal build tool",
    icon: "λ",
    group: "Functional",
    markers: ["cabal.project", "*.cabal"],
    extensionMarkers: [".hs"],
    installCommands: ["cabal update", "cabal install --only-dependencies"],
    startCommand: "cabal run",
    buildCommand: "cabal build",
    testCommand: "cabal test",
    lintCommand: "hlint src",
    debugCommand: "cabal repl",
    worktreeSetupCommands: [],
    sharedPaths: ["dist-newstyle"],
    priority: 10,
  },

  // ── R ─────────────────────────────────────────────────────────────────────

  {
    id: "r",
    label: "R",
    description: "R statistical computing project",
    icon: "📊",
    group: "Data Science",
    markers: ["DESCRIPTION", "renv.lock", ".Rprofile"],
    extensionMarkers: [".R", ".r", ".Rmd", ".qmd"],
    installCommands: ["Rscript -e 'renv::restore()'"],
    startCommand: "Rscript app.R",
    buildCommand: "R CMD INSTALL .",
    testCommand: "Rscript -e 'testthat::test_dir(\"tests\")'",
    lintCommand: "Rscript -e 'lintr::lint_dir(\".\")'",
    debugCommand: "Rscript -e 'source(\"app.R\")'",
    worktreeSetupCommands: [],
    sharedPaths: ["renv/library"],
    priority: 10,
  },

  // ── Lua ───────────────────────────────────────────────────────────────────

  {
    id: "lua",
    label: "Lua",
    description: "Lua scripting project",
    icon: "🌙",
    group: "Scripting",
    markers: ["*.rockspec", ".luacheckrc"],
    extensionMarkers: [".lua"],
    installCommands: ["luarocks install --only-deps *.rockspec"],
    startCommand: "lua main.lua",
    buildCommand: "luarocks make",
    testCommand: "busted",
    lintCommand: "luacheck .",
    debugCommand: "lua -d main.lua",
    worktreeSetupCommands: [],
    sharedPaths: [],
    priority: 8,
  },

  // ── Generic Makefile fallback ─────────────────────────────────────────────

  {
    id: "make",
    label: "Makefile",
    description: "Generic Makefile-based project",
    icon: "🔨",
    group: "Generic",
    markers: ["Makefile", "makefile", "GNUmakefile"],
    installCommands: [],
    startCommand: "make run",
    buildCommand: "make",
    testCommand: "make test",
    lintCommand: "make lint",
    debugCommand: "make debug",
    worktreeSetupCommands: [],
    sharedPaths: [],
    priority: 1,
  },
];

// Sort templates by priority descending (highest priority checked first)
const SORTED_TEMPLATES = [...ENV_TEMPLATES].sort((a, b) => (b.priority || 0) - (a.priority || 0));

// ── Detection Logic ───────────────────────────────────────────────────────────

/**
 * Scan the top level of a directory for file extensions (max 200 entries).
 * @param {string} rootDir
 * @returns {Set<string>} lowercase extensions including the dot, e.g. ".ts"
 */
function scanExtensions(rootDir) {
  const found = new Set();
  try {
    const entries = readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries.slice(0, 200)) {
      if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (ext) found.add(ext);
      }
    }
    // Also scan src/ if present (one level deeper)
    const srcDir = resolve(rootDir, "src");
    if (existsSync(srcDir)) {
      for (const entry of readdirSync(srcDir, { withFileTypes: true }).slice(0, 200)) {
        if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          if (ext) found.add(ext);
        }
      }
    }
  } catch { /* ignore unreadable dirs */ }
  return found;
}

/**
 * Check whether a glob-style marker matches anything in rootDir.
 * Supports simple `*` glob (basename only) and plain filenames.
 * @param {string} rootDir
 * @param {string} marker
 * @returns {boolean}
 */
function markerMatches(rootDir, marker) {
  if (marker.includes("*")) {
    const [prefix, suffix] = marker.split("*", 2);
    try {
      const entries = readdirSync(rootDir);
      return entries.some((f) => {
        const b = basename(f);
        return b.startsWith(prefix) && (suffix ? b.endsWith(suffix) : true);
      });
    } catch { return false; }
  }
  return existsSync(resolve(rootDir, marker));
}

/**
 * Detect the best-matching environment template for a given project directory.
 * Uses purely file-system checks — no LLMs, no network.
 *
 * @param {string} rootDir - Absolute path to the project root
 * @returns {{ template: EnvTemplate | null, confidence: "high"|"medium"|"low", allMatches: EnvTemplate[] }}
 */
export function detectEnvironmentTemplate(rootDir) {
  if (!rootDir || !existsSync(rootDir)) {
    return { template: null, confidence: "low", allMatches: [] };
  }

  const extensions = scanExtensions(rootDir);
  const matches = [];

  for (const tpl of SORTED_TEMPLATES) {
    // Strict markers: ALL must be present
    if (tpl.strictMarkers?.length) {
      const allPresent = tpl.strictMarkers.every((m) => markerMatches(rootDir, m));
      if (allPresent) {
        matches.push({ template: tpl, score: (tpl.priority || 0) + 50 });
        continue;
      }
    }

    // Regular markers: ANY one is enough
    const hasMarker = (tpl.markers || []).some((m) => markerMatches(rootDir, m));

    // Extension markers: ANY matching extension
    const hasExtension = (tpl.extensionMarkers || []).some(
      (ext) => extensions.has(ext.toLowerCase()),
    );

    if (hasMarker || hasExtension) {
      const score = (tpl.priority || 0) + (hasMarker ? 10 : 0) + (hasExtension ? 5 : 0);
      matches.push({ template: tpl, score });
    }
  }

  // Sort by score descending
  matches.sort((a, b) => b.score - a.score);

  const best = matches[0]?.template || null;
  const confidence = matches[0]
    ? matches[0].score >= 40 ? "high"
      : matches[0].score >= 15 ? "medium"
        : "low"
    : "low";

  return {
    template: best,
    confidence,
    allMatches: matches.map((m) => m.template),
  };
}

/**
 * Get all templates grouped by their `group` field.
 * @returns {Record<string, EnvTemplate[]>}
 */
export function getTemplatesByGroup() {
  const groups = {};
  for (const tpl of ENV_TEMPLATES) {
    if (!groups[tpl.group]) groups[tpl.group] = [];
    groups[tpl.group].push(tpl);
  }
  return groups;
}

/**
 * Get a template by ID.
 * @param {string} id
 * @returns {EnvTemplate | null}
 */
export function getTemplateById(id) {
  return ENV_TEMPLATES.find((t) => t.id === id) || null;
}

/**
 * Serialize a detected/configured environment to the per-repo `environment`
 * config shape stored in bosun.config.json.
 *
 * @param {EnvTemplate} tpl
 * @returns {object}
 */
export function templateToRepoEnvironment(tpl) {
  return {
    template: tpl.id,
    installCommands: [...tpl.installCommands],
    startCommand: tpl.startCommand,
    buildCommand: tpl.buildCommand,
    testCommand: tpl.testCommand,
    lintCommand: tpl.lintCommand,
    debugCommand: tpl.debugCommand,
    worktreeSetupScript: tpl.worktreeSetupCommands.join(" && "),
    sharedPaths: [...tpl.sharedPaths],
  };
}
