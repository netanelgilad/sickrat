#!/usr/bin/env bash
set -euo pipefail
set +x

usage() {
	cat <<'EOF'
Usage:
  renew-cloudflare-deploy-token.sh [--repo OWNER/REPO] [--connection NAME]
                                    [--run-id ID] [--approval-timeout DURATION]
                                    [--dry-run]

Requests a short-lived Cloudflare OAuth grant through Sickrat, writes it to the
GitHub repository secret CLOUDFLARE_API_TOKEN, and optionally reruns failed jobs.
EOF
}

die() {
	printf 'Error: %s\n' "$*" >&2
	exit 1
}

repo=""
connection=""
run_id=""
approval_timeout="10m"
dry_run=false
install_grant=false

while (($# > 0)); do
	case "$1" in
		--repo)
			(($# >= 2)) || die "--repo requires OWNER/REPO"
			repo="$2"
			shift 2
			;;
		--connection)
			(($# >= 2)) || die "--connection requires a Sickrat connection name"
			connection="$2"
			shift 2
			;;
		--run-id)
			(($# >= 2)) || die "--run-id requires a numeric GitHub Actions run ID"
			run_id="$2"
			shift 2
			;;
		--approval-timeout)
			(($# >= 2)) || die "--approval-timeout requires a duration"
			approval_timeout="$2"
			shift 2
			;;
		--dry-run)
			dry_run=true
			shift
			;;
		--install-grant)
			install_grant=true
			shift
			;;
		-h|--help)
			usage
			exit 0
			;;
		*) die "unknown argument: $1" ;;
	esac
done

command -v gh >/dev/null 2>&1 || die "GitHub CLI (gh) is required"

if [[ -z "$repo" ]]; then
	repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
fi
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "invalid GitHub repository: $repo"
[[ -z "$run_id" || "$run_id" =~ ^[0-9]+$ ]] || die "--run-id must be numeric"

if [[ "$install_grant" == true ]]; then
	[[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] || die "Sickrat did not inject CLOUDFLARE_API_TOKEN"
	trap 'unset CLOUDFLARE_API_TOKEN' EXIT
	printf '%s' "$CLOUDFLARE_API_TOKEN" | gh secret set CLOUDFLARE_API_TOKEN --repo "$repo"
	unset CLOUDFLARE_API_TOKEN
	printf 'Updated GitHub secret CLOUDFLARE_API_TOKEN for %s.\n' "$repo"
	if [[ -n "$run_id" ]]; then
		gh run rerun "$run_id" --failed --repo "$repo"
		printf 'Requested rerun of failed jobs in GitHub Actions run %s.\n' "$run_id"
	fi
	exit 0
fi

command -v sickrat >/dev/null 2>&1 || die "Sickrat CLI is required"
gh auth status >/dev/null

if [[ -n "$connection" ]]; then
	[[ "$connection" =~ ^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$ ]] || die "invalid Sickrat connection name: $connection"
	cloudflare_ref="sickrat://oauth/cloudflare/${connection}?scope=account-settings.read&scope=workers-scripts.write&scope=workers-routes.write"
else
	cloudflare_ref="sickrat://oauth/cloudflare?scope=account-settings.read&scope=workers-scripts.write&scope=workers-routes.write"
fi

script_path="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
child_args=(--install-grant --repo "$repo")
if [[ -n "$run_id" ]]; then
	child_args+=(--run-id "$run_id")
fi

printf 'Repository: %s\n' "$repo"
printf 'GitHub secret: CLOUDFLARE_API_TOKEN\n'
printf 'Cloudflare scopes: account-settings.read, workers-scripts.write, workers-routes.write\n'
if [[ -n "$run_id" ]]; then
	printf 'Failed run to rerun: %s\n' "$run_id"
else
	printf 'Failed run to rerun: none\n'
fi

if [[ "$dry_run" == true ]]; then
	printf 'Dry run only; no Sickrat grant was requested and no GitHub state changed.\n'
	exit 0
fi

if ! sickrat run \
	--env "CLOUDFLARE_API_TOKEN=${cloudflare_ref}" \
	--approval-timeout "$approval_timeout" \
	--message "Renew the short-lived Cloudflare deploy credential for GitHub repository ${repo}" \
	-- "$script_path" "${child_args[@]}"; then
	cat >&2 <<'EOF'
Cloudflare grant failed. First confirm that /api/oauth/providers advertises both
workers-scripts.write and workers-routes.write. If it does, check this configuration:
  1. Cloudflare dashboard > Manage Account > OAuth clients.
  2. Edit the OAuth client ID configured in Sickrat Connections > Cloudflare.
  3. Preserve existing scopes and add Account Settings Read, Workers Scripts
     Edit, and Workers Routes Edit, then save and reconnect Cloudflare in Sickrat.
See .agents/skills/renew-cloudflare-deploy-token/SKILL.md for the full settings.
EOF
	exit 1
fi
