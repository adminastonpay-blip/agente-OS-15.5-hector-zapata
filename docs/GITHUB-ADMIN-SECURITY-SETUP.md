# GitHub Administrative Security Controls — ASTON OS

This private repository has code-based secret/dependency scans, but GitHub-native security settings and branch rules must be confirmed in repository Settings.

## Security and analysis
Settings → Security & analysis:
- Enable dependency graph if available.
- Enable Dependabot alerts and Dependabot security updates.
- Secret scanning and push protection for this personal-account private repository depend on GitHub plan/entitlement; confirm availability rather than assuming.
- CodeQL/code scanning for private repositories depends on Code Security entitlement. The private Worker still runs Gitleaks and npm audit in Actions.
- Review findings and rotate actual credentials. Do not treat a clean scan as proof that history has never contained secrets.

## Rulesets for main
Create a ruleset targeting `main`:
- Require pull requests and block direct pushes.
- Require approval by a reviewer other than the author.
- Require CODEOWNERS review for `wrangler*.toml`, `src/safety/`, `src/audit/`, `src/do/`, and schema/migration files.
- Dismiss stale approvals after new commits and require conversations resolved.
- Require stable checks: Cloudflare CI, ASTON OS Audit Staging Validation, Gitleaks, and Dependency Vulnerability Audit.
- Block force pushes and deletion.
- Restrict emergency bypass to named administrators; audit bypass events.

## Actions and access
Settings → Actions:
- Default `GITHUB_TOKEN` permissions: read-only.
- Require approval for outside collaborator workflows.
- Restrict actions to GitHub-owned and verified creators or an explicit allowlist.
- Pin third-party actions to full commit SHAs.
- Use protected environments with required approval for staging/production deployment. Keep production deploy secrets inaccessible to pull-request workflows.

## Identity and operations
- Enforce MFA/passkeys.
- Remove stale collaborators and broad tokens.
- Prefer fine-grained short-lived tokens.
- Keep production Cloudflare secrets separate from staging.
- Require backup, rollback, incident response, and owner approval before production changes.

Record the actual state and any plan limitations. A documented checklist is not evidence that a setting has been enabled.
