#!/bin/sh
# Reads GitHub and Jira for the QA, with the tokens from ~/.ia/.env (the same file as work-on-pr,
# tempo-log and agents/jira/manager.md). Reads only: this skill never writes to either service.
#
#   api.sh github  <path> [json|diff]      GET https://api.github.com<path>; diff asks for the patch
#   api.sh graphql <query> [variables]     POST https://api.github.com/graphql, a read query only
#   api.sh jira    <path>                  GET https://prestashop-jira.atlassian.net/rest/api/3<path>
#   api.sh check                           says which of the two services are usable, and nothing else
#
# The body goes to stdout, any error to stderr with the HTTP status and the service's own message.
# Tokens never reach the command line of a child process: curl reads its headers from stdin.
set -eu

ENV_FILE=${QA_ENV_FILE:-$HOME/.ia/.env}
if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
fi

GH=https://api.github.com
JIRA=${JIRA_BASE_URL:-https://prestashop-jira.atlassian.net/rest/api/3}

fail() { echo "api.sh: $*" >&2; exit 1; }

need_github() {
  [ -n "${GITHUB_TOKEN:-}" ] || fail "GITHUB_TOKEN is not set (looked in $ENV_FILE)"
}

need_jira() {
  [ -n "${JIRA_EMAIL:-}" ] && [ -n "${JIRA_TOKEN:-}" ] \
    || fail "JIRA_EMAIL or JIRA_TOKEN is not set (looked in $ENV_FILE)"
}

explain() {
  case "$1" in
    401) echo "token rejected: missing, expired or revoked" ;;
    403) echo "forbidden: on the PrestaShop organisation, the token is probably not SSO-authorised" ;;
    404) echo "not found, or the token has no access to it (private repository, other Jira project)" ;;
    *)   echo "" ;;
  esac
}

# request <headers on stdin> <curl args...>: prints the body, or fails with status and message
request() {
  body=$(mktemp); trap 'rm -f "$body"' EXIT
  code=$(curl -sS -L -o "$body" -w '%{http_code}' -H @- "$@") || fail "network error on $*"
  case "$code" in
    2??) cat "$body" ;;
    *)   msg=$(jq -r '.message // (.errorMessages // [] | join("; ")) // empty' "$body" 2>/dev/null || true)
         fail "HTTP $code${msg:+: $msg}. $(explain "$code")" ;;
  esac
}

gh_headers() {
  printf 'Authorization: Bearer %s\nX-GitHub-Api-Version: 2022-11-28\nAccept: %s\n' \
    "$GITHUB_TOKEN" "$1"
}

cmd=${1:-}; [ $# -gt 0 ] && shift
case "$cmd" in
  github)
    need_github
    path=${1:?usage: api.sh github <path> [json|diff]}
    case "${2:-json}" in
      diff) accept=application/vnd.github.diff ;;
      *)    accept=application/vnd.github+json ;;
    esac
    gh_headers "$accept" | request "$GH$path"
    ;;
  graphql)
    need_github
    query=${1:?usage: api.sh graphql <query> [variables-json]}
    case "$query" in *mutation*) fail "refusing a mutation: this skill only reads" ;; esac
    vars=${2:-}; [ -n "$vars" ] || vars='{}'
    payload=$(jq -n --arg q "$query" --argjson v "$vars" '{query: $q, variables: $v}')
    gh_headers application/json | request -X POST -H 'Content-Type: application/json' \
      --data "$payload" "$GH/graphql"
    ;;
  jira)
    need_jira
    path=${1:?usage: api.sh jira <path>}
    auth=$(printf '%s:%s' "$JIRA_EMAIL" "$JIRA_TOKEN" | base64 | tr -d '\n')
    printf 'Authorization: Basic %s\nAccept: application/json\n' "$auth" | request "$JIRA$path"
    ;;
  check)
    if [ -n "${GITHUB_TOKEN:-}" ]; then echo "github: token set"; else echo "github: GITHUB_TOKEN missing"; fi
    if [ -n "${JIRA_EMAIL:-}" ] && [ -n "${JIRA_TOKEN:-}" ]; then echo "jira: credentials set"
    else echo "jira: JIRA_EMAIL or JIRA_TOKEN missing, the ticket will not be read"; fi
    ;;
  *)
    fail "usage: api.sh github|graphql|jira|check ..."
    ;;
esac
