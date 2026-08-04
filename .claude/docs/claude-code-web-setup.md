# Claude Code Web Setup for Log Access

This guide explains how to configure Claude Code Web to query your log
aggregation system for both staging and production. Replace the placeholders
below with your project's concrete services, hosts, and credential store.

## Prerequisites

- Credentials with read access to your log store / secret manager (ideally one
  scoped identity per environment)
- Log-store credentials kept in a secret manager (never committed to the repo)
- A Claude Code Web account with environment configuration access

## Environment Setup

Create a Claude Code Web environment with the variables your setup script needs.
Use separate credentials per environment so staging can't reach production:

| Variable | Value |
|----------|-------|
| `STAGING_ACCESS_KEY_ID` | `<staging identity key>` |
| `STAGING_SECRET_ACCESS_KEY` | `<staging identity secret>` |
| `PROD_ACCESS_KEY_ID` | `<production identity key>` |
| `PROD_SECRET_ACCESS_KEY` | `<production identity secret>` |
| `DEFAULT_REGION` | `<region>` |

The setup script pulls the per-environment secrets using the respective credentials.

## Network Access

Allow the domains your tools need in Claude Code Web settings:
- `<your log-store host>` (log queries)
- `<your secret-manager endpoint>` (fetching secrets)

## Secret Structure

Store one secret entry per environment, containing the final variable names your
tooling expects. For example:

**Staging secret** (accessed with `STAGING_*` creds):
```json
{
  "LOG_HOST_STAGING": "https://logs-staging.example.com",
  "LOG_USER": "readonly",
  "LOG_PASSWORD_STAGING": "..."
}
```

**Production secret** (accessed with `PROD_*` creds):
```json
{
  "LOG_HOST_PROD": "https://logs-prod.example.com",
  "LOG_USER": "readonly",
  "LOG_PASSWORD_PROD": "..."
}
```

The setup script exports these into the environment as-is.

## Managing Secrets

```bash
# List secrets for an environment
<secret-manager> list <staging-entry>

# Update a secret value
<secret-manager> set <staging-entry> LOG_HOST_STAGING "https://logs-staging.example.com"
```

## Testing Locally

```bash
# Set both credential sets
export STAGING_ACCESS_KEY_ID=<staging-key>
export STAGING_SECRET_ACCESS_KEY=<staging-secret>
export PROD_ACCESS_KEY_ID=<prod-key>
export PROD_SECRET_ACCESS_KEY=<prod-secret>
export DEFAULT_REGION=<region>

# Run the setup script
source .claude/scripts/setup-log-tools.sh

# Test queries for both environments
query-logs staging 60
query-logs prod 30 "TypeError"
```

## Troubleshooting

### Common Issues

**Tools return no output or "(No content)"**
This usually means environment variables weren't loaded. Try sourcing the env
file and running in the same command:
```bash
source <env-file> && query-logs prod 30

# Or use debug mode to see what's happening
query-logs prod 30 --debug
```

**"Error: LOG_HOST_PROD is not set"**
The environment variables weren't loaded. This happens when:
1. The setup script didn't run at session start
2. Env vars don't persist between bash invocations

**Fix**: Run the command with sourcing:
```bash
source <env-file> && query-logs prod 30
```

**"Warning: credentials for staging/prod not configured"**
- Verify the prefixed credentials are set: `echo $STAGING_ACCESS_KEY_ID`

**"Warning: Could not load staging/prod secrets"**
- Test secret-manager access directly with the correct credentials for that environment.

### Debug Mode

All tools support a `--debug` flag to show configuration:
```bash
query-logs prod 30 --debug
```

This displays:
- Environment name and index
- Log host URL (or if not set)
- User and password status
- Query being executed

### Manual Verification

Check whether the env file exists and has credentials (without printing secrets):
```bash
cat <env-file> | grep -v PASSWORD
```

Test log-store connectivity directly:
```bash
source <env-file>
curl -s "${LOG_HOST_PROD}/_cluster/health" -u "${LOG_USER}:${LOG_PASSWORD_PROD}"
```
