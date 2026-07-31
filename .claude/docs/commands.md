# Essential Commands

> Adapt the commands below to your stack. Replace the placeholder commands with
> the concrete ones your project uses (from your build tool, package manager,
> Makefile, or task runner).

## Database Migrations

```bash
# Preview pending migrations without executing
<migration-tool> status

# Apply migrations
<migration-tool> up

# Roll back the most recent migration
<migration-tool> down
```

## Backend Development

```bash
# Start the API/dev server
<run dev server>            # e.g. make dev / npm run dev

# Run background workers (if the project has any)
<run worker>

# Run tests (use parallelism for speed where supported)
<run test suite>

# Code quality checks (run before committing)
<run formatter>             # Format code
<run linter>                # Lint (and auto-fix where supported)
<run type checker>          # Type checking
```

## Frontend Development

```bash
# Install dependencies
<install deps>              # e.g. npm install / yarn

# Start the development server
<run dev server>

# Regenerate API/client types (if using code generation)
<codegen command> --watch

# Run tests
<run test suite>

# Format code
<run formatter>

# Build for production
<run build>

# Deploy
<deploy command>
```

## Local Development (Docker)

```bash
# Start the full local stack
<start local stack>         # e.g. ./scripts/localdev.sh / docker compose up

# Tail local logs
<logs command>

# Show port mappings / running containers
<ports command>
<ps command>
```

## Infrastructure & Deployment

```bash
# Deploy to staging
<deploy command> staging

# Deploy to production
<deploy command> production

# Plan infrastructure changes (if using IaC)
<iac tool> plan

# Setup secrets for CI/CD
<secrets setup script>
```
