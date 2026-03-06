---
name: ralphi-init
description: "Scans a project and sets up ralphi ralph loop configuration. Use when asked to initialize ralphi, set up ralph, configure a project for AI-driven development, or run ralphi ralph init."
---

# Ralphi Ralph Init

Agentically scan a project to detect its language, framework, commands, and conventions, then generate all configuration needed for the ralphi ralph loop.

## What Gets Created

| File | Purpose |
|------|---------|
| `.ralphi/config.yaml` | Ralph loop configuration (commands, rules, engine) |
| `AGENTS.md` (+ `CLAUDE.md` symlink for Claude) | Project conventions for the AI engine |
| `prek.toml` or `.git/hooks/pre-commit` | Pre-commit hook running `ralphi ralph check` |
| `.gitignore` updates | Ignore ralph working files |

## Workflow

Follow these steps in order. Be conversational — confirm findings with the user before writing files.

### Step 1: Scan the Project

Read these files to understand the project (skip any that don't exist):

**Project overview:**
- `README.md`, `README.rst`, `README.txt`, or similar

**Package manifests (detect language):**
- `package.json` → Node.js / TypeScript / JavaScript
- `Cargo.toml` → Rust
- `go.mod` → Go
- `pyproject.toml`, `setup.py`, `requirements.txt` → Python
- `Gemfile` → Ruby
- `pom.xml` → Java (Maven)
- `build.gradle`, `build.gradle.kts` → Java/Kotlin (Gradle)

**Build and quality configs:**
- `tsconfig.json`, `.eslintrc*`, `vitest.config.*`, `jest.config.*`
- `ruff.toml`, `mypy.ini`, `.flake8`
- `golangci.yml`, `.golangci.yml`
- `clippy.toml`, `rustfmt.toml`
- `.prettierrc*`, `.editorconfig`

**CI configuration:**
- `.github/workflows/` directory listing
- `.gitlab-ci.yml`

**Existing agent guidance:**
- `AGENTS.md`
- `CLAUDE.md`, `claude.md`
- `.cursorrules`, `.windsurfrules`

**Directory structure:**
- Top-level directory listing
- `src/` listing (if it exists)

If no package manifest is found, ask the user: "I couldn't detect a package manifest. What language and framework is this project using?"

### Step 2: Determine Quality Commands

Based on the package manifest, detect the commands for test, lint, build, and typecheck.

#### Node.js / TypeScript / JavaScript

Read `package.json` and examine the `scripts` section:

1. Look for a **composite command** first (e.g., `check:all`, `check`, `validate`, `ci`). Read what it actually runs — if it combines test + lint + build, prefer it.
2. For individual commands:
   - **test**: `test`, `test:unit`, `test:all`
   - **lint**: `lint`, `lint:fix`, `lint:check`
   - **build**: `build`, `compile`
   - **typecheck**: `typecheck`, `type-check`, `tsc`, or if none exists and TypeScript is present, use `npx tsc --noEmit`
3. Actually read the script values to understand what they do. A script named `test` that runs `echo "no tests"` is not a real test command.

#### Python

Read `pyproject.toml` for tool configurations:
- **test**: `pytest` (if pytest is in dependencies or `[tool.pytest]` exists)
- **lint**: `ruff check .` (if ruff configured), else `flake8 .`
- **typecheck**: `mypy .` (if mypy is in dependencies or `[tool.mypy]` exists)
- **format**: `black .` or `ruff format .`

#### Go

- **test**: `go test ./...`
- **lint**: `golangci-lint run` (if `.golangci.yml` exists)
- **build**: `go build ./...`

#### Rust

- **test**: `cargo test`
- **lint**: `cargo clippy`
- **build**: `cargo build`
- **format**: `cargo fmt --check`

#### Ruby

- **test**: `bundle exec rspec` or `bundle exec rails test`
- **lint**: `bundle exec rubocop`

#### Java/Kotlin

- Maven: `mvn test`, `mvn package`
- Gradle: `./gradlew test`, `./gradlew build`

#### Shell/Bash

- **lint**: `shellcheck <script-files>`

### Step 3: Determine Project Rules

Analyze the codebase to discover conventions:

1. **Testing framework**: What test runner is used? (vitest, jest, pytest, go test, cargo test, rspec)
2. **Code style**: Is there a formatter config? (prettier, black, rustfmt, gofmt)
3. **Framework patterns**: Are there patterns specific to the framework? (e.g., "use server actions not API routes" for Next.js App Router)
4. **Existing guidance**: Prefer `AGENTS.md` if present. If only `CLAUDE.md` exists, extract key rules from it and plan to alias files in Step 6.
5. **Import style**: ES modules vs CommonJS? Absolute vs relative imports?
6. **Type strictness**: Is `strict: true` in tsconfig? Is mypy in strict mode?

Compile 3-8 concise rules. Each rule should be a single actionable sentence.

### Step 4: Present Findings and Confirm

Use the `ralphi_ask_user_question` tool to gather confirmation and preferences interactively. For example:

```json
{
  "questions": [
    {
      "id": "engine",
      "prompt": "Which AI engine should be the default?",
      "type": "single",
      "options": ["amp", "claude", "opencode", "pi"]
    },
    {
      "id": "extra_rules",
      "prompt": "Any additional project conventions to enforce?",
      "type": "multi",
      "options": ["Strict TypeScript", "No default exports", "Prefer named imports"],
      "allowOther": true
    }
  ]
}
```

Also show the user what was detected in a clear format:

```
## Detected Configuration

**Project:** my-project
**Language:** TypeScript
**Framework:** Next.js

### Commands
  ✓ test:      npm run test
  ✓ lint:      npm run lint
  ✓ build:     npm run build
  ✓ typecheck: npm run type-check

### Proposed Rules
  1. Use vitest for testing
  2. Follow existing patterns in src/
  3. Use strict TypeScript (strict: true)
```

Ask the user to confirm or edit commands and rules before proceeding.

### Step 5: Generate `.ralphi/config.yaml`

Create the config file with this structure:

```yaml
# ralphi ralph configuration
# Auto-generated — edit as needed

project:
  name: "project-name"
  language: "TypeScript"
  framework: "Next.js"

commands:
  test: "npm run test"
  lint: "npm run lint"
  build: "npm run build"
  typecheck: "npm run type-check"

rules:
  - "use vitest for testing"
  - "follow existing patterns"

boundaries:
  never_touch:
    - "*.lock"
    - ".env*"

engine: "amp"
max_retries: 3
```

Notes:
- `project.name` should be the directory name (kebab-case)
- Only include `framework` if one was detected
- Only include commands that were confirmed — comment out or omit undetected ones
- `engine` is what the user chose
- `boundaries.never_touch` always includes `*.lock` and `.env*`

### Step 6: Generate `AGENTS.md` (canonical) and Claude alias if needed

Use `AGENTS.md` as the canonical guidance file for **all** engines (amp, claude, opencode, pi).

**Before writing:** Check if `AGENTS.md` already exists. If it does, show the user the existing content and ask whether to overwrite, merge, or skip.

If the selected engine is **claude**, ensure `CLAUDE.md` is available as an alias:
- If `AGENTS.md` exists and `CLAUDE.md` is missing, create symlink: `ln -s AGENTS.md CLAUDE.md`
- If `CLAUDE.md` exists and `AGENTS.md` is missing, create symlink: `ln -s CLAUDE.md AGENTS.md`
- If both exist as regular files with different content, ask the user which one should be canonical, then keep one canonical file and make the other a symlink.

Always write/merge content into `AGENTS.md`; `CLAUDE.md` should only be a compatibility alias when needed.

The file should contain:

1. **Project overview** (1-2 sentences): What the project is and what it does
2. **Quick start commands**: How to install, build, test, lint, typecheck
3. **Quality check instructions**: Emphasize running checks after every change
4. **Key conventions**: The rules discovered in Step 3
5. **Directory structure**: Brief guide to the top-level layout
6. **Testing patterns**: Framework, where tests live, how to write them

Keep it concise and practical. This file is read by AI agents, not humans — focus on actionable instructions, not prose.

Example structure:
```markdown
# Project Name

Brief description of what this project does.

## Commands

After ANY code change, run:
\`\`\`bash
npm run check:all
\`\`\`

Individual commands:
- `npm run test` — Run tests
- `npm run lint` — Lint code
- `npm run build` — Build (includes type checking)

## Conventions

- Use vitest for testing
- Follow existing patterns in src/
- ...

## Directory Structure

\`\`\`
project/
├── src/         # Source code
├── tests/       # Test files
└── ...
\`\`\`
```

### Step 7: Set Up Pre-commit Hook

The pre-commit hook should run `ralphi ralph check`, which executes the quality commands from the config.

**Option A — prek (preferred):**

Generate `prek.toml` at the project root:

```toml
[[repos]]
repo = "local"
hooks = [
  {
    id = "ralphi-check",
    name = "ralphi ralph check",
    language = "system",
    entry = "ralphi ralph check",
    always_run = true,
    pass_filenames = false,
  },
]
```

Then check if `prek` is available by running `command -v prek`. If available, run `prek install`.

**Option B — Direct git hook (fallback):**

If prek is not available, create `.git/hooks/pre-commit`:

```bash
#!/usr/bin/env bash
set -euo pipefail
ralphi ralph check
```

Make it executable with `chmod +x .git/hooks/pre-commit`.

**Important:** If `.git/hooks/pre-commit` already exists, ask the user before overwriting.

### Step 8: Update `.gitignore`

Append the following entries to `.gitignore` if they're not already present:

```
# ralphi ralph
.ralphi/*
!.ralphi/config.yaml
```

Read the existing `.gitignore` first and only add entries that are missing. Do not duplicate entries.

## Notes

- `ralphi ralph check` is the command that runs quality checks from the config. It is called by the pre-commit hook to ensure code quality before commits.
- Skills for direct engine access (amp, claude, opencode, pi) are installed in `.agents/skills/`.
- If the user wants to add more rules later, they can run `ralphi ralph add-rule "rule text"`.
- The config file is intentionally simple YAML — users should feel comfortable editing it by hand.

